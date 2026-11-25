/**
 * SKILL.md 生成会话端口：把「启动一个受约束的 Agent 生成会话并等待本轮结束」抽象出来。
 *
 * 应用层只依赖本端口，不关心会话由谁承载；运行时层用 agent-work 运行时实现，
 * 测试可注入 fake。这样应用层既能获得工作事件流可见性（前端可看到 Agent 工作内容），
 * 又保持对具体 Agent 实现与运行时装配的隔离（依赖倒转原则）。
 *
 * 位置说明：本文件原本位于 application/e2e-test-case/ 之下。它是「跨层共享的契约」，
 * 与域错误同类：application（生成器）与 agent-runtime（实现方）都依赖它。
 * 留在 application/ 内会让 agent-runtime 反向依赖业务编排层（见 PRD v18 §4.4）。
 */
import type { IToolGuard } from '@charlie_deng/e2e-assistant-agent'

/**
 * 生成会话运行器：应用层启动生成任务的唯一入口。
 *
 * 实现方在构造时绑定工作区与模型配置（由工厂注入），
 * 因此本端口只承载「这一次生成」的业务参数。
 */
export interface ISkillGenerationSessionRunner {
  /**
   * 启动生成会话并等待本轮结束。
   *
   * 会话 ID 由调用方提供：路由需要在建立 SSE 流时先行下发，
   * 前端据此订阅工作事件流，不必等待生成完成。
   *
   * @param input.sessionId - 会话 ID（由调用方生成，便于 SSE start 事件先行下发）。
   * @param input.prompt - 生成 prompt。
   * @param input.title - 会话标题预览（避免长 prompt 截断后成为会话标题）。
   * @param input.toolGuard - 文件写入白名单守卫，限制本次生成可调用的工具。
   * @param options.signal - 取消信号；中止时运行器应终止本轮并抛出取消错误。
   * @returns 本轮的模型侧错误信息与最终助手文本；成功且无错误时 errorMessage 为 undefined。
   *   finalText 用于让生成器解析 Agent 按约定输出的断点 / 假设 / 警告说明。
   * @throws {SkillDocumentAgentError} 当会话被取消、启动失败或运行异常时抛出。
   */
  run (
    input: {
      sessionId: string
      prompt: string
      title: string
      toolGuard: IToolGuard
    },
    options: { signal: AbortSignal },
  ): Promise<{ errorMessage?: string; finalText?: string }>
}
