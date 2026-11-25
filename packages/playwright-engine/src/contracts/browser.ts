/**
 * 定义浏览器会话实现侧契约：会话创建选项、凭据解析端口、iframe 访问策略与会话工厂。
 *
 * 会话的共享契约（IBrowserSession 及其签名涉及的全部数据类型）已迁移至
 * @authine-e2e-agent/types，此处再导出以保持引擎公共 API 不变；
 * agent 包从共享类型包导入这些契约，与引擎互不依赖。
 */

import type { BrowserContext } from 'playwright'
import type { IEngineEventSink } from './events'
import type { INetworkPolicy } from './network'
import type {
  IBrowserSession,
  ISensitiveDataRedactor,
} from '@authine-e2e-agent/types'

// 共享契约再导出：符号的真实定义在 @authine-e2e-agent/types
export type {
  IBrowserSession,
  IPageSnapshotRef,
  IPageSnapshot,
  IPageScreenshot,
  ICandidateLocator,
  IElementInfo,
  IFrameId,
  IFrameInfo,
  IFrameInventory,
  IFrameListOptions,
  IFrameTargetOptions,
  IFrameSnapshotSource,
  ISnapshotOptions,
  IScreenshotOptions,
  IFullContentScreenshotOptions,
  IActionOptions,
  IActionResult,
  IWaitCondition,
  IWaitOptions,
  IWaitResult,
} from '@authine-e2e-agent/types'

/**
 * 浏览器会话创建选项。
 */
export interface IBrowserSessionOptions {
  headed?: boolean
  baseUrl: string
  timeoutMs?: number
  navigationTimeoutMs?: number
  networkPolicy?: INetworkPolicy
  signal?: AbortSignal
  eventSink?: IEngineEventSink
  redactor?: ISensitiveDataRedactor
  /**
   * 凭据解析器（v20 凭据代理）。
   *
   * 提供后，`fill` 允许把值写成 `${ENV:KEY}` 引用形态：引擎在**填入的最后一刻**
   * 调用本端口换取真值，模型与其上下文全程只见到引用本身。
   * 缺省时 `fill` 只接受字面量，遇到引用形态直接报错，不静默填入占位符。
   */
  credentialResolver?: ICredentialResolver
}

/**
 * 凭据解析端口（v20 凭据代理）。
 *
 * 依赖倒转：引擎不认识 env.json，也不该认识——它只声明「给定引用，返回可填入的值」，
 * 由宿主（service 层）负责读文件、查表与失败归类。
 * 这样「敏感值的读取位置」仍然收敛在服务层一处，与执行链路既有约定一致。
 */
export interface ICredentialResolver {
  /**
   * 解析一个 `${ENV:KEY}` 引用为可填入页面的真实值。
   *
   * @param key - 引用中的 env key（已由引擎校验为合法形态）。
   * @returns 解析结果：成功时携带真值，失败时携带可直接展示给模型的稳定原因。
   * @throws 不抛出异常——解析失败以 `{ ok: false }` 表达，避免异常携带秘密值。
   */
  resolve(key: string): Promise<ICredentialResolution>
}

/** 凭据解析结果。 */
export type ICredentialResolution =
  | { ok: true; value: string }
  | { ok: false; reason: TCredentialFailureReason }

/**
 * 凭据解析失败原因。
 *
 * 全部为「不含秘密值的稳定分类」，可直接进入模型上下文与事件流：
 *   - `not-found`：env.json 中没有该 key；
 *   - `unavailable`：env.json 缺失或格式非法；
 *   - `empty`：key 存在但值为空串（填入空值没有意义，明确报错优于静默通过）。
 */
export type TCredentialFailureReason = 'not-found' | 'unavailable' | 'empty'

/**
 * iframe 访问策略。
 *
 * 默认 same-origin-only：只允许操作与 baseUrl 同源的 frame。
 * allowlist / all 必须由宿主显式注入，模型不能修改。
 */
export interface IFrameAccessPolicy {
  mode: 'same-origin-only' | 'allowlist' | 'all'
  allowedOrigins?: readonly string[]
}

/**
 * 浏览器会话工厂。
 */
export interface IBrowserSessionFactory {
  /**
   * 创建并初始化浏览器会话。
   *
   * @param options - 有头模式、Base URL、超时、网络策略和取消信号。
   * @returns 已拥有 browser/context/page 的会话。
   * @throws Chromium 不可用、启动失败或配置非法时抛出结构化错误。
   */
  create(options: IBrowserSessionOptions): Promise<IBrowserSession>
}

/**
 * 给网络策略安装路由时使用的上下文能力边界。
 * 当前实现接受真实 Playwright BrowserContext，接口单独保留便于后续适配。
 */
export type TBrowserContext = BrowserContext
