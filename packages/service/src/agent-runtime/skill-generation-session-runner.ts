/**
 * ISkillGenerationSessionRunner 的 agent-work 运行时实现。
 *
 * 把 SKILL.md 生成会话交给工作区常驻的 agent-work 运行时承载，
 * 使生成过程的事件（思考、工具调用、文件写入）进入 SessionEventBus 与 WorkBlockStore，
 * 前端据此实时展示 Agent 的工作内容（而非只看到一个转圈的状态弹窗）。
 *
 * 与改造前的区别：此前生成器自建 AgentService，事件游离于总线之外，前端无法订阅。
 */
import { SkillDocumentAgentError } from '../shared/errors/skill-document-errors'
import type { ISkillGenerationSessionRunner } from '../shared/ports/skill-generation-session'
import type { IAgentWorkRuntimeRegistry } from './index'

/** 生成会话运行器的构造选项：工作区与模型配置在构造时绑定。 */
export interface ISkillGenerationSessionRunnerOptions {
  /** 工作区根目录（平台 projectDirectory）。 */
  workspace: string
  /** 模型名称。 */
  model: string
  /** 模型 API 根地址。 */
  apiBaseUrl: string
  /** 模型 API 密钥。 */
  apiKey: string
}

/**
 * 创建基于 agent-work 运行时的生成会话运行器。
 *
 * @param registry - 工作通道运行时注册表（须与 /api/agent 路由共享同一实例，
 *   否则生成事件会发布到 A 总线而前端订阅 B 总线，表现为弹窗收不到工作内容）。
 * @param options - 工作区与模型配置。
 * @returns 生成会话运行器实例。
 * @throws 不在创建阶段抛出异常；运行时错误由 run 归一为 SkillDocumentAgentError。
 */
export function createSkillGenerationSessionRunner(
  registry: IAgentWorkRuntimeRegistry,
  options: ISkillGenerationSessionRunnerOptions,
): ISkillGenerationSessionRunner {
  return {
    async run(input, runOptions): Promise<{ errorMessage?: string }> {
      const runtime = registry.getRuntime({
        workspace: options.workspace,
        model: options.model,
        apiBaseUrl: options.apiBaseUrl,
        apiKey: options.apiKey,
      })

      // 取消时同时中止服务端轮次，并让本次等待立即结束：
      // 仅依赖 handle.result 在「运行未真正终止」时不会兑现（例如底层卡在
      // 模型请求或工具调用中），会导致取消后调用方一直挂起。
      let cancelReject: ((error: SkillDocumentAgentError) => void) | undefined
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancelReject = reject
      })
      const abort = (): void => {
        runtime.abort(input.sessionId)
        cancelReject?.(
          new SkillDocumentAgentError(
            'GENERATION_CANCELLED',
            'SKILL.md 生成已取消。',
          ),
        )
      }
      runOptions.signal.addEventListener('abort', abort, { once: true })

      try {
        const { handle } = runtime.sendMessage({
          sessionId: input.sessionId,
          message: input.prompt,
          kind: 'generation',
          title: input.title,
          plugins: { toolGuard: input.toolGuard },
        })
        // 取消时 cancelReject 先于 handle.result 兑现，故无需再判断信号状态。
        const result = await Promise.race([handle.result, cancelled])

        // 提取最终助手文本：生成器据此解析 Agent 按约定输出的断点 / 假设 / 警告。
        // 文本缺失不影响生成主流程——产物以 Agent 写入的文件为准。
        const finalText = extractFinalAssistantText(result?.messages)

        return {
          ...(result?.errorMessage
            ? { errorMessage: result.errorMessage }
            : {}),
          ...(finalText ? { finalText } : {}),
        }
      } catch (error) {
        // 运行中途被中止（模型请求失败等）但信号已置位：统一归一为取消。
        if (runOptions.signal.aborted) {
          throw new SkillDocumentAgentError(
            'GENERATION_CANCELLED',
            'SKILL.md 生成已取消。',
            error,
          )
        }
        if (error instanceof SkillDocumentAgentError) throw error
        throw new SkillDocumentAgentError(
          'LLM_INVALID_RESPONSE',
          'Agent 生成 SKILL.md 失败。',
          error,
        )
      } finally {
        runOptions.signal.removeEventListener('abort', abort)
        // 生成是单轮任务：本轮结束后释放会话，避免任务句柄与内存状态长期滞留。
        // 工作块已物化落盘，历史记录不受释放影响。
        await runtime.releaseSession(input.sessionId)
      }
    },
  }
}

/**
 * 从会话消息列表中提取最后一条助手消息的纯文本。
 *
 * 生成器用它解析 Agent 按约定输出的「断点 / 假设 / 警告」小节。
 * 只取最后一条助手消息：多轮工具调用后，最终结论总在最后一条。
 *
 * @param messages - 本轮结束时的会话消息列表；可能为空。
 * @returns 最后一条助手消息的文本；不存在时返回 undefined。
 * @throws 不抛出异常。
 */
function extractFinalAssistantText(
  messages: unknown[] | undefined,
): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined
  }

  // 逆序遍历：最后一条助手消息即最终结论，避免扫描整段历史。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      { role?: unknown; content?: unknown } | undefined

    if (!message || message.role !== 'assistant') {
      continue
    }

    const text = extractTextContent(message.content)
    if (text.trim()) {
      return text
    }
  }

  return undefined
}

/**
 * 把助手消息的 content 归一为纯文本。
 *
 * content 可能是字符串，也可能是 `{ type: 'text', text }` 组成的数组。
 *
 * @param content - 助手消息的原始 content 字段。
 * @returns 拼接后的文本；无法解析时返回空字符串。
 * @throws 不抛出异常。
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return ''
      }

      const candidate = part as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
        ? candidate.text
        : ''
    })
    .filter(Boolean)
    .join('\n')
}
