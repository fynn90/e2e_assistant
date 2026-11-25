/** 定义 Playwright Engine 的事件契约和事件发布辅助函数。 */

import type { TPlaywrightEngineErrorCode } from './errors'

/**
 * Engine 向宿主发布的标准运行事件。
 */
export type TEngineEvent =
  | { type: 'browser.started'; sessionId: string; headed: boolean }
  | { type: 'browser.navigation'; sessionId: string; url: string }
  | { type: 'browser.snapshot'; sessionId: string; truncated: boolean }
  | {
      /**
       * 页面写操作完成。
       *
       * `fill` 事件**只带 selector 与是否使用了凭据引用**，绝不携带填入的值——
       * 该值可能是从 env.json 解析出的真实密码。`redacted` 为 true 表示
       * 本次填入的是 `${ENV:KEY}` 引用，供前端区分「填入凭据」与「填入普通文本」。
       */
      type: 'browser.action'
      sessionId: string
      action: 'click' | 'select' | 'fill'
      selector: string
      /** 操作目标是 iframe 时携带目标 frameId。 */
      frameId?: string
      redacted?: boolean
    }
  | {
      type: 'browser.wait'
      sessionId: string
      matched: boolean
      elapsedMs: number
    }
  /**
   * 完整内容截图完成（v12）。
   *
   * 只发布「发生了完整内容捕获」这一事实，**不携带图片字节**——图片本体不适合进事件流
   * （会经脱敏器替换二进制字段，也会拖累事件总线与断线续传缓冲）。
   */
  | { type: 'browser.screenshot'; sessionId: string; fullContent: boolean }
  /** frame 清单枚举完成。 */
  | { type: 'browser.frames'; sessionId: string; frameCount: number; truncated: boolean }
  | { type: 'browser.disconnected'; sessionId: string }
  | { type: 'network.blocked'; url: string; resourceType: string }
  | { type: 'dry-run.started'; workspaceId: string }
  | { type: 'dry-run.output'; message: string }
  | { type: 'dry-run.finished'; status: 'passed' | 'failed' | 'skipped' }
  | { type: 'process.cancelled'; component: string }
  | { type: 'engine.error'; code: TPlaywrightEngineErrorCode; message: string }

/**
 * 接收 Engine 事件的宿主适配器。
 */
export interface IEngineEventSink {
  /**
   * 发布一个已经完成敏感信息处理的事件。
   *
   * @param event - Engine 事件。
   * @returns 同步完成或异步完成的发布结果。
   * @throws 宿主事件总线失败时可抛出异常，Engine 业务流程不应依赖该异常完成。
   */
  publish(event: TEngineEvent): void | Promise<void>
}

/**
 * 创建忽略事件的默认 sink，供未配置宿主事件总线的调用方使用。
 *
 * @returns 不产生任何副作用的事件 sink。
 * @throws 不抛出异常。
 */
export function createNoopEventSink(): IEngineEventSink {
  return {
    publish: () => undefined,
  }
}

/**
 * 尝试发布事件并隔离宿主事件总线异常，避免观测失败破坏浏览器能力。
 *
 * @param sink - 可选事件 sink。
 * @param event - 待发布的 Engine 事件。
 * @returns 不等待异步事件总线完成的 void。
 * @throws 不抛出宿主 sink 异常。
 */
export function publishEngineEvent(
  sink: IEngineEventSink | undefined,
  event: TEngineEvent,
): void {
  if (!sink) {
    return
  }

  try {
    const result = sink.publish(event)
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch(() => undefined)
    }
  } catch {
    // 观测通道是旁路能力，不能阻断浏览器或安装器主流程。
  }
}
