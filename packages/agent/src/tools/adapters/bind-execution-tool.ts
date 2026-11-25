/**
 * pi-agent-core 内置执行工具适配器。
 *
 * pi-agent-core 的 bash、read、write、edit 工具属于 AgentHarnessTool：它们在执行时
 * 需要额外接收 ExecutionToolContext。当前项目的 Agent 配置使用普通 AgentTool，
 * 因此本模块负责在工具创建阶段绑定上下文，并屏蔽二者 execute 方法签名的差异。
 */

import type {
  AgentHarnessTool,
  AgentTool,
  ExecutionToolContext,
} from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'

/**
 * 将一个需要执行上下文的 pi-agent-core 内置工具适配为普通 Agent 工具。
 *
 * @param tool - 由 pi-agent-core 工具工厂创建的内置执行工具。
 * @param context - 当前 Agent 会话使用的文件系统和 Shell 执行上下文。
 * @returns 已绑定执行上下文、可直接配置到 AgentTool[] 的工具实例。
 * @throws {Error} 当底层工具的参数校验、文件系统访问、命令执行或取消操作失败时，
 * 会透传 pi-agent-core 抛出的异常。
 */
export function bindExecutionTool<TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  context: ExecutionToolContext,
): AgentTool<TParameters, TDetails> {
  const { execute: executeWithContext, ...toolDefinition } = tool

  return {
    ...toolDefinition,
    // 文件读写与命令执行可能相互依赖；未显式声明并发能力时按顺序执行以避免竞争。
    executionMode: tool.executionMode ?? 'sequential',
    /**
     * 执行已绑定上下文的内置工具。
     *
     * @param toolCallId - 本次模型工具调用的唯一标识。
     * @param parameters - 已通过工具参数 Schema 校验的调用参数。
     * @param signal - 用于中止当前工具调用的可选 AbortSignal。
     * @param onUpdate - 用于上报工具流式进度的可选回调。
     * @returns 工具执行结果，包含模型可见内容和可选的结构化详情。
     * @throws {Error} 当底层工具执行失败或操作被取消时，透传底层异常。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      // 普通 AgentTool 不会传入第五个参数；在此补齐内置工具必需的执行上下文。
      return executeWithContext(
        toolCallId,
        parameters,
        signal,
        onUpdate,
        context,
      )
    },
  }
}
