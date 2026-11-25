/**
 * 定义浏览器会话的跨包共享契约。
 *
 * 本文件是 agent 与 playwright-engine 之间唯一的共享边界：
 *   - playwright-engine 提供契约的 Playwright 实现（会话选项、凭据解析、工厂仍在引擎）；
 *   - agent 只面向契约声明工具宿主端口（依赖倒转），由 service 组合根注入实现。
 * 双方均从 @authine-e2e-agent/types 导入，两个包之间互不引用。
 */

/**
 * 对进入事件、错误和结果的文本进行脱敏。
 */
export interface ISensitiveDataRedactor {
  /**
   * 替换秘密值、常见凭据模式和本机绝对路径。
   *
   * @param value - 可能包含敏感信息的文本。
   * @returns 已脱敏且有长度上限的文本。
   * @throws 不抛出异常；异常输入按空字符串处理。
   */
  redact(value: string): string
}

/**
 * 浏览器会话内短生命周期 frame 句柄（v20 iframe 支持）。
 *
 * 由 Engine 的 FrameRegistry 分配，页面导航或 frame detach 后立即失效；
 * Agent 必须通过 `listFrames()` 获取最新清单后才能使用。
 */
export type IFrameId = string

/**
 * iframe 元数据，不包含页面内容。
 */
export interface IFrameInfo {
  frameId: IFrameId
  parentFrameId: IFrameId | null
  name: string
  url: string
  title?: string
  origin: string
  sameOrigin: boolean
  depth: number
  visible: boolean
  width: number
  height: number
  /** 从主文档进入目标 frame 的 iframe locator 链。 */
  locatorChain: readonly string[]
  /** 当前 frame 是否允许执行后续操作。 */
  operationAllowed: boolean
  /** 不允许时的稳定原因。 */
  blockedReason?: 'cross-origin-disabled'
}

/**
 * frame 清单结果。
 */
export interface IFrameInventory {
  mainFrameId: IFrameId
  frames: IFrameInfo[]
  truncated: boolean
  capturedAt: string
}

/**
 * 可选 frame 目标。
 */
export interface IFrameTargetOptions {
  /** 缺省表示主文档；提供时操作目标为对应 iframe。 */
  frameId?: IFrameId
}

/**
 * frame 清单选项。
 */
export interface IFrameListOptions {
  includeHidden?: boolean
  maxFrames?: number
}

/**
 * iframe 快照的来源信息。
 */
export interface IFrameSnapshotSource {
  frameId: IFrameId
  parentFrameId: IFrameId | null
  url: string
  title?: string
}

export interface ISnapshotOptions extends IFrameTargetOptions {
  maxA11yLength?: number
  maxLocators?: number
  redactor?: ISensitiveDataRedactor
}

/**
 * 页面中的候选定位器。
 */
export interface ICandidateLocator {
  role?: string
  name?: string
  label?: string
  placeholder?: string
  testId?: string
  text?: string
  css?: string
  confidence?: number
}

/**
 * 查询返回的结构化元素信息。
 */
export interface IElementInfo {
  selector: string
  index: number
  tagName?: string
  role?: string
  name?: string
  text?: string
  value?: string
  attributes?: Readonly<Record<string, string>>
}

/**
 * 页面写操作（click / selectOption / fill）的可选配置。
 */
export interface IActionOptions extends IFrameTargetOptions {
  /** 单次操作的超时时间（毫秒）；缺省使用会话默认超时。 */
  timeoutMs?: number
}

/**
 * 页面写操作完成后的页面引用。
 *
 * 复用 navigate 的「调用后重读 url」模式：点击可能触发导航，
 * 调用方拿到的是操作完成后的地址而非操作前的地址。
 */
export interface IActionResult {
  url: string
  title: string
}

/**
 * waitFor 的等待条件。
 *
 * 引擎的脚本校验器明确反对固定 sleep，因此这里以条件式等待为主，
 * `timeout` 分支是显式的固定等待兜底。
 */
export type IWaitCondition =
  | {
      kind: 'selector'
      selector: string
      state?: 'attached' | 'detached' | 'visible' | 'hidden'
    }
  | { kind: 'loadState'; state: 'load' | 'domcontentloaded' | 'networkidle' }
  | { kind: 'url'; pattern: string }
  | { kind: 'timeout'; ms: number }

/**
 * waitFor 的可选配置。
 */
export interface IWaitOptions extends IFrameTargetOptions {
  /** 等待超时时间（毫秒）；缺省使用会话默认超时。 */
  timeoutMs?: number
}

/**
 * waitFor 的等待结果。
 */
export interface IWaitResult {
  /** 条件是否在超时前满足。 */
  matched: boolean
  /** 实际等待耗时（毫秒）。 */
  elapsedMs: number
}

/**
 * 页面截图结果。
 *
 * 图片以 base64 返回，**不落盘**——与 test-report-renderer 处理附件的姿态一致，
 * 由调用方决定是否及如何持久化。
 */
export interface IPageScreenshot {
  /** base64 编码的图片数据（不含 data URI 前缀）。 */
  data: string
  /** 图片 MIME 类型，当前恒为 image/png。 */
  mimeType: string
  /** 图片宽度（像素）。 */
  width: number
  /** 图片高度（像素）。 */
  height: number
}

/**
 * screenshot 的可选配置。
 */
export interface IScreenshotOptions extends IFrameTargetOptions {
  /** 目标元素 selector；缺省截取整个可视区域。 */
  selector?: string
  /** 是否截取整页（含滚动区域），仅在未指定 selector 时生效。 */
  fullPage?: boolean
}

/**
 * 完整内容截图（含元素内部滚动区域）的可选配置。
 *
 * 与 `IScreenshotOptions` 的区别：本方法针对**元素内部溢出**（`overflow:auto/scroll`），
 * 通过临时展开样式截取全部内容；`fullPage` 针对的是**页面级**滚动。
 */
export interface IFullContentScreenshotOptions extends IFrameTargetOptions {
  /** 目标元素 selector；**必填**——完整内容捕获以元素为单位。 */
  selector: string
  /**
   * 稳定性重试的最大尝试次数；缺省 4。
   *
   * 连续两次截图字节一致即返回；达到上限仍不一致时返回最后一张。
   */
  maxAttempts?: number
}

/**
 * navigate() 返回的当前页面引用。
 */
export interface IPageSnapshotRef {
  url: string
  title: string
}

/**
 * 供 Agent 使用的有界页面快照。
 */
export interface IPageSnapshot {
  url: string
  title: string
  a11yTree: string
  /** 快照来源为目标 iframe 时携带此字段。 */
  frame?: IFrameSnapshotSource
  candidateLocators: ICandidateLocator[]
  truncated: boolean
  capturedAt: string
}

/**
 * 不暴露 Playwright 原始对象的浏览器会话。
 */
export interface IBrowserSession {
  readonly id: string
  readonly headed: boolean
  /**
   * 枚举当前页面的主文档与子 frame 的有界元数据。
   *
   * @param options - 可选的可见性过滤和数量上限。
   * @returns 主文档与子 frame 的元数据清单。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  listFrames(options?: IFrameListOptions): Promise<IFrameInventory>

  readonly baseUrl: string
  /**
   * 在同源范围内导航页面。
   *
   * @param url - 目标页面 URL。
   * @returns 导航完成后的页面引用。
   * @throws 目标越权、页面访问失败、取消或浏览器断连时抛出结构化错误。
   */
  navigate(url: string): Promise<IPageSnapshotRef>
  /**
   * 采集有界的可访问性和候选定位器快照。
   *
   * @param options - 可选的输出长度和候选数量限制。
   * @returns 脱离 Playwright 对象的页面快照。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  snapshot(options?: ISnapshotOptions): Promise<IPageSnapshot>
  /**
   * 查询页面元素并转换为结构化信息。
   *
   * @param selector - 页面内的 CSS/Playwright selector。
   * @returns 有界元素信息列表。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  query(selector: string, options?: IFrameTargetOptions): Promise<IElementInfo[]>
  /**
   * 点击页面元素。
   *
   * 交互后才出现的元素（弹框、展开项）需要先点击再核对，因此本方法不做导航预检：
   * 同源网络策略已在网络层拦截跨源文档导航，预检反而会误伤同源导航按钮。
   *
   * @param selector - 页面内的 CSS/Playwright selector。
   * @param options - 可选的操作超时。
   * @returns 点击完成后的页面地址与标题（点击可能触发导航）。
   * @throws selector 为空、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  click(selector: string, options?: IActionOptions): Promise<IActionResult>
  /**
   * 在下拉框中选中指定值。
   *
   * @param selector - 目标 select 元素的 CSS/Playwright selector。
   * @param value - 待选中的选项值（匹配 option 的 value）。
   * @param options - 可选的操作超时。
   * @returns 选择完成后的页面地址与标题。
   * @throws selector 或 value 为空、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  selectOption(
    selector: string,
    value: string,
    options?: IActionOptions,
  ): Promise<IActionResult>
  /**
   * 在输入框中填入文本，并返回填入后的页面地址。
   *
   * `value` 支持两种形态（v20 凭据代理）：
   *   - **字面量**：直接填入，适用于用户名、验证码等非敏感内容；
   *   - **`${ENV:KEY}` 引用**：由宿主注入的凭据解析器在填入前换取真值。
   *     真值不会出现在返回值、工具结果或任何事件中，
   *     且会被立即登记进本会话的脱敏器，使后续快照与元素查询无法回读。
   *
   * 未注入解析器而传入引用形态时**直接报错**，不静默按字面量填入——
   * 否则引用文本会被当成密码写进页面，且错误要等到断言失败才暴露。
   *
   * 与 `selectOption` 的分工：本方法面向 `<input>` / `<textarea>` / `[contenteditable]`；
   * 下拉框仍用 `selectOption`。填入前会先清空原有内容（等价 `fill` 语义）。
   *
   * @param selector - 目标输入元素的 selector。
   * @param value - 待填入的文本，或 `${ENV:KEY}` 引用。
   * @param options - 可选操作超时。
   * @returns 填入完成后的页面地址与标题。
   * @throws selector 为空、引用解析失败、元素不可编辑、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  fill(
    selector: string,
    value: string,
    options?: IActionOptions,
  ): Promise<IActionResult>
  /**
   * 按条件等待页面状态，不做无条件的固定 sleep。
   *
   * @param condition - 等待条件（元素状态 / 加载状态 / URL / 显式固定等待）。
   * @param options - 可选的等待超时。
   * @returns 条件是否满足及实际耗时；超时返回 matched=false 而非抛出异常。
   * @throws 条件非法、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  waitFor(
    condition: IWaitCondition,
    options?: IWaitOptions,
  ): Promise<IWaitResult>
  /**
   * 截取页面或指定元素的截图。
   *
   * @param options - 可选的目标元素与整页开关。
   * @returns base64 图片数据与尺寸；**不落盘**，由调用方决定持久化方式。
   * @throws selector 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  screenshot(options?: IScreenshotOptions): Promise<IPageScreenshot>
  /**
   * 截取元素的**完整内容**（含元素内部滚动区域）。
   *
   * 用于「新旧 DOM 截图对比」场景的基线捕获：`screenshot()` 与 Playwright 官方的
   * `toHaveScreenshot` 对内部滚动容器只截可见区，而本方法会临时展开样式截取全部内容。
   *
   * @param options - 目标元素 selector 与稳定性重试次数。
   * @returns base64 图片数据与尺寸；**不落盘**，由调用方决定持久化方式。
   * @throws selector 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  screenshotFullContent(
    options: IFullContentScreenshotOptions,
  ): Promise<IPageScreenshot>
  /**
   * 关闭 context 和 browser，调用可重复且幂等。
   *
   * @returns 资源释放完成的 Promise。
   * @throws 释放失败时抛出最后一个资源错误。
   */
  close(): Promise<void>
}
