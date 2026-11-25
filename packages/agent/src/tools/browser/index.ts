/**
 * 生成 Agent 的浏览器工具统一出口。
 *
 * 这些工具让 Agent 在「页面元素核对」阶段访问目标页面、采集快照并查询元素
 * （PRD 9.2 / v7-technical-design 5.3）。工具本身不创建浏览器进程，
 * 而是通过注入的 IBrowserSessionHost 端口访问由 CLI generation-runtime
 * 管理的浏览器会话，保持 agent 包对 playwright-engine 启动实现的零依赖。
 */

export {
  createBrowserSessionHost,
  type IBrowserSessionHost,
  type IScreenshotArchive,
  type IVisualBaselineArchive,
} from './Browser_session'
export {
  createBrowserSessionRegistry,
  browserSessionRegistry,
  type IBrowserSessionRegistry,
} from './browser-session-registry'
export {
  createBrowserNavigateTool,
  type BrowserNavigateDetails,
} from './browser_navigate'
export {
  createBrowserListFramesTool,
  type BrowserListFramesDetails,
} from './browser_list_frames'
export {
  createBrowserSnapshotTool,
  type BrowserSnapshotDetails,
} from './browser_snapshot'
export {
  createBrowserQueryTool,
  type BrowserQueryDetails,
} from './browser_query'
export {
  createBrowserClickTool,
  type BrowserClickDetails,
} from './browser_click'
export {
  createBrowserSelectTool,
  type BrowserSelectDetails,
} from './browser_select'
export {
  createBrowserFillTool,
  type BrowserFillDetails,
} from './browser_fill'
export {
  createBrowserWaitForTool,
  type BrowserWaitForDetails,
} from './browser_waitFor'
export {
  createBrowserScreenshotTool,
  type BrowserScreenshotDetails,
} from './browser_screenshot'
export {
  createBrowserCaptureBaselineTool,
  captureBaselineLimits,
  type BrowserCaptureBaselineDetails,
} from './browser_capture_baseline'
