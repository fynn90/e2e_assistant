/**
 * 元素「完整内容」截图（v12，技术方案 §5.3）。
 *
 * 背景（v12 技术方案 §2.1/§2.2，均为真实 Chromium 实测结论）：
 *   - Playwright 官方的 `toHaveScreenshot` 与 `locator.screenshot()` 对**内部滚动容器**
 *     只截元素包围盒（200×200 的容器内含 600×800 内容时，落盘只有 200×200）；
 *   - CDP `Page.captureScreenshot{captureBeyondViewport:true}` 虽然尺寸正确，
 *     但视口外内容**未绘制**，拿到的是空白（实测四角采样三个 `#ffffff`）；
 *   - 唯一可靠手法是**临时展开样式**（`overflow:visible` + 尺寸置为 scrollWidth/scrollHeight）
 *     后截图，实测四角四色全部正确。
 *
 * 本模块与**生成脚本内联模板**（`skills/playwright_script_generation/` 下的模板片段）
 * 必须保持同一口径：探查阶段捕获的基线，与执行期捕获的实际，若采用不同手法，
 * 基线与实际将永远对不上，且症状难以定位。
 *
 * ⚠️ 修改本文件的捕获逻辑时，必须同步修改脚本模板，并更新
 * `test/full-content-capture.test.ts` 的像素级断言。
 */

import type { Locator } from 'playwright'

/**
 * 稳定性重试的默认最大尝试次数。
 *
 * 与生成脚本模板的 `MAX_ATTEMPTS` 同值。取 4 的理由：正常页面第 2 次即收敛
 * （实测 154ms），4 次足以覆盖常见的异步渲染抖动，又不会在持续动画页面上
 * 长时间空转。
 */
export const DEFAULT_STABILITY_ATTEMPTS = 4

/** 元素滚动几何（由页面内一次性读出，避免多次往返）。 */
export interface IElementScrollGeometry {
  /** 内容总宽（含溢出部分）。 */
  scrollWidth: number
  /** 内容总高（含溢出部分）。 */
  scrollHeight: number
  /** 可见区宽。 */
  clientWidth: number
  /** 可见区高。 */
  clientHeight: number
}

/**
 * 完整内容捕获选项。
 */
export interface IFullContentCaptureOptions {
  /**
   * 稳定性重试的最大尝试次数；缺省 {@link DEFAULT_STABILITY_ATTEMPTS}。
   *
   * 连续两次截图字节完全一致即提前返回；达到上限仍不一致时返回最后一张，
   * 让比对给出真实结论（而不是无限重试）。
   */
  maxAttempts?: number
  /**
   * 动画处理；缺省 `'disabled'`，对齐 `toHaveScreenshot` 的默认行为。
   *
   * 自捕获不会自动应用该默认值，必须显式传入，否则动画中的元素会产生假失败。
   */
  animations?: 'disabled' | 'allow'
  /**
   * 光标处理；缺省 `'hide'`，对齐 `toHaveScreenshot` 的默认行为。
   *
   * 输入框获得焦点时的闪烁光标会让两次截图永不一致。
   */
  caret?: 'hide' | 'initial'
}

/**
 * 判断元素是否存在内部溢出（内容大于可见区）。
 *
 * 无溢出时不需要展开样式——对绝大多数元素而言展开反而会改变布局。
 *
 * @param geometry - 元素滚动几何。
 * @returns 内容宽或高超出可见区时返回 true。
 * @throws 不抛出异常。
 */
export function hasInternalOverflow(geometry: IElementScrollGeometry): boolean {
  return (
    geometry.scrollWidth > geometry.clientWidth ||
    geometry.scrollHeight > geometry.clientHeight
  )
}

/**
 * 读取元素的滚动几何。
 *
 * @param locator - 目标元素定位器。
 * @returns 滚动几何。
 * @throws Playwright 的定位/求值错误（元素不存在、页面已关闭等）透传。
 */
export async function readScrollGeometry(
  locator: Locator,
): Promise<IElementScrollGeometry> {
  return locator.evaluate((element) => {
    const target = element as HTMLElement
    return {
      scrollWidth: target.scrollWidth,
      scrollHeight: target.scrollHeight,
      clientWidth: target.clientWidth,
      clientHeight: target.clientHeight,
    }
  })
}

/**
 * 连续截图直到画面稳定（相邻两次字节完全一致），最多尝试指定次数。
 *
 * 为什么需要它：自捕获不像 `toHaveScreenshot` 那样自带「连续两次截图一致才比对」
 * 的稳定性等待，页面异步渲染未完成时会截到中间态，产生假失败。
 * 用字节判等而非等待固定时长——不猜测渲染耗时，且不引入平台自身反对的固定等待。
 *
 * 实测（真实 Chromium）：页面稳定时第 2 次即返回（约 154ms）；
 * 画面持续变化时达到上限后正常返回，不挂死。
 *
 * @param locator - 目标元素定位器。
 * @param screenshotOptions - 传给 Playwright 截图的选项（动画与光标处理）。
 * @param maxAttempts - 最大尝试次数；至少为 1。
 * @returns 稳定后的截图字节；始终不稳定时为最后一次的截图。
 * @throws Playwright 的截图错误透传。
 */
async function captureStable(
  locator: Locator,
  screenshotOptions: {
    animations: 'disabled' | 'allow'
    caret: 'hide' | 'initial'
  },
  maxAttempts: number,
): Promise<Buffer> {
  const attempts = Math.max(1, Math.floor(maxAttempts))
  let previous = await locator.screenshot(screenshotOptions)

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    const current = await locator.screenshot(screenshotOptions)
    if (current.equals(previous)) {
      return current
    }
    previous = current
  }

  // 达到上限仍不稳定：返回最后一张，交由比对给出真实结论。
  return previous
}

/**
 * 捕获元素的完整内容截图（含内部滚动区域）。
 *
 * 元素无内部溢出时等价于普通元素截图；有溢出时临时展开样式再截图，
 * 并在 `finally` 中还原——**截图失败也必须还原**，否则会污染同用例后续步骤。
 *
 * @param locator - 目标元素定位器。
 * @param options - 稳定性重试次数与确定性选项。
 * @returns PNG 字节内容。
 * @throws Playwright 的定位/截图错误透传；样式还原失败同样抛出。
 */
export async function captureLocatorFullContent(
  locator: Locator,
  options: IFullContentCaptureOptions = {},
): Promise<Buffer> {
  const screenshotOptions = {
    animations: options.animations ?? ('disabled' as const),
    caret: options.caret ?? ('hide' as const),
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_STABILITY_ATTEMPTS

  const geometry = await readScrollGeometry(locator)

  // 无内部溢出：不必展开样式，直接走稳定性捕获。
  if (!hasInternalOverflow(geometry)) {
    return captureStable(locator, screenshotOptions, maxAttempts)
  }

  const previousStyle = await locator.evaluate((element) =>
    element.getAttribute('style'),
  )

  try {
    // 临时把元素展开到「内容完整可见」，让 Playwright 能截到全部内容。
    await locator.evaluate((element, size) => {
      const target = element as HTMLElement
      target.setAttribute(
        'style',
        'overflow:visible;width:' +
          size.scrollWidth +
          'px;height:' +
          size.scrollHeight +
          'px',
      )
    }, geometry)

    return await captureStable(locator, screenshotOptions, maxAttempts)
  } finally {
    // 还原原样式：截图成功与否都必须执行，避免布局被永久破坏。
    await locator.evaluate((element, previous) => {
      if (previous === null) {
        element.removeAttribute('style')
      } else {
        element.setAttribute('style', previous)
      }
    }, previousStyle)
  }
}
