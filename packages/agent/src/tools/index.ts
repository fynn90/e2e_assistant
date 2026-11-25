/**
 * Agent 工具统一出口。
 *
 * 本模块复用 @earendil-works/pi-agent-core 公开提供的内置执行工具，并提供适配后的
 * 工作区工具工厂，使当前项目的普通 AgentTool[] 配置能够安全地传入必需的执行上下文。
 */

export {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashExecution,
  type BashPrepare,
  type BashToolDetails,
  type BashToolInput,
  type BashToolOptions,
  type EditToolDetails,
  type EditToolInput,
  type ExecutionToolContext,
  type ReadImageProcessor,
  type ReadImageProcessorResult,
  type ReadToolDetails,
  type ReadToolInput,
  type ReadToolOptions,
  type WriteToolInput,
} from '@earendil-works/pi-agent-core'

/**
 * Node.js 环境下 pi-agent-core 内置执行工具所需的文件系统与 Shell 执行环境。
 */
export { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'

export { bindExecutionTool } from './adapters/bind-execution-tool'
export { createLoadSkillTool } from './load_skill'
export {
  createTodoWriteTool,
  isTodoTool,
  todoWriteLimits,
  type ITodoItem,
  type TodoWriteDetails,
  type TTodoItemStatus,
} from './todo_write'
export {
  createWorkspaceExecutionTools,
  type IWorkspaceExecutionToolsOptions,
} from './workspace-execution-tools'
export { createExecuteTestTool } from './execute_test'
export type {
  IExecuteTestIssue,
  ITestRunnerHost,
  TExecuteTestHostResult,
} from './execute_test'
// —— v16 检索工具：受控定位工作区内的 e2e SKILL（PRD ID-3）——
export {
  createListSkillsTool,
  createReadSkillDocumentTool,
} from './skill-catalog'
export type {
  ISkillCatalogHost,
  ListSkillsDetails,
  ReadSkillDocumentDetails,
  TReadSkillDocumentHostResult,
  TSkillCatalogHostErrorKind,
} from './skill-catalog'
// —— v16 动作卡片工具：Agent 请求平台发布可点击入口（ID-6/ID-7）——
export { createProposeActionTool } from './workbench-action'
export type {
  IWorkbenchActionHost,
  ProposeActionDetails,
} from './workbench-action'

// —— AskUserQuestion 发问工具：依赖注入的发问宿主端口，不自行组装卡片 ——
export {
  createAskUserQuestionTool,
  createSessionAskTools,
  askUserQuestionParameters,
} from './ask-user-question'
export {
  askUserRegistry,
  createAskUserRegistry,
  type AskUserQuestionDetails,
  type IAskUserAnswer,
  type IAskUserHost,
  type IAskUserQuestionItem,
  type IAskUserRegistry,
} from './ask-user-question-registry'

// —— 页面元素核对工具（v7）：依赖注入的浏览器会话端口，不自行创建浏览器 ——
export {
  createBrowserSessionHost,
  createBrowserSessionRegistry,
  browserSessionRegistry,
  createBrowserNavigateTool,
  createBrowserListFramesTool,
  createBrowserSnapshotTool,
  createBrowserQueryTool,
  createBrowserClickTool,
  createBrowserSelectTool,
  createBrowserFillTool,
  createBrowserWaitForTool,
  createBrowserScreenshotTool,
  createBrowserCaptureBaselineTool,
  captureBaselineLimits,
  type IBrowserSessionHost,
  type IBrowserSessionRegistry,
  type IScreenshotArchive,
  type IVisualBaselineArchive,
  type BrowserNavigateDetails,
  type BrowserSnapshotDetails,
  type BrowserQueryDetails,
  type BrowserClickDetails,
  type BrowserSelectDetails,
  type BrowserFillDetails,
  type BrowserWaitForDetails,
  type BrowserScreenshotDetails,
  type BrowserCaptureBaselineDetails,
} from './browser'
