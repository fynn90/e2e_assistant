/**
 * Skill Chat 运行时：把 AgentService 的任务级多轮引擎桥接为 CLI / Web 的 SSE 聊天流。
 *
 * 每个 `/chat` 请求创建一个独立运行时（内建一个使用 SQLite 会话存储的 AgentService），
 * 用 skill 上下文（标题/描述/文件树/当前文件）增强系统提示词，把客户端传来的完整
 * 对话历史作为一轮任务消息运行，并把 Agent 主循环的事件流翻译为 TSkillChatEvent
 * （delta / tool / complete / error），供 Hono 路由以 SSE 形式逐条写出。
 *
 * 由于 Web 端每次请求携带完整历史（无状态模型），这里每个请求使用独立 sessionId，
 * 避免把历史重复拼接；运行结束后的完整消息与工具调用审计记录仍持久化到工作区的 SQLite。
 */

import { resolve } from 'node:path'
import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  ISkillDetail,
  ISkillChatMessage,
  ISkillChatUsage,
  TSkillChatEvent,
} from '@authine-e2e-agent/types'
import { AgentService } from '../service'
import { AgentFactory } from '../agents/factory'

/** 历史消息数量上限，超出丢弃最早消息并置 historyTruncated。 */
const MAX_HISTORY_MESSAGES = 100
/**
 * 单条历史消息最大字符数，超出截断。
 *
 * v12-pre：与引擎的快照上限（240_000）及 Web 端 CHAT_MAX_MESSAGE_CHARACTERS 对齐——
 * 页面核对阶段产生的快照会作为工具结果进入会话历史，单条上限过小会把它截断，
 * 使 Agent 实际可读的内容少于快照本身提供的。
 */
const MAX_MESSAGE_CHARACTERS = 240_000
/**
 * 历史总字符上限，超出丢弃最早消息。
 *
 * 保持为单条上限的 3 倍：若总上限低于单条上限，任何一条长消息都会让「丢最早消息」
 * 的裁剪策略失效（最后一条永远保留），总上限形同虚设。
 */
const MAX_HISTORY_CHARACTERS = 720_000
/** 当前文件注入模型的最大字符数，超出截断并置 currentFileTruncated。 */
const MAX_CURRENT_FILE_CHARACTERS = 40_000

/** 截断提示文案，写入 contextWarnings 供前端展示。 */
const TRUNCATION_WARNING = '对话历史过长，已截断最早的部分内容。'
const FILE_TRUNCATION_WARNING = '当前文件过长，已截断后注入模型上下文。'

/**
 * Skill Chat 运行时构造选项。
 *
 * workspace 为 Agent 工作目录；apiKey / apiBaseUrl / model 组成模型配置；
 * signal 用于把请求中止传播到 Agent 运行。
 *
 * v11（技术方案 §6.3）：`skillRoot` 把文件工具的工作目录从平台工作区**收紧为
 * 当前 Skill 目录**（A1 分级）。
 */
export interface ISkillChatRuntimeOptions {
  /** Agent 工作目录（平台 projectDirectory）。 */
  workspace: string
  /** 模型 API 密钥。 */
  apiKey: string
  /** 模型 API 根地址。 */
  apiBaseUrl: string
  /** 模型名称。 */
  model: string
  /** 请求中止信号。 */
  signal?: AbortSignal
  /**
   * 当前 Skill 目录绝对路径（可选）。
   * 提供时：Agent 的工作目录与其上所有文件工具绑定到该目录（A1）；
   * 缺省时维持旧行为（绑定 workspace）。
   */
  skillRoot?: string
  /**
   * bash 可执行文件绝对路径（可选，CLI 启动时探测注入）。
   * 缺省由 NodeExecutionEnv 按平台默认规则探测。
   */
  shellPath?: string
}

/** Skill Chat 单次运行（open）的输入。 */
export interface ISkillChatOpenOptions {
  /** 当前 Skill 详情（标题 / 描述 / 版本等）。 */
  skill: ISkillDetail
  /** Skill 文件树摘要文本。 */
  fileTreeSummary: string
  /** 当前正在编辑的文件（含版本号与内容）。 */
  currentFile?: { relativePath: string; version: string; content: string }
  /** 客户端携带的完整对话历史（最后一条应为 user）。 */
  messages: ISkillChatMessage[]
}

/** Skill Chat 准备就绪的流式结果，供路由先写 start 事件再逐条输出 events。 */
export interface ISkillChatPreparedStream {
  /** 服务端为本轮 Agent 运行分配的持久化会话 ID。 */
  sessionId: string
  /** 实际注入上下文后的当前文件定位信息。 */
  currentFile?: { relativePath: string; version: string }
  /** 上下文告警列表（截断等）。 */
  contextWarnings: string[]
  /** 是否因历史过长发生截断。 */
  historyTruncated: boolean
  /** 是否因文件过长发生截断。 */
  currentFileTruncated: boolean
  /** delta / complete / error 事件流（start 事件由路由自行写出）。 */
  events: AsyncIterable<TSkillChatEvent>
}

/** Skill Chat 运行时接口。 */
export interface ISkillChatRuntime {
  /** 用一次对话输入准备流式输出。 */
  open(options: ISkillChatOpenOptions): Promise<ISkillChatPreparedStream>
  /** 释放运行时（含内建 AgentService）。 */
  close(): Promise<void>
}

/**
 * 创建 Skill Chat 运行时。
 *
 * @param options - 工作区、模型配置与请求中止信号。
 * @returns 可运行一次对话的 Skill Chat 运行时。
 */
export function createSkillChatRuntime(
  options: ISkillChatRuntimeOptions,
): ISkillChatRuntime {
  return new SkillChatRuntime(options)
}

/**
 * Skill Chat 运行时实现。
 *
 * 内建一个使用 SQLite 会话存储的 AgentService；open 时创建独立 chat 任务，
 * 通过句柄的底层 loop 事件流翻译为 SSE 事件，并在请求结束后释放服务实例。
 */
class SkillChatRuntime implements ISkillChatRuntime {
  /** 内建 AgentService：一次请求一个，随运行时释放。 */
  private readonly agentService: AgentService
  /** 请求中止信号。 */
  private readonly signal?: AbortSignal
  /** 当前 Skill 目录（提供时作为 Agent 工作目录，A1 范围分级）。 */
  private readonly skillRoot: string
  /** 是否已释放。 */
  private closed = false

  /**
   * @param options - 工作区、模型配置、Skill 目录、执行宿主与请求中止信号。
   */
  constructor(options: ISkillChatRuntimeOptions) {
    this.signal = options.signal
    // v11 A1：Skill 开发页 Chat 的文件工具绑定当前 Skill 目录（而非平台工作区）。
    this.skillRoot = options.skillRoot ?? options.workspace
    // 每个请求独立 sessionId，但必须落盘工具审计与完整消息，故使用 AgentService 默认 SQLite；
    // 会话数据库仍落在平台工作区的 .e2e-agent/ 下——Skill 目录内不产生任何非产物文件（P10）。
    this.agentService = new AgentService(
      this.skillRoot,
      {
        name: options.model,
        url: options.apiBaseUrl,
        key: options.apiKey,
        thinkingLevel: 'off',
        supportsThinking: false,
      },
      {
        sessionDbPath: resolve(options.workspace, '.e2e-agent', 'sessions.db'),
        // bash 路径透传：CLI 启动时探测到的 bash.exe 绝对路径（可选）。
        ...(options.shellPath ? { shellPath: options.shellPath } : {}),
      },
    )
  }

  /**
   * 用一次对话输入准备流式输出。
   *
   * 组装系统提示词 → 规范化历史与当前文件 → 创建 chat 任务 → 订阅事件翻译为
   * TSkillChatEvent → 运行结束后发 complete / error 并关闭事件流。
   *
   * @param openOptions - skill 详情、文件树、当前文件与对话历史。
   * @returns 可被 SSE 路由逐条写出的准备流。
   * @throws {Error} 当对话历史为空或最后一条不是 user 消息时抛出。
   */
  async open(
    openOptions: ISkillChatOpenOptions,
  ): Promise<ISkillChatPreparedStream> {
    // 1. 历史与当前文件规范化（截断超长内容）。
    const { messages, historyTruncated, contextWarnings } = normalizeHistory(
      openOptions.messages,
    )
    const { currentFile, currentFileTruncated } = normalizeCurrentFile(
      openOptions.currentFile,
    )

    // 2. 组装系统提示词：基础 E2E 提示词 + skill 上下文。
    const baseConfig = AgentFactory('chat', this.agentService.workspace)
    const systemPrompt = composeSystemPrompt(
      baseConfig.systemPrompt,
      openOptions.skill,
      openOptions.fileTreeSummary,
      currentFile,
    )

    // 3. 创建 chat 任务并自动启动首轮（首轮内容即客户端完整历史）。
    const sessionId = uuidv7()
    const handle = this.agentService.chat(toAgentMessages(messages), {
      sessionId,
      systemPrompt,
    })

    // 4. 订阅底层 loop 事件，翻译为文本 delta 和安全工具调用事件。
    const channel = createEventChannel<TSkillChatEvent>()
    let lastStreamedText = ''
    const unsubscribe = handle.loop.subscribe((event: AgentEvent) => {
      if (event.type === 'message_update') {
        const message = event.message as { role?: string; content?: unknown }
        if (message.role !== 'assistant') return
        const full = extractText(message.content)
        if (full.length > lastStreamedText.length) {
          channel.push({
            type: 'delta',
            text: full.slice(lastStreamedText.length),
          })
          lastStreamedText = full
        }
        return
      }

      if (
        event.type === 'tool_execution_start' ||
        event.type === 'tool_execution_update' ||
        event.type === 'tool_execution_end'
      ) {
        // AgentLoop 已在广播前将记录写入审计存储，此处只读取安全投影，不触碰原始结果。
        const tool = handle.loop.getToolCallView(event.toolCallId)
        if (tool) {
          channel.push({
            type: 'tool',
            phase: toolEventPhase(event.type),
            tool,
          })
        }
      }
    })

    // 5. 请求中止 → 中止运行。
    const onAbort = () => handle.abort()
    if (this.signal) {
      if (this.signal.aborted) {
        handle.abort()
      } else {
        this.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    // 6. 运行结束 → complete / error → 关闭事件流。
    // 业务门面已自动启动首轮并同步写入 handle.result，这里兜底防未启动场景。
    const runPromise =
      handle.result ?? Promise.reject(new Error('Chat 任务未启动'))
    void runPromise.then(
      (result) => {
        if (this.signal?.aborted) {
          channel.close()
          return
        }
        const usage = extractUsage(result.messages)
        channel.push({ type: 'complete', usage })
        channel.close()
      },
      (error) => {
        if (this.signal?.aborted) {
          channel.close()
          return
        }
        channel.push({
          type: 'error',
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        })
        channel.close()
      },
    )

    return {
      sessionId,
      currentFile: currentFile
        ? {
            relativePath: currentFile.relativePath,
            version: currentFile.version,
          }
        : undefined,
      contextWarnings,
      historyTruncated,
      currentFileTruncated,
      events: withCleanup(channel, async () => {
        unsubscribe()
        this.signal?.removeEventListener('abort', onAbort)
        await this.close()
      }),
    }
  }

  /**
   * 释放运行时：释放内建 AgentService（释放全部任务与会话存储）。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.agentService.dispose()
  }
}

/**
 * 将底层工具事件类型转换为公共 SSE 阶段。
 *
 * @param type - pi-agent-core 工具事件类型。
 * @returns 对应的公共工具事件阶段。
 */
function toolEventPhase(
  type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end',
): 'start' | 'update' | 'end' {
  if (type === 'tool_execution_start') return 'start'
  return type === 'tool_execution_update' ? 'update' : 'end'
}

/**
 * 组装 chat 系统提示词：基础 E2E 提示词 + 当前 Skill 上下文 + 安全与执行约束（v11 6.5）。
 *
 * @param basePrompt - AgentFactory 生成的基础系统提示词。
 * @param skill - 当前 Skill 详情。
 * @param fileTreeSummary - Skill 文件树摘要文本。
 * @param currentFile - 规范化后的当前文件（可选）。
 * @returns 组合后的系统提示词。
 */
function composeSystemPrompt(
  basePrompt: string,
  skill: ISkillDetail,
  fileTreeSummary: string,
  currentFile:
    { relativePath: string; version: string; content: string } | undefined,
): string {
  const sections: string[] = [
    basePrompt,
    '## 当前 Skill 上下文',
    `- 标题：${skill.title}`,
    `- 描述：${skill.description}`,
    `- 版本：${skill.version}`,
    '',
    '### Skill 文件树',
    fileTreeSummary || '（空）',
    '',
    '### 安全与执行约束',
    '- 你只能浏览当前 Skill 目录及其子目录内的文件；目录之外的任何路径都会被拒绝。',
    '- **禁止读取 env.json**（含经 bash 等任何方式）：它保存敏感数据真实值，全场景禁读；敏感值由平台在命令层注入，你只需要用例数据中的 ${ENV:KEY} 引用。',
    '- bash 可用，但命中危险命令清单的命令会被拒绝执行；不要尝试规避清单。',
  ]
  if (currentFile) {
    sections.push(
      '',
      `### 当前文件（${currentFile.relativePath}@${currentFile.version}）`,
      currentFile.content || '（空）',
    )
  }
  return sections.join('\n')
}

/**
 * 规范化对话历史：限制数量与长度，超限丢弃最早消息并标记截断。
 *
 * @param messages - 客户端携带的对话历史。
 * @returns 规范化后的消息、是否截断与上下文告警。
 * @throws {Error} 当消息为空或最后一条不是 user 时抛出。
 */
function normalizeHistory(messages: ISkillChatMessage[]): {
  messages: ISkillChatMessage[]
  historyTruncated: boolean
  contextWarnings: string[]
} {
  if (messages.length === 0) {
    throw new Error('对话历史不能为空。')
  }
  if (messages[messages.length - 1].role !== 'user') {
    throw new Error('对话最后一条消息必须是用户消息。')
  }

  let truncated = false
  const warnings: string[] = []
  // 单条消息超长截断也视为历史被调整。
  let list = messages.map((message) => {
    const content = truncateText(message.content, MAX_MESSAGE_CHARACTERS)
    if (content.length < message.content.length) {
      truncated = true
    }
    return { ...message, content }
  })

  // 数量超限：保留最近 MAX_HISTORY_MESSAGES 条。
  if (list.length > MAX_HISTORY_MESSAGES) {
    list = list.slice(-MAX_HISTORY_MESSAGES)
    truncated = true
  }
  // 总字符超限：从最早开始丢弃，直到满足上限。
  let total = list.reduce((sum, m) => sum + m.content.length, 0)
  while (total > MAX_HISTORY_CHARACTERS && list.length > 1) {
    total -= list.shift()!.content.length
    truncated = true
  }

  if (truncated) {
    warnings.push(TRUNCATION_WARNING)
  }
  return {
    messages: list,
    historyTruncated: truncated,
    contextWarnings: warnings,
  }
}

/**
 * 规范化当前文件：超长内容截断并标记。
 *
 * @param currentFile - 客户端携带的当前文件。
 * @returns 规范化后的当前文件与是否截断。
 */
function normalizeCurrentFile(
  currentFile: ISkillChatOpenOptions['currentFile'],
): {
  currentFile: ISkillChatOpenOptions['currentFile'] | undefined
  currentFileTruncated: boolean
} {
  if (!currentFile) {
    return { currentFile: undefined, currentFileTruncated: false }
  }
  const content = truncateText(currentFile.content, MAX_CURRENT_FILE_CHARACTERS)
  return {
    currentFile: { ...currentFile, content },
    currentFileTruncated: content.length < currentFile.content.length,
  }
}

/**
 * 把客户端对话历史转换为 AgentMessage 列表。
 *
 * @param messages - 规范化后的对话历史。
 * @returns 可直接送入 AgentLoop 的消息数组。
 */
function toAgentMessages(messages: ISkillChatMessage[]): AgentMessage[] {
  // AgentMessage 是判别联合，这里按消息角色构造后整体断言，交由运行期承担一致性。
  return messages.map(
    (message) =>
      ({
        role: message.role,
        content: [{ type: 'text', text: message.content }],
        timestamp: Date.now(),
      }) as AgentMessage,
  )
}

/**
 * 从运行结果中提取最近一次 assistant 消息的模型用量。
 *
 * @param messages - 运行结束后的会话消息。
 * @returns token 用量（inputTokens / outputTokens）；无用量时返回 undefined。
 */
function extractUsage(messages: AgentMessage[]): ISkillChatUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const usage = (message as Partial<AgentMessage> & { usage?: unknown }).usage
    if (message.role === 'assistant' && usage && typeof usage === 'object') {
      const u = usage as { input?: number; output?: number }
      return { inputTokens: u.input, outputTokens: u.output }
    }
  }
  return undefined
}

/**
 * 从 AgentMessage 内容中提取纯文本。
 *
 * @param content - AgentMessage 的内容（字符串或内容块数组）。
 * @returns 拼接后的文本。
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          Boolean(block) &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block,
      )
      .map((block) => block.text)
      .join('')
  }
  return ''
}

/**
 * 按字符数截断文本（从开头保留）。
 *
 * @param text - 原始文本。
 * @param max - 最大字符数。
 * @returns 截断后的文本（不超过 max）。
 */
function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * 创建事件通道：push 写入、close 关闭、async 迭代消费。
 */
function createEventChannel<T>(): {
  push(value: T): void
  close(): void
  [Symbol.asyncIterator](): AsyncIterator<T>
} {
  const queue: T[] = []
  const waiters: (() => void)[] = []
  let closed = false

  const notify = (): void => {
    while (waiters.length > 0) {
      waiters.shift()?.()
    }
  }

  return {
    push(value: T): void {
      if (closed) return
      queue.push(value)
      notify()
    },
    close(): void {
      if (closed) return
      closed = true
      notify()
    },
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0
      for (;;) {
        if (index < queue.length) {
          yield queue[index++]
          continue
        }
        if (closed) return
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}

/**
 * 包装事件通道：消费者结束（含提前 return）时执行清理。
 *
 * @param channel - 底层事件通道。
 * @param cleanup - 结束清理函数（退订、移除中止监听、释放运行时）。
 * @returns 带清理逻辑的可迭代事件流。
 */
function withCleanup<T>(
  channel: {
    push(value: T): void
    close(): void
    [Symbol.asyncIterator](): AsyncIterator<T>
  },
  cleanup: () => Promise<void>,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      try {
        yield* channel
      } finally {
        await cleanup()
      }
    },
  }
}
