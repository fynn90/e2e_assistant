/**
 * 浏览器会话宿主端口：把「当前生成任务可用的浏览器会话」抽象给 Agent 工具使用。
 *
 * 依赖倒转（技术方案 3）：Agent 不直接创建或管理浏览器进程，
 * 浏览器会话由 Service 的 generation-runtime 创建并注入；本模块只声明端口。
 * 会话契约类型（IBrowserSession 等）位于 @fynn90-e2e_assistant/types 共享契约包，
 * agent 包对 playwright-engine 零依赖，测试也可注入替身。
 */

import type { IAgentToolImageRef } from '@fynn90-e2e_assistant/types'
import type {
  IBrowserSession,
  IPageSnapshot,
  IPageScreenshot,
  IActionOptions,
  IActionResult,
  IElementInfo,
  IFrameInventory,
  IFrameListOptions,
  IFrameTargetOptions,
  IFullContentScreenshotOptions,
  IScreenshotOptions,
  ISnapshotOptions,
  IWaitCondition,
  IWaitOptions,
  IWaitResult,
} from '@fynn90-e2e_assistant/types'

/**
 * 截图持久化端口（v12-pre）。
 *
 * 引擎契约明确「截图不落盘」，而图片要展示给用户就必须有可被客户端拉取的载体。
 * 该载体与「落盘位置、URL 规则、安全校验」都属于宿主（CLI）的职责，
 * 因此这里只声明端口：agent 包负责调用与降级，不关心存到哪、怎么暴露。
 */
export interface IScreenshotArchive {
  /**
   * 归档一张截图并返回可供客户端拉取的引用。
   *
   * @param screenshot - 引擎返回的截图（base64 数据与尺寸）。
   * @param context - 归档上下文，用于生成人类可读的文件名。
   * @returns 图片引用（URL、MIME 类型与尺寸）。
   * @throws 归档失败时抛出；调用方负责降级为「不展示图片」。
   */
  archive (
    screenshot: IPageScreenshot,
    context: { selector?: string; capturedAt: number },
  ): Promise<IAgentToolImageRef>
}

/**
 * Agent 浏览器工具可用的会话与导航边界。
 *
 * 与 IBrowserSession 的差别：宿主额外持有 baseUrl 与用例上下文，
 * 负责把「用例里的自然语言步骤」翻译成允许的导航目标，工具本身不做 URL 推断。
 */
export interface IBrowserSessionHost {
  /** 当前任务允许的基准地址（用例 baseUrl）。 */
  readonly baseUrl: string
  /** 是否以有头模式打开（仅用于结果描述，不参与工具决策）。 */
  readonly headed: boolean
  /**
   * 枚举当前页面的主文档与子 frame 的有界元数据（v20 iframe）。
   *
   * @param options - 可选的可见性过滤和数量上限。
   * @returns 主文档与子 frame 的元数据清单。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  listFrames (options?: IFrameListOptions): Promise<IFrameInventory>
  /**
   * 打开目标页面并返回页面引用。
   *
   * @param url - 绝对 URL；缺省导航到 baseUrl。
   * @returns 导航完成后的页面地址与标题。
   * @throws 目标越权、页面访问失败、取消或浏览器断连时抛出结构化错误。
   */
  openPage (url?: string): Promise<{ url: string; title: string }>
  /**
   * 采集当前页面的有界快照（可访问性树 + 候选定位器）。
   *
   * @param options - 可选的输出长度与候选数量限制。
   * @returns 脱离 Playwright 原始对象的页面快照。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  snapshotPage (options?: ISnapshotOptions): Promise<IPageSnapshot>
  /**
   * 查询页面元素并转换为结构化信息。
   *
   * @param selector - 页面内的 CSS / Playwright selector。
   * @returns 有界元素信息列表。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  queryElements (selector: string, options?: IFrameTargetOptions): Promise<IElementInfo[]>
  /**
   * 点击页面元素。
   *
   * @param selector - 页面内的 CSS / Playwright selector。
   * @param options - 可选的操作超时。
   * @returns 点击完成后的页面地址与标题。
   * @throws selector 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  clickElement (
    selector: string,
    options?: IActionOptions,
  ): Promise<IActionResult>
  /**
   * 在下拉框中选中指定值。
   *
   * @param selector - 目标 select 元素的 selector。
   * @param value - 待选中的选项值。
   * @param options - 可选的操作超时。
   * @returns 选择完成后的页面地址与标题。
   * @throws selector 或 value 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  selectElementOption (
    selector: string,
    value: string,
    options?: IActionOptions,
  ): Promise<IActionResult>
  /**
   * 在输入框中填入文本（v20 凭据代理）。
   *
   * `value` 允许写 `${ENV:KEY}` 引用形态：真值由宿主在填入前解析，
   * **模型与其上下文全程只见到引用本身**，填入后也无法经快照回读。
   * 这是「登录步骤可被真实核对」的关键能力——没有它，Agent 遇到登录页
   * 就只能披露断点，后续步骤全部无法核对。
   *
   * @param selector - 目标输入元素的 selector。
   * @param value - 待填入的文本，或 `${ENV:KEY}` 引用。
   * @param options - 可选的操作超时。
   * @returns 填入完成后的页面地址与标题。
   * @throws selector 为空、引用解析失败、元素不可编辑、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  fillElement (
    selector: string,
    value: string,
    options?: IActionOptions,
  ): Promise<IActionResult>
  /**
   * 按条件等待页面状态（元素出现 / 加载完成 / URL 变化等）。
   *
   * @param condition - 等待条件。
   * @param options - 可选的等待超时。
   * @returns 条件是否满足及实际耗时。
   * @throws 条件非法、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  waitForPage (
    condition: IWaitCondition,
    options?: IWaitOptions,
  ): Promise<IWaitResult>
  /**
   * 截取页面或指定元素的截图。
   *
   * @param options - 可选的目标元素与整页开关。
   * @returns base64 图片数据与尺寸。
   * @throws selector 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  captureScreenshot (options?: IScreenshotOptions): Promise<IPageScreenshot>
  /**
   * 截取元素的**完整内容**（含元素内部滚动区域，v12）。
   *
   * 与 `captureScreenshot` 的差异：本方法会临时展开元素样式以截取被滚动隐藏的内容。
   * 用于「新旧 DOM 截图对比」的基线捕获。
   *
   * @param options - 目标元素 selector 与稳定性重试次数。
   * @returns base64 图片数据与尺寸。
   * @throws selector 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  captureFullContentScreenshot (
    options: IFullContentScreenshotOptions,
  ): Promise<IPageScreenshot>
  /**
   * 截图归档端口；未注入时截图只回传模型、不在界面展示。
   *
   * 缺省不注入的理由：普通 Chat 等场景没有「本会话产物目录」的概念，
   * 强行要求归档会让工具在无宿主支持时失败，而非优雅退化。
   */
  readonly screenshotArchive?: IScreenshotArchive
  /**
   * 视觉基线归档端口（v12）；未注入时基线捕获工具明确失败。
   *
   * 与 `screenshotArchive` 的**关键差异**：截图归档是旁路能力（失败可降级为「界面不展示」），
   * 而基线是**正式产物**——静默降级会让后续比对失去意义，因此未注入时直接失败。
   */
  readonly visualBaselineArchive?: IVisualBaselineArchive
}

/**
 * 视觉基线归档端口（v12）。
 *
 * 引擎契约明确「截图不落盘」，而基线必须是可被执行期比对的**持久文件**。
 * 落盘位置、分组规则与路径安全都属于宿主（CLI）职责，因此这里只声明端口。
 */
export interface IVisualBaselineArchive {
  /**
   * 归档一张视觉基线并返回其在 Skill 内的相对路径。
   *
   * @param screenshot - 引擎返回的完整内容截图（base64 数据与尺寸）。
   * @param context - 归档上下文：分组目录分段与文件名。
   * @returns 基线的相对路径（POSIX 分隔符）与尺寸。
   * @throws 归档失败时抛出；调用方**不得**静默降级。
   */
  archive (
    screenshot: IPageScreenshot,
    context: { segments: readonly string[]; fileName: string },
  ): Promise<{ relativePath: string; width: number; height: number }>
}

/**
 * 用真实浏览器会话创建 Agent 工具使用的宿主。
 *
 * @param session - 已启动的浏览器会话（由 CLI generation-runtime 创建并负责释放）。
 * @returns 绑定该会话的浏览器宿主端口。
 * @throws 不抛出异常；会话未就绪或已关闭时由具体方法抛出结构化错误。
 */
export function createBrowserSessionHost (
  session: IBrowserSession,
  screenshotArchive?: IScreenshotArchive,
  visualBaselineArchive?: IVisualBaselineArchive,
): IBrowserSessionHost {
  return {
    baseUrl: session.baseUrl,
    headed: session.headed,
    ...(screenshotArchive ? { screenshotArchive } : {}),
    ...(visualBaselineArchive ? { visualBaselineArchive } : {}),

    async openPage (url?: string) {
      // 缺省打开用例 baseUrl：Agent 未显式指定目标时不应推断任意地址。
      const target = url?.trim() ? url : session.baseUrl
      const ref = await session.navigate(target)
      return { url: ref.url, title: ref.title }
    },

    listFrames (options?: IFrameListOptions) {
      return session.listFrames(options)
    },

    snapshotPage (options?: ISnapshotOptions) {
      return session.snapshot(options)
    },

    queryElements (
      selector: string,
      options?: IFrameTargetOptions,
    ) {
      return session.query(selector, options)
    },

    clickElement (selector: string, options?: IActionOptions) {
      return session.click(selector, options)
    },

    selectElementOption (
      selector: string,
      value: string,
      options?: IActionOptions,
    ) {
      return session.selectOption(selector, value, options)
    },

    fillElement (selector: string, value: string, options?: IActionOptions) {
      return session.fill(selector, value, options)
    },

    waitForPage (condition: IWaitCondition, options?: IWaitOptions) {
      return session.waitFor(condition, options)
    },

    captureScreenshot (options?: IScreenshotOptions) {
      return session.screenshot(options)
    },

    captureFullContentScreenshot (options: IFullContentScreenshotOptions) {
      return session.screenshotFullContent(options)
    },
  }
}
