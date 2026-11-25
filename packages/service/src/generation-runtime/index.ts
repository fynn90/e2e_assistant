/**
 * 生成任务运行时：承载 Playwright 脚本生成所需的本机资源与并发控制。
 *
 * 本模块是 v7 基础设施层的装配点（v7-technical-design 5.5）：
 *   - BrowserSessionHost：Chromium 检测/安装 + 浏览器会话生命周期；
 *   - GenerationTaskRegistry：per-Skill 生成任务排他锁。
 *
 * 应用层通过端口调用，不直接依赖具体实现，便于测试注入替身。
 */

export {
  createGenerationBrowserHost,
  type IBrowserSessionHostOptions,
  type IGenerationBrowserHost,
} from './browser-session-host'
export {
  createGenerationTaskRegistry,
  type IGenerationTaskLease,
  type IGenerationTaskRegistry,
} from './generation-task-registry'
