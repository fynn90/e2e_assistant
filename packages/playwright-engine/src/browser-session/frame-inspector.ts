/**
 * FrameInspector：读取 Playwright Frame 的元数据，生成 iframe 定位链。
 *
 * 从主文档开始递归遍历所有子 frame，为每个 Frame 收集：
 *   - frameId（由 FrameRegistry 分配）
 *   - URL / name / title / origin / sameOrigin
 *   - 可见性与尺寸（通过 frameElement 读取）
 *   - locatorChain（从主文档到当前 frame 的 iframe selector 序列）
 *
 * locatorChain 供生成的 Playwright 脚本使用 page.frameLocator() 链式进入；
 * 生成优先级：data-testid > stable id > name > title > aria-label > nth 兜底。
 */

import { randomUUID } from 'node:crypto'
import type { ElementHandle, Frame, Page } from 'playwright'
import {
  PlaywrightEngineError,
} from '../contracts/errors'
import type {
  IFrameInfo,
  IFrameInventory,
} from '../contracts/browser'
import type { ISensitiveDataRedactor } from '../contracts/observability'
import type { FrameRegistry } from './frame-registry'

/** frame 清单默认数量上限；防止 iframe 爆炸导致输出失控。 */
export const DEFAULT_MAX_FRAMES = 50

/** 在父 frame 文档中执行的回调返回值：描述一个 iframe 宿主元素的最小属性。 */
interface IFrameElementDescriptor {
  tagName: string
  id: string
  name: string
  title: string
  ariaLabel: string
  dataTestId: string
  src: string
  siblingIndex: number
  visible: boolean
  width: number
  height: number
}

/**
 * 把特殊字符转义为 CSS attribute selector 安全值。
 *
 * @param value - 原始属性值。
 * @returns 可安全放入 [attr="..."] 的转义文本。
 * @throws 不抛出异常。
 */
function escapeCssValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 根据宿主元素属性生成稳定的 iframe selector。
 *
 * @param descriptor - 从父文档读取的 iframe 元素属性。
 * @returns 一个可被 Playwright locator 解析的 selector 字符串。
 * @throws 不抛出异常。
 */
function buildFrameSelector(descriptor: IFrameElementDescriptor): string {
  const tag = descriptor.tagName || 'iframe'

  if (descriptor.dataTestId) {
    return `[data-testid="${escapeCssValue(descriptor.dataTestId)}"]`
  }
  if (descriptor.id) {
    return `#${descriptor.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
  }
  if (descriptor.name) {
    return `${tag}[name="${escapeCssValue(descriptor.name)}"]`
  }
  if (descriptor.title) {
    return `${tag}[title="${escapeCssValue(descriptor.title)}"]`
  }
  if (descriptor.ariaLabel) {
    return `${tag}[aria-label="${escapeCssValue(descriptor.ariaLabel)}"]`
  }
  // 兜底：同类元素中的位置索引。稳定性较弱，Skill 层会据此提示。
  return `${tag} >> nth=${descriptor.siblingIndex}`
}

/**
 * 读取一个 iframe 宿主元素在父文档中的属性。
 *
 * 回调在浏览器上下文中运行，只返回可序列化的基础类型。
 *
 * @param element - Playwright ElementHandle 指向父文档中的 iframe 元素。
 * @returns 描述该 iframe 元素的最小属性集合。
 * @throws 页面关闭或脚本执行失败时抛出底层异常。
 */
async function inspectFrameElement(
  element: ElementHandle,
): Promise<IFrameElementDescriptor> {
  return element.evaluate((node) => {
    const el = node as HTMLElement
    const parent = el.parentElement
    const siblings = parent
      ? Array.from(parent.children).filter(
          (child) => (child as HTMLElement).tagName === el.tagName,
        )
      : [el]

    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id ?? '',
      name: el.getAttribute('name') ?? '',
      title: el.getAttribute('title') ?? '',
      ariaLabel: el.getAttribute('aria-label') ?? '',
      dataTestId: el.getAttribute('data-testid') ?? '',
      src: el.getAttribute('src') ?? '',
      siblingIndex: Math.max(0, siblings.indexOf(el)),
      visible: el.offsetParent !== null,
      width: el.offsetWidth,
      height: el.offsetHeight,
    }
  })
}

/**
 * 递归构建从主文档到目标 Frame 的 iframe selector 链。
 *
 * 主文档返回空数组；每往下一层，调用 frame.frameElement() 获取
 * 父文档中的宿主元素并生成一个 selector，直到根。
 *
 * @param frame - 目标 Playwright Frame。
 * @returns 从外层到内层的 iframe selector 列表；主文档为 []。
 * @throws frameElement() 失败或页面关闭时抛出底层异常。
 */
async function buildLocatorChain(frame: Frame): Promise<string[]> {
  if (!frame.parentFrame()) return []

  const parentChain = await buildLocatorChain(frame.parentFrame()!)
  const elementHandle = await frame.frameElement()
  try {
    const descriptor = await inspectFrameElement(elementHandle)
    return [...parentChain, buildFrameSelector(descriptor)]
  } finally {
    await elementHandle.dispose()
  }
}

/**
 * 枚举当前 Page 的所有 Frame，生成有界的元数据清单。
 *
 * @param page - 当前 Playwright Page。
 * @param registry - FrameRegistry，用于分配和查找 frameId。
 * @param redactor - 脱敏 URL / title 等文本字段。
 * @param options - 可选的 maxFrames 和 includeHidden。
 * @returns 包含主文档与子 frame 的清单；超出上限时 truncated=true。
 * @throws 页面关闭时抛出底层异常。
 */
export async function inspectFrameInventory(
  page: Page,
  registry: FrameRegistry,
  redactor: ISensitiveDataRedactor,
  options?: { includeHidden?: boolean; maxFrames?: number },
): Promise<IFrameInventory> {
  const maxFrames = Math.max(1, options?.maxFrames ?? DEFAULT_MAX_FRAMES)
  const allFrames = page.frames()
  const frames: IFrameInfo[] = []

  for (const frame of allFrames) {
    if (frames.length >= maxFrames) break

    const frameId = registry.identify(frame)
    const parentFrame = frame.parentFrame()
    const parentFrameId = parentFrame ? registry.identify(parentFrame) : null
    const origin = safeOrigin(frame.url())
    const pageOrigin = safeOrigin(page.url())
    const sameOrigin =
      origin !== '' && pageOrigin !== '' && origin === pageOrigin

    let visible = true
    let width = 0
    let height = 0
    let locatorChain: string[] = []

    if (parentFrame) {
      try {
        const elementHandle = await frame.frameElement()
        const descriptor = await inspectFrameElement(elementHandle)
        visible = descriptor.visible
        width = descriptor.width
        height = descriptor.height
        locatorChain = await buildLocatorChain(frame)
        await elementHandle.dispose()
      } catch {
        // frameElement() 可能因 iframe 刚 detach 而失败；保留默认值即可。
      }
    }

    if (!options?.includeHidden && !visible && parentFrame) continue

    frames.push({
      frameId,
      parentFrameId,
      name: redactor.redact(frame.name() || '(main)'),
      url: redactor.redact(frame.url()),
      title: redactor.redact(await frame.title().catch(() => '')),
      origin: redactor.redact(origin),
      sameOrigin,
      depth: locatorChain.length,
      visible,
      width,
      height,
      locatorChain,
      operationAllowed: sameOrigin,
      ...(!sameOrigin
        ? { blockedReason: 'cross-origin-disabled' as const }
        : {}),
    })
  }

  return {
    mainFrameId: registry.identify(page.mainFrame()),
    frames,
    truncated: allFrames.length > maxFrames,
    capturedAt: new Date().toISOString(),
  }
}

/**
 * 校验 frameId 是否指向当前 attached 且同源可操作的 Frame。
 *
 * @param page - 当前 Playwright Page。
 * @param registry - FrameRegistry。
 * @param frameId - Engine 分配的 frame 句柄。
 * @param baseUrl - 会话基准 URL（用于同源判定）。
 * @returns 校验通过的 Playwright Frame。
 * @throws FRAME_NOT_FOUND：frameId 非法或 Frame 已 detach。
 * @throws FRAME_ACCESS_BLOCKED：Frame 是跨源且当前策略禁止操作。
 */
export function resolveOperableFrame(
  page: Page,
  registry: FrameRegistry,
  frameId: string,
  baseUrl: string,
): Frame {
  const frame = registry.resolve(page, frameId)
  if (!frame) {
    throw new PlaywrightEngineError(
      'FRAME_NOT_FOUND',
      `frameId "${frameId}" 无效或已过期，请重新调用 listFrames() 获取最新清单。`,
      { component: 'browser', retryable: false, reason: 'stale-frame-id' },
    )
  }

  const frameOrigin = safeOrigin(frame.url())
  const baseOrigin = safeOrigin(baseUrl)

  if (frameOrigin && baseOrigin && frameOrigin !== baseOrigin) {
    throw new PlaywrightEngineError(
      'FRAME_ACCESS_BLOCKED',
      `跨源 iframe（origin: ${frameOrigin}）当前策略禁止操作。请在任务配置中显式允许该 origin。`,
      { component: 'browser', retryable: false, reason: 'cross-origin-disabled' },
    )
  }

  return frame
}

/**
 * 安全解析 URL 的 origin，无法解析时返回空串。
 *
 * @param url - 原始 URL 字符串。
 * @returns origin 字符串；解析失败返回 ''。
 * @throws 不抛出异常。
 */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
