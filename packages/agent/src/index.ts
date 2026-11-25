/**
 * @fynn90-e2e_assistant/agent 对外暴露的接口，提供的接口可以给 CLI、Web 使用。
 *
 * 当前暴露资源加载器；后续 agent 服务等接口在此基础上逐步补充。
 */

// 引入全局类型声明（*.md?raw 导入），确保声明产物构建时也能解析 markdown 资源
/// <reference path="./env.d.ts" />

export { AgentService } from './service'
export type { IAgentServiceOptions } from './service'

// —— 静态资源加载器：宿主据此读取内置 prompt / skill 内容 ——
export { ResourceLoader, resourceLoader } from './resourceLoader'

// —— 浏览器会话注册表（v7）：CLI 编排层据此为生成会话授权浏览器工具 ——
export {
  browserSessionRegistry,
  createBrowserSessionRegistry,
  createBrowserSessionHost,
  type IBrowserSessionHost,
  type IBrowserSessionRegistry,
} from './tools'
// —— AskUserQuestion 发问能力：CLI 工作运行时据此为会话授权通用提问工具 ——
export {
  askUserRegistry,
  createAskUserRegistry,
  createAskUserQuestionTool,
  createSessionAskTools,
  askUserQuestionParameters,
  type AskUserQuestionDetails,
  type IAskUserAnswer,
  type IAskUserHost,
  type IAskUserQuestionItem,
  type IAskUserRegistry,
} from './tools'
// —— 浏览器交互与视觉核对工具（v12-pre）：点击 / 选择 / 等待 / 截图 ——
export {
  createBrowserClickTool,
  createBrowserSelectTool,
  createBrowserFillTool,
  createBrowserWaitForTool,
  createBrowserScreenshotTool,
  type BrowserClickDetails,
  type BrowserSelectDetails,
  type BrowserFillDetails,
  type BrowserWaitForDetails,
  type BrowserScreenshotDetails,
  type IScreenshotArchive,
} from './tools/browser'
// —— 视觉基线捕获（v12）：为新旧 DOM 截图对比产出基准图片 ——
export {
  createBrowserListFramesTool,
  type BrowserListFramesDetails,
} from './tools/browser'
export {
  createBrowserCaptureBaselineTool,
  captureBaselineLimits,
  type BrowserCaptureBaselineDetails,
  type IVisualBaselineArchive,
} from './tools/browser'
// —— 多步骤任务清单（v12-pre）：让用户看到 Agent 的步骤计划与进度 ——
export {
  createTodoWriteTool,
  isTodoTool,
  todoWriteLimits,
  type ITodoItem,
  type TodoWriteDetails,
  type TTodoItemStatus,
} from './tools/todo_write'
// —— 测试执行工具与危险命令清单（v11）：CLI 组合根注入宿主适配器 ——
export {
  createExecuteTestTool,
  type IExecuteTestIssue,
  type ITestRunnerHost,
  type TExecuteTestHostResult,
} from './tools/execute_test'
// —— 检索工具（v16，v17 扩筛选）：/agent 中受控定位工作区内的 e2e SKILL ——
export {
  createListSkillsTool,
  createReadSkillDocumentTool,
  type IReadinessHost,
  type ISkillCatalogHost,
  type ListSkillsDetails,
  type ReadSkillDocumentDetails,
  type TReadRunHistoryHostResult,
  type TReadSkillDocumentHostResult,
  type TReadTestCaseHostResult,
  type TSkillCatalogHostErrorKind,
  type TSkillListStatusFilter,
} from './tools/skill-catalog'
// —— 工作台读取工具（v17）：用例详情 / 执行历史 / 就绪体检（只回数据，不发卡） ——
export {
  createCheckReadinessTool,
  createReadRunHistoryTool,
  createReadTestCaseTool,
  type CheckReadinessDetails,
  type ReadRunHistoryDetails,
  type ReadTestCaseDetails,
} from './tools/workbench-read'
// —— 动作卡片工具（v16，v17 扩 repair-script）：Agent 请求平台发布可点击入口 ——
export {
  createProposeActionTool,
  type IWorkbenchActionHost,
  type ProposeActionDetails,
} from './tools/workbench-action'
// —— 视图渲染工具（v17）：协议传「选择」不传「数据」，宿主按参数自取 ——
export {
  createRenderViewTool,
  type IViewHost,
  type RenderViewDetails,
} from './tools/render-view'
// —— 提案工具（v17）：四类「用户确认后才生效」的动作共用一条通道 ——
export {
  createProposeCaseChangeTool,
  createProposeCaseDeletionTool,
  createProposeCaseRepairTool,
  createProposeEnvFillTool,
  createProposeReportCleanupTool,
  type IProposalHost,
  type ProposalToolDetails,
} from './tools/workbench-proposal'
// —— 连续执行工具（v17 R4）：会话内串行编排，非平台级批量 ——
export {
  createExecuteBatchTool,
  type ExecuteBatchDetails,
  type IBatchRunnerHost,
} from './tools/execute-batch'
// —— 能力清单（v17 H3）：一份常量两个出口（提示词 + 能力卡） ——
export {
  WORKBENCH_CAPABILITY_MANIFEST,
  renderCapabilityPromptSection,
  toCapabilityViewPayload,
} from './prompt/sections/workbench-capabilities'
// —— 工作台 Agent 与装配类型（v16）：/agent 会话按 operateType 分派 ——
export {
  createWorkbenchAgentConfig,
  type IWorkbenchAgentCapability,
} from './agents/workbench-agent'
export type { AgentOperateType, IWorkbenchAgentAssembly } from './agents/types'
export {
  getWorkbenchPromptSection,
  getWorkbenchThresholdSection,
} from './prompt/workbench-section'
export {
  BASH_DANGEROUS_PATTERNS,
  isDangerousBashCommand,
} from './guards/bash-guard'
export type { IWorkspaceExecutionToolsOptions } from './tools/workspace-execution-tools'
export type { IChatHandle, IChatOptions } from './service/chat'
export { createSkillChatRuntime } from './service/skill-chat'
export type {
  ISkillChatOpenOptions,
  ISkillChatPreparedStream,
  ISkillChatRuntime,
  ISkillChatRuntimeOptions,
} from './service/skill-chat'
export { createAgentModelRuntime } from './model'
export type { IAgentModelRuntime } from './model'
export type { IModelInfo } from './types'

// —— 多轮任务引擎 ——
export { AgentTaskRunner } from './task/task-runner'
export { AgentTaskHandle } from './task/task-handle'
export type { IAgentTaskHandleOptions } from './task/task-handle'
export type {
  IAgentConfigFactory,
  IAgentTaskHandle,
  IAgentTaskRunnerOptions,
  IAgentTaskState,
  ITaskStatus,
} from './task/types'
export {
  AgentLoop,
  createAgentLoop,
  type AgentLoopListener,
  type IAgentLoopOptions,
  type IAgentLoopResult,
} from './loop/agent-loop'
export {
  resolvePlugins,
  createAllowAllToolGuard,
  createNoopContextPolicy,
  createNoopObservability,
  createNoopRetryPolicy,
  createNoopSessionStore,
  createPassthroughEventAdapter,
  type IContextPolicy,
  type IEventAdapter,
  type IHarnessPlugins,
  type IHarnessRunContext,
  type IObservability,
  type IResolvedPlugins,
  type IRetryPolicy,
  type IRunEndInfo,
  type ISessionMeta,
  type ISessionQuery,
  type ISessionStatus,
  type ISessionStore,
  type ISessionSummary,
  type IToolGuard,
} from './harness'
// —— 客户端事件翻译层（工作过程可视化） ——
export {
  ClientEventTranslator,
  ClientEventBlockState,
  newBlockId,
  presentTool,
  isCommandTool,
  extractCommand,
  extractFileChange,
  type IClientEventTranslatorOptions,
  type IFileChangeInfo,
  type IToolPresentation,
} from './harness/client-events'
export {
  createMemorySessionStore,
  createSqliteSessionStore,
  type ISqliteSessionStoreOptions,
} from './session'
export {
  ToolTraceRecorder,
  toJsonSafeValue,
  toSafePreview,
  toToolCallView,
  type IToolCallQuery,
  type IToolCallRecord,
  type IToolTraceRecorderOptions,
  type TJsonSafeValue,
  type ToolCallStatus,
} from './tool-trace'
