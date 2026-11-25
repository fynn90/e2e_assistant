/** 实现隐藏 Playwright 原始对象的浏览器会话生命周期、导航、快照和查询。 */

import {
  errors as playwrightErrors,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
} from 'playwright'
import { publishEngineEvent, type IEngineEventSink } from '../contracts/events'
import {
  PlaywrightEngineError,
  type TPlaywrightEngineErrorCode,
} from '../contracts/errors'
import type {
  IBrowserSession,
  IBrowserSessionOptions,
  IActionOptions,
  IActionResult,
  ICredentialResolver,
  IElementInfo,
  IFrameInventory,
  IFrameListOptions,
  IFrameSnapshotSource,
  IFrameTargetOptions,
  IFullContentScreenshotOptions,
  IPageSnapshot,
  IPageSnapshotRef,
  IPageScreenshot,
  IScreenshotOptions,
  ISnapshotOptions,
  IWaitCondition,
  IWaitOptions,
  IWaitResult,
} from '../contracts/browser'
import type { INetworkPolicy } from '../contracts/network'
import {
  isSecretRegistrable,
  type ISensitiveDataRedactor,
} from '../contracts/observability'
import { createDefaultRedactor } from '../observability/redaction'
import { captureLocatorFullContent } from './full-content-capture'
import { resolveFillValue } from './credential-resolver'
import { createPageSnapshot, pageSnapshotDefaults } from './page-snapshot'
import { queryPageElements } from './page-query'
import { readPngDimensions, PNG_MIME_TYPE } from './png-dimensions'
import { FrameRegistry } from './frame-registry'
import { inspectFrameInventory, resolveOperableFrame } from './frame-inspector'
import { createFrameSnapshot } from './frame-snapshot'

const DEFAULT_QUERY_LIMIT = 100

/**
 * 持有 Browser、Context 和 Page 的 Playwright 会话实现。
 */
export class PlaywrightBrowserSession implements IBrowserSession {
  readonly id: string
  readonly headed: boolean
  readonly baseUrl: string

  private readonly browser: Browser
  private readonly context: BrowserContext
  private readonly page: Page
  private readonly networkPolicy: INetworkPolicy
  private readonly navigationTimeoutMs: number
  private readonly eventSink?: IEngineEventSink
  private readonly redactor: ISensitiveDataRedactor
  /**
   * 凭据解析端口（v20 凭据代理）。
   *
   * 缺省时 `fill` 只接受字面量：遇到 `${ENV:KEY}` 引用直接报错，
   * 而不是把引用文本当普通值填进页面（那会让错误推迟到断言阶段才暴露）。
   */
  private readonly credentialResolver?: ICredentialResolver
  /**
   * 宿主显式注入的脱敏器。
   *
   * 与 redactor 分开保存的原因：快照需要按当次调用的有效上限派生脱敏器，
   * 但显式注入的脱敏器（可能携带宿主自己的秘密集合）必须优先复用，
   * 不能被子类默认逻辑覆盖。
   */
  private readonly injectedRedactor?: ISensitiveDataRedactor
  private readonly abortSignal?: AbortSignal
  private closePromise: Promise<void> | undefined
  private disconnected = false
  private readonly frameRegistry = new FrameRegistry()

  /**
   * 创建已启动的 Playwright 页面会话。
   *
   * @param dependencies - 浏览器资源、公共配置和网络策略。
   * @returns 由同一对象负责释放的页面会话。
   * @throws 不抛出异常；启动由 session factory 完成。
   */
  constructor(dependencies: {
    id: string
    headed: boolean
    baseUrl: string
    browser: Browser
    context: BrowserContext
    page: Page
    networkPolicy: INetworkPolicy
    navigationTimeoutMs: number
    eventSink?: IEngineEventSink
    redactor?: ISensitiveDataRedactor
    credentialResolver?: ICredentialResolver
    signal?: AbortSignal
  }) {
    this.id = dependencies.id
    this.headed = dependencies.headed
    this.baseUrl = dependencies.baseUrl
    this.browser = dependencies.browser
    this.context = dependencies.context
    this.page = dependencies.page
    this.networkPolicy = dependencies.networkPolicy
    this.navigationTimeoutMs = dependencies.navigationTimeoutMs
    this.eventSink = dependencies.eventSink
    this.credentialResolver = dependencies.credentialResolver
    this.injectedRedactor = dependencies.redactor
    // 未注入脱敏器时按**有效快照上限**派生，而不是用默认实例（默认 maxLength 为
    // 8192，会把快照悄悄截到 8KB 以内，使快照上限配置形同虚设）。
    this.redactor =
      dependencies.redactor ??
      createDefaultRedactor({ maxLength: pageSnapshotDefaults.maxA11yLength })
    this.abortSignal = dependencies.signal

    this.browser.on('disconnected', this.handleDisconnected)
    this.abortSignal?.addEventListener('abort', this.handleAbort, {
      once: true,
    })
    publishEngineEvent(this.eventSink, {
      type: 'browser.started',
      sessionId: this.id,
      headed: this.headed,
    })
  }

  /**
   * 枚举当前页面的主文档与子 frame 的有界元数据（v20 iframe）。
   *
   * @param options - 可选的可见性过滤和数量上限。
   * @returns 主文档与子 frame 的元数据清单。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async listFrames(options?: IFrameListOptions): Promise<IFrameInventory> {
    this.assertUsable()
    const inventory = await inspectFrameInventory(
      this.page,
      this.frameRegistry,
      this.redactor,
      options,
    )
    publishEngineEvent(this.eventSink, {
      type: 'browser.frames',
      sessionId: this.id,
      frameCount: inventory.frames.length,
      truncated: inventory.truncated,
    })
    return inventory
  }
  /**
   * 在 baseUrl 同源范围内导航页面。
   *
   * @param url - 目标页面 URL。
   * @returns 导航完成后的页面引用。
   * @throws 越权导航、取消、页面访问失败或浏览器断连时抛出结构化错误。
   */
  async navigate(url: string): Promise<IPageSnapshotRef> {
    this.assertUsable()
    if (!this.networkPolicy.assertNavigable(url)) {
      const error = new PlaywrightEngineError(
        'NETWORK_DOCUMENT_BLOCKED',
        '页面导航被同源网络策略阻止。',
        { component: 'network', retryable: false, reason: 'different-origin' },
      )
      this.publishError(error)
      throw error
    }

    try {
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      })
      // 导航后旧页面所有 frameId 失效，必须清空让 Agent 重新 listFrames。
      this.frameRegistry.clear()
      const result = { url: this.page.url(), title: await this.page.title() }
      publishEngineEvent(this.eventSink, {
        type: 'browser.navigation',
        sessionId: this.id,
        url: result.url,
      })
      return result
    } catch (error) {
      throw this.toPageError(error, 'PAGE_ACCESS_FAILED', '页面导航失败。')
    }
  }

  /**
   * 采集当前页面的有界可访问性树和候选定位器。
   *
   * @param options - 快照长度和候选数量限制。
   * @returns 脱离 Playwright 原始对象的页面快照。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async snapshot(options?: ISnapshotOptions): Promise<IPageSnapshot> {
    this.assertUsable()
    try {
      const frameId = options?.frameId
      if (frameId) {
        const frame = resolveOperableFrame(this.page, this.frameRegistry, frameId, this.baseUrl)
        const source: IFrameSnapshotSource = {
          frameId,
          parentFrameId: frame.parentFrame() ? this.frameRegistry.identify(frame.parentFrame()!) : null,
          url: frame.url(),
          title: await frame.title().catch(() => ''),
        }
        const snapshot = await createFrameSnapshot(frame, source, {
          ...options,
          redactor: this.resolveSnapshotRedactor(options),
        })
        publishEngineEvent(this.eventSink, { type: 'browser.snapshot', sessionId: this.id, truncated: snapshot.truncated })
        return snapshot
      }
      const snapshot = await createPageSnapshot(this.page, {
        ...options,
        redactor: this.resolveSnapshotRedactor(options),
      })
      publishEngineEvent(this.eventSink, {
        type: 'browser.snapshot',
        sessionId: this.id,
        truncated: snapshot.truncated,
      })
      return snapshot
    } catch (error) {
      if (error instanceof PlaywrightEngineError) throw error
      throw this.toPageError(
        error,
        'PAGE_VERIFICATION_FAILED',
        '页面快照采集失败。',
      )
    }
  }

  /**
   * 查询页面元素并只返回结构化信息。
   *
   * @param selector - CSS 或 Playwright selector。
   * @returns 最多 100 个元素的脱敏信息。
   * @throws 页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async query(
    selector: string,
    options?: IFrameTargetOptions,
  ): Promise<IElementInfo[]> {
    this.assertUsable()
    if (!selector.trim()) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        '元素查询 selector 不能为空。',
        { component: 'browser', retryable: false, reason: 'empty-selector' },
      )
    }

    try {
      // frameId 存在时在目标 iframe 内查询。
      if (options?.frameId) {
        const frame = resolveOperableFrame(this.page, this.frameRegistry, options.frameId, this.baseUrl)
        return await queryPageElements(frame, selector, this.redactor, DEFAULT_QUERY_LIMIT)
      }
      return await queryPageElements(
        this.page,
        selector,
        this.redactor,
        DEFAULT_QUERY_LIMIT,
      )
    } catch (error) {
      throw this.toPageError(error, 'PAGE_ACCESS_FAILED', '页面元素查询失败。')
    }
  }

  /**
   * 点击页面元素并返回点击后的页面地址。
   *
   * @param selector - 页面内的 CSS/Playwright selector。
   * @param options - 可选操作超时。
   * @returns 点击完成后的页面地址与标题。
   * @throws selector 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async click(
    selector: string,
    options?: IActionOptions,
  ): Promise<IActionResult> {
    this.assertUsable()
    if (!selector.trim()) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        '点击操作的 selector 不能为空。',
        { component: 'browser', retryable: false, reason: 'empty-selector' },
      )
    }

    try {
      const locator = this.resolveActionLocator(selector, options?.frameId)
      await locator.click(this.toActionTimeout(options))
      // 点击可能触发导航，因此调用后重读 url/title，与 navigate 的约定一致。
      const result = { url: this.page.url(), title: await this.page.title() }
      publishEngineEvent(this.eventSink, {
        type: 'browser.action',
        sessionId: this.id,
        action: 'click',
        selector,
        ...(options?.frameId ? { frameId: options.frameId } : {}),
      })
      return result
    } catch (error) {
      throw this.toPageError(error, 'PAGE_ACTION_FAILED', '页面元素点击失败。')
    }
  }

  /**
   * 在下拉框中选中指定值，并返回选择后的页面地址。
   *
   * @param selector - 目标 select 元素的 selector。
   * @param value - 待选中的选项值。
   * @param options - 可选操作超时。
   * @returns 选择完成后的页面地址与标题（选择可能联动触发导航或区域刷新）。
   * @throws selector 或 value 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async selectOption(
    selector: string,
    value: string,
    options?: IActionOptions,
  ): Promise<IActionResult> {
    this.assertUsable()
    if (!selector.trim()) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        '下拉选择的 selector 不能为空。',
        { component: 'browser', retryable: false, reason: 'empty-selector' },
      )
    }
    if (!value.trim()) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        '下拉选择的选项值不能为空。',
        { component: 'browser', retryable: false, reason: 'empty-value' },
      )
    }

    try {
      const locator = this.resolveActionLocator(selector, options?.frameId)
      await locator.selectOption(value, this.toActionTimeout(options))
      const result = { url: this.page.url(), title: await this.page.title() }
      publishEngineEvent(this.eventSink, {
        type: 'browser.action',
        sessionId: this.id,
        action: 'select',
        ...(options?.frameId ? { frameId: options.frameId } : {}),
        selector,
      })
      return result
    } catch (error) {
      throw this.toPageError(error, 'PAGE_ACTION_FAILED', '下拉选择失败。')
    }
  }

  /**
   * 在输入框中填入文本（v20 凭据代理）。
   *
   * 安全关键顺序（**不可调换**）：解析引用 → 登记脱敏器 → 填入页面。
   * 若先填入再登记，登记前的任何观测（含 next 快照的时序竞争）都可能读到明文；
   * 而登记本身是纯内存操作、无副作用，提前做的代价为零。
   *
   * @param selector - 目标输入元素的 selector。
   * @param value - 待填入的文本或 `${ENV:KEY}` 引用。
   * @param options - 可选操作超时。
   * @returns 填入完成后的页面地址与标题。
   * @throws selector 为空、引用解析失败、元素不可编辑、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async fill(
    selector: string,
    value: string,
    options?: IActionOptions,
  ): Promise<IActionResult> {
    this.assertUsable()
    if (!selector.trim()) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        '填入操作的 selector 不能为空。',
        { component: 'browser', retryable: false, reason: 'empty-selector' },
      )
    }

    const resolved = await resolveFillValue(value, this.credentialResolver)
    if (!resolved.ok) {
      const error = new PlaywrightEngineError(
        'CREDENTIAL_RESOLUTION_FAILED',
        describeCredentialFailure(resolved.reason, resolved.key),
        {
          component: 'browser',
          retryable: false,
          reason: resolved.reason,
        },
      )
      this.publishError(error)
      throw error
    }

    // 先登记后填入：真值一旦进入页面就会被无障碍树与元素查询带出，
    // 必须保证脱敏器在那一刻已经认识它。
    if (resolved.isCredential && isSecretRegistrable(this.redactor)) {
      this.redactor.registerSecret(resolved.value)
    }

    try {
      const locator = this.resolveActionLocator(selector, options?.frameId)
      await locator.fill(resolved.value, this.toActionTimeout(options))
      const result = { url: this.page.url(), title: await this.page.title() }
      publishEngineEvent(this.eventSink, {
        type: 'browser.action',
        sessionId: this.id,
        action: 'fill',
        selector,
        ...(options?.frameId ? { frameId: options.frameId } : {}),
        // 只标注「本次填入的是凭据」，值本身永不进入事件流。
        ...(resolved.isCredential ? { redacted: true } : {}),
      })
      return result
    } catch (error) {
      throw this.toPageError(error, 'PAGE_ACTION_FAILED', '页面输入框填入失败。')
    }
  }

  /**
   * 按条件等待页面状态。
   *
   * 超时不是异常：返回 matched=false 让 Agent 据此判断「元素确实没出现」，
   * 而不是把等待失败混同为页面访问故障。只有条件本身非法或会话不可用时才抛错。
   *
   * @param condition - 等待条件（元素状态 / 加载状态 / URL / 显式固定等待）。
   * @param options - 可选等待超时。
   * @returns 条件是否满足及实际耗时。
   * @throws 条件非法、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async waitFor(
    condition: IWaitCondition,
    options?: IWaitOptions,
  ): Promise<IWaitResult> {
    this.assertUsable()
    if (options?.frameId && (condition.kind === 'loadState' || condition.kind === 'url')) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        'frameId 模式下不支持条件 kind=' + condition.kind + '，请使用 selector 或 timeout。',
        { component: 'browser', retryable: false, reason: 'frame-unsupported-condition' },
      )
    }
    const timeoutMs = this.toWaitTimeout(options)
    const startedAt = Date.now()

    try {
      const matched = await this.runWaitCondition(condition, timeoutMs, options?.frameId)
      const elapsedMs = Date.now() - startedAt
      publishEngineEvent(this.eventSink, {
        type: 'browser.wait',
        sessionId: this.id,
        matched,
        elapsedMs,
      })
      return { matched, elapsedMs }
    } catch (error) {
      // 超时是等待的预期结果之一，转换为 matched=false 而非失败。
      if (error instanceof playwrightErrors.TimeoutError) {
        const elapsedMs = Date.now() - startedAt
        publishEngineEvent(this.eventSink, {
          type: 'browser.wait',
          sessionId: this.id,
          matched: false,
          elapsedMs,
        })
        return { matched: false, elapsedMs }
      }

      if (error instanceof PlaywrightEngineError) {
        throw error
      }

      // 走到这里说明等待**未能完成**（页面关闭、会话断连、URL 模式非法等），
      // 而不是「条件未满足」——后者已在上方转换为 matched=false 的正常返回。
      // durationMs 记录已等待的时长，便于判断是环境问题还是条件本身不可达。
      throw this.toPageError(error, 'PAGE_WAIT_TIMEOUT', '页面等待未能完成。', {
        durationMs: Date.now() - startedAt,
      })
    }
  }

  /**
   * 截取页面或指定元素的截图。
   *
   * 图片以 base64 返回且**不落盘**：引擎不假设调用方的存储位置，
   * 持久化由宿主按自己的目录约定完成。
   *
   * @param options - 可选目标元素与整页开关。
   * @returns base64 图片数据、MIME 类型与尺寸。
   * @throws selector 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async screenshot(options?: IScreenshotOptions): Promise<IPageScreenshot> {
    this.assertUsable()
    const selector = options?.selector?.trim()

    if (options?.selector !== undefined && !selector) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        '截图目标 selector 不能为空。',
        { component: 'browser', retryable: false, reason: 'empty-selector' },
      )
    }

    try {
      // frameId 存在时截取目标 iframe。无 selector 截 iframe 宿主元素；有 selector 截 frame 内元素。
      let buffer: Buffer
      if (options?.frameId) {
        const frame = resolveOperableFrame(this.page, this.frameRegistry, options.frameId, this.baseUrl)
        buffer = selector
          ? await frame.locator(selector).screenshot()
          : await (await frame.frameElement()).screenshot()
      } else {
        buffer = selector
          ? await this.page.locator(selector).screenshot()
          : await this.page.screenshot({ fullPage: options?.fullPage === true })
      }
      const dimensions = readPngDimensions(buffer)

      return {
        data: buffer.toString('base64'),
        mimeType: PNG_MIME_TYPE,
        width: dimensions?.width ?? 0,
        height: dimensions?.height ?? 0,
      }
    } catch (error) {
      throw this.toPageError(error, 'PAGE_ACTION_FAILED', '页面截图失败。')
    }
  }

  /**
   * 截取元素的完整内容（含元素内部滚动区域）。
   *
   * 与 `screenshot()` 的关键差异：本方法会**临时展开元素样式**以截取被滚动隐藏的内容，
   * 并在 `finally` 中还原。用于“新旧 DOM 截图对比”的基线捕获（v12）。
   *
   * @param options - 目标元素 selector 与稳定性重试次数。
   * @returns base64 图片数据、MIME 类型与尺寸；不落盘。
   * @throws selector 为空、元素不存在、页面不可用、取消或浏览器断连时抛出结构化错误。
   */
  async screenshotFullContent(
    options: IFullContentScreenshotOptions,
  ): Promise<IPageScreenshot> {
    this.assertUsable()
    const selector = options.selector?.trim()

    if (!selector) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        '完整内容截图的 selector 不能为空。',
        { component: 'browser', retryable: false, reason: 'empty-selector' },
      )
    }

    try {
      // 完整内容捕获的逻辑集中在纯函数模块中，与生成脚本的内联模板保持同一口径。
      const targetLocator = options?.frameId
        ? resolveOperableFrame(this.page, this.frameRegistry, options.frameId, this.baseUrl).locator(selector)
        : this.page.locator(selector)
      const buffer = await captureLocatorFullContent(
        targetLocator,
        {
          ...(options.maxAttempts === undefined
            ? {}
            : { maxAttempts: options.maxAttempts }),
        },
      )
      const dimensions = readPngDimensions(buffer)

      publishEngineEvent(this.eventSink, {
        type: 'browser.screenshot',
        sessionId: this.id,
        fullContent: true,
      })

      return {
        data: buffer.toString('base64'),
        mimeType: PNG_MIME_TYPE,
        width: dimensions?.width ?? 0,
        height: dimensions?.height ?? 0,
      }
    } catch (error) {
      throw this.toPageError(error, 'PAGE_ACTION_FAILED', '完整内容截图失败。')
    }
  }

  /**
   * 幂等关闭 Page、Context 和 Browser。
   *
   * @returns 所有由会话拥有的 Playwright 资源释放完成。
   * @throws 资源释放失败且不是浏览器已断连时抛出结构化错误。
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.closeResources()
    return this.closePromise
  }

  /**
   * 执行实际资源关闭并移除生命周期监听器。
   *
   * @returns 关闭操作完成。
   * @throws 关闭失败时抛出资源错误。
   */
  private async closeResources(): Promise<void> {
    this.browser.off('disconnected', this.handleDisconnected)
    this.abortSignal?.removeEventListener('abort', this.handleAbort)
    let firstError: unknown
    try {
      await this.context.close()
    } catch (error) {
      firstError = error
    }
    try {
      await this.browser.close()
    } catch (error) {
      firstError ??= error
    }
    if (firstError && !this.disconnected) {
      throw new PlaywrightEngineError(
        'BROWSER_SESSION_DISCONNECTED',
        '浏览器会话资源释放失败。',
        { component: 'browser', retryable: false, reason: 'close-failed' },
      )
    }
  }

  /**
   * 解析本次快照应使用的脱敏器。
   *
   * 优先级：当次调用注入 > 宿主构造时注入 > 按本次有效上限派生。
   * 最后一档是关键：脱敏器自身也有长度上限，若沿用会话默认实例（其上限定格于
   * 默认快照上限），调用方传入更大的 maxA11yLength 只会让脱敏器先把内容截掉，
   * 快照上限配置失效。
   *
   * @param options - 本次快照选项。
   * @returns 本次快照使用的脱敏器。
   * @throws 不抛出异常。
   */
  private resolveSnapshotRedactor(
    options?: ISnapshotOptions,
  ): ISensitiveDataRedactor {
    if (options?.redactor) return options.redactor
    if (this.injectedRedactor) return this.injectedRedactor
    if (options?.maxA11yLength === undefined) return this.redactor

    return createDefaultRedactor({
      maxLength: Math.max(1_000, options.maxA11yLength),
      // 关键：派生实例必须继承会话脱敏器已登记的运行期秘密（v20 凭据代理），
      // 否则「填入密码后立刻做一次带自定义上限的快照」会把密码原样带出——
      // 新实例不认识那个值。这是回归测试实测捕获的缺陷。
      ...(isSecretRegistrable(this.redactor)
        ? { secrets: this.redactor.listSecrets() }
        : {}),
    })
  }

  /**
   * 执行单个等待条件。
   *
   * @param condition - 等待条件。
   * @param timeoutMs - 等待超时。
   * @returns 条件在超时前满足返回 true；Playwright 超时异常由调用方转换为 matched=false。
   * @throws 条件非法或 Playwright 操作失败时抛出底层异常。
   */
  private async runWaitCondition(
    condition: IWaitCondition,
    timeoutMs: number,
    frameId?: string,
  ): Promise<boolean> {
    switch (condition.kind) {
      case 'selector': {
        if (!condition.selector.trim()) {
          throw new PlaywrightEngineError(
            'ENGINE_CONFIGURATION_INVALID',
            '等待条件的 selector 不能为空。',
            {
              component: 'browser',
              retryable: false,
              reason: 'empty-selector',
            },
          )
        }
        const frame = frameId ? this.resolveWaitFrame(frameId) : null
        await (frame ?? this.page)
          .locator(condition.selector)
          .first()
          .waitFor({ state: condition.state ?? 'visible', timeout: timeoutMs })
        return true
      }
      case 'loadState':
        await this.page.waitForLoadState(condition.state, {
          timeout: timeoutMs,
        })
        return true
      case 'url':
        await this.page.waitForURL(condition.pattern, { timeout: timeoutMs })
        return true
      case 'timeout':
        // 显式固定等待：工具描述中已标注不推荐，仅作为无法表达条件时的兜底。
        const frame = frameId ? this.resolveWaitFrame(frameId) : null
        if (frame) { await frame.waitForTimeout(condition.ms) } else { await this.page.waitForTimeout(condition.ms) }
        return true
      default:
        throw new PlaywrightEngineError(
          'ENGINE_CONFIGURATION_INVALID',
          '等待条件类型不受支持。',
          {
            component: 'browser',
            retryable: false,
            reason: `unsupported-condition:${(condition as { kind?: string }).kind ?? 'unknown'}`,
          },
        )
    }
  }

  /**
   * 根据可选 frameId 解析目标 locator 所在的作用域。
   *
   * @param selector - CSS / Playwright selector。
   * @param frameId - 可选 frame 句柄；缺省时返回主文档 locator。
   * @returns 可用于 click / fill / selectOption 的 Playwright locator。
   * @throws FRAME_NOT_FOUND / FRAME_ACCESS_BLOCKED 由 resolveOperableFrame 抛出。
   */
  private resolveActionLocator(selector: string, frameId?: string): ReturnType<Page['locator']> {
    if (!frameId) return this.page.locator(selector)
    const frame = resolveOperableFrame(this.page, this.frameRegistry, frameId, this.baseUrl)
    return frame.locator(selector)
  }

  /**
   * 根据可选 frameId 解析等待条件的目标 Frame。
   *
   * @param frameId - 可选 frame 句柄；缺省时返回 null（使用主 Page）。
   * @returns 目标 Frame 或 null。
   * @throws FRAME_NOT_FOUND / FRAME_ACCESS_BLOCKED 由 resolveOperableFrame 抛出。
   */
  private resolveWaitFrame(frameId?: string): Frame | null {
    if (!frameId) return null
    return resolveOperableFrame(this.page, this.frameRegistry, frameId, this.baseUrl)
  }

  /**
   * 把可选操作超时转换为 Playwright click/selectOption 的选项。
   *
   * @param options - 可选操作超时。
   * @returns 含 timeout 的选项对象；未指定时返回空对象以沿用页面默认超时。
   * @throws 不抛出异常。
   */
  private toActionTimeout(options?: IActionOptions): { timeout?: number } {
    return options?.timeoutMs === undefined
      ? {}
      : { timeout: options.timeoutMs }
  }

  /**
   * 解析等待超时，未指定时沿用会话导航超时。
   *
   * @param options - 可选等待超时。
   * @returns 有效的等待超时（毫秒）。
   * @throws 不抛出异常；非法值由 Playwright 自行处理。
   */
  private toWaitTimeout(options?: IWaitOptions): number {
    return options?.timeoutMs ?? this.navigationTimeoutMs
  }

  /**
   * 检查会话是否仍可使用。
   *
   * @returns 会话可用时无返回值。
   * @throws 取消、断连或已关闭时抛出结构化错误。
   */
  private assertUsable(): void {
    if (this.abortSignal?.aborted) {
      throw new PlaywrightEngineError(
        'PAGE_ACCESS_FAILED',
        '浏览器页面操作已取消。',
        { component: 'browser', retryable: false, reason: 'cancelled' },
      )
    }
    if (this.disconnected) {
      throw new PlaywrightEngineError(
        'BROWSER_SESSION_DISCONNECTED',
        '浏览器会话已断开。',
        {
          component: 'browser',
          retryable: true,
          reason: 'browser-disconnected',
        },
      )
    }
  }

  /**
   * 将 Playwright 异常映射到脱敏 Engine 错误。
   *
   * @param error - Playwright 或未知异常。
   * @param code - 目标错误码（取引擎错误码全集，由调用方选择语义合适的值）。
   * @param message - 用户可读的默认消息。
   * @param extraDetails - 额外错误详情（如等待耗时的 durationMs）。
   * @returns 结构化页面错误。
   * @throws 不抛出异常。
   */
  private toPageError(
    error: unknown,
    code: TPlaywrightEngineErrorCode,
    message: string,
    extraDetails?: { durationMs?: number },
  ): PlaywrightEngineError {
    if (this.disconnected) {
      return new PlaywrightEngineError(
        'BROWSER_SESSION_DISCONNECTED',
        '浏览器会话已断开。',
        {
          component: 'browser',
          retryable: true,
          reason: 'browser-disconnected',
        },
      )
    }
    const reason =
      error instanceof Error ? error.message.slice(0, 500) : 'playwright-error'
    return new PlaywrightEngineError(code, message, {
      component: 'browser',
      retryable: true,
      reason,
      ...(extraDetails?.durationMs === undefined
        ? {}
        : { durationMs: extraDetails.durationMs }),
    })
  }

  /**
   * 处理浏览器断连事件。
   *
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  private readonly handleDisconnected = (): void => {
    this.disconnected = true
    publishEngineEvent(this.eventSink, {
      type: 'browser.disconnected',
      sessionId: this.id,
    })
  }

  /**
   * 处理外部取消信号并尽快释放浏览器资源。
   *
   * @returns 无返回值。
   * @throws close 失败由异步 Promise 吞掉，避免未处理 rejection。
   */
  private readonly handleAbort = (): void => {
    void this.close().catch(() => undefined)
  }

  /**
   * 发布页面错误事件。
   *
   * @param error - 待发布的 Engine 错误。
   * @returns 无返回值。
   * @throws 不抛出事件 sink 异常。
   */
  private publishError(error: PlaywrightEngineError): void {
    publishEngineEvent(this.eventSink, {
      type: 'engine.error',
      code: error.code,
      message: error.message,
    })
  }
}

/**
 * 把凭据解析失败原因翻译成面向模型的修复指引。
 *
 * 文案约束：只出现 env key 名（不是秘密），并明确指出**下一步该做什么**——
 * 失败原因会作为工具结果进入模型上下文，含糊的描述会让模型反复重试同一引用。
 *
 * @param reason - 稳定失败分类。
 * @param key - 引用中的 env key。
 * @returns 面向模型的中文说明。
 * @throws 不抛出异常。
 */
function describeCredentialFailure(
  reason: 'resolver-unavailable' | 'not-found' | 'unavailable' | 'empty',
  key: string,
): string {
  switch (reason) {
    case 'resolver-unavailable':
      return `当前会话未启用凭据引用能力，无法解析 \${ENV:${key}}。请改用页面核对确认登录方式，或在说明中披露该断点。`
    case 'not-found':
      return `env.json 中不存在 key "${key}"，无法完成填入。请核对该引用是否与用例中声明的 key 一致；如确实缺失，请在 Skill 的 env.json 中补充该 key。`
    case 'unavailable':
      return `env.json 当前不可读或格式非法，无法解析 \${ENV:${key}}。请先修复该文件后重试。`
    case 'empty':
      return `env.json 中 key "${key}" 的值为空，填入空值没有意义。请为其填写真实值后重试。`
  }
}

/**
 * 保留查询默认上限的公共只读配置。
 */
export const browserSessionDefaults = {
  queryLimit: DEFAULT_QUERY_LIMIT,
} as const
