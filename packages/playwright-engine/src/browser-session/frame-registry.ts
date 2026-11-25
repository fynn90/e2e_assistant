/**
 * FrameRegistry：维护 Playwright Frame 与 Engine 内部 frameId 的映射。
 *
 * frameId 是会话内的短生命周期句柄——页面导航或 frame detach 后立即失效。
 * Agent 通过 listFrames() 获取最新清单，再把 frameId 传给后续工具，
 * Engine 据此定位对应的 Playwright Frame 对象执行操作。
 *
 * 只使用 WeakMap 存储 Frame → ID 映射：不持有 Frame 的强引用，
 * detach 后 Frame 可正常被 GC；resolve 时从 page.frames() 实时查找，
 * 天然只返回当前 attached 的 Frame。
 */

import { randomUUID } from 'node:crypto'
import type { Frame, Page } from 'playwright'

/** Frame 与 frameId 的单向映射。 */
export class FrameRegistry {
  /** Frame → frameId；WeakMap 避免阻止已 detach 的 Frame 被 GC。 */
  private readonly idByFrame = new WeakMap<Frame, string>()

  /**
   * 返回 Frame 对应的 frameId；首次遇到时分配新 ID。
   *
   * @param frame - Playwright Frame 对象（含主文档）。
   * @returns 会话内唯一的 frameId 字符串。
   * @throws 不抛出异常。
   */
  identify(frame: Frame): string {
    const existing = this.idByFrame.get(frame)
    if (existing) return existing

    const id = `frame_${randomUUID().slice(0, 8)}`
    this.idByFrame.set(frame, id)
    return id
  }

  /**
   * 在当前 Page 的活跃 Frame 列表中查找 frameId 对应的 Frame。
   *
   * 每次调用都从 page.frames() 重新枚举，确保只在 attached 的 Frame 上操作；
   * 已 detach 的 Frame 即使对象尚未被 GC 也无法被命中。
   *
   * @param page - 当前 Playwright Page。
   * @param frameId - Engine 分配的 frame 句柄。
   * @returns 对应的 Frame 对象；未命中或已 detach 时返回 undefined。
   * @throws 不抛出异常。
   */
  resolve(page: Page, frameId: string): Frame | undefined {
    return page.frames().find((frame) => this.idByFrame.get(frame) === frameId)
  }

  /**
   * 清空映射；navigate 后调用。WeakMap 条目随 Frame GC 自然清除。
   *
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  clear(): void {
    // WeakMap 无法手动清空，此方法保留 API 完整性。
  }
}
