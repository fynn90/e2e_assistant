/**
 * 在指定 Playwright Frame 内采集有界的可访问性树和候选定位器。
 *
 * 与 page-snapshot.ts 的 `createPageSnapshot()` 保持同一套脱敏、截断和
 * 候选定位器收集逻辑，只是执行上下文从 Page 切换为目标 Frame。
 * 返回值通过 `frame` 字段标记来源，便于 Agent 区分主文档与 iframe 快照。
 */

import type { Frame } from 'playwright'
import type {
  ICandidateLocator,
  IFrameSnapshotSource,
  IPageSnapshot,
  ISnapshotOptions,
} from '../contracts/browser'
import type { ISensitiveDataRedactor } from '../contracts/observability'

const DEFAULT_MAX_A11Y_LENGTH = 240_000
const DEFAULT_MAX_LOCATORS = 100
const CANDIDATE_SELECTOR =
  'button, input, textarea, select, a, [role], [data-testid]'

/**
 * 从 Frame 生成供 Agent 使用的结构化快照。
 *
 * @param frame - Playwright Frame 对象（目标 iframe）。
 * @param frameSource - frame 来源信息（frameId / url / title），用于标记返回值。
 * @param options - 快照文本、候选定位器上限和可选脱敏器。
 * @returns 包含 frame 来源的页面快照结构。
 * @throws 页面关闭、脚本执行失败或 Playwright 访问失败时抛出底层异常。
 */
export async function createFrameSnapshot(
  frame: Frame,
  frameSource: IFrameSnapshotSource,
  options: ISnapshotOptions = {},
): Promise<IPageSnapshot> {
  const maxA11yLength = Math.max(
    1_000,
    options.maxA11yLength ?? DEFAULT_MAX_A11Y_LENGTH,
  )
  const maxLocators = Math.max(1, options.maxLocators ?? DEFAULT_MAX_LOCATORS)
  const redactor =
    options.redactor ??
    (await import('../observability/redaction')).createDefaultRedactor({
      maxLength: maxA11yLength,
    })

  const a11yTree = await frame
    .locator('body')
    .ariaSnapshot()
    .catch(() => '')

  const candidateLocator = frame.locator(CANDIDATE_SELECTOR)
  const candidateCount = await candidateLocator.count()
  const locators = await collectCandidateLocators(candidateLocator, maxLocators)
  const redactedA11yTree = redactor.redact(a11yTree)

  return {
    url: frameSource.url,
    title: frameSource.title ?? '',
    frame: frameSource,
    a11yTree:
      redactedA11yTree.length > maxA11yLength
        ? `${redactedA11yTree.slice(0, maxA11yLength)}\n[内容已截断]`
        : redactedA11yTree,
    candidateLocators: locators.map((locator) =>
      redactLocator(locator, redactor),
    ),
    truncated:
      redactedA11yTree.length > maxA11yLength || candidateCount > maxLocators,
    capturedAt: new Date().toISOString(),
  }
}

/**
 * 收集 Frame 中可解释的交互元素定位信息。
 *
 * @param locator - 候选元素的 Playwright locator。
 * @param maxLocators - 最多转换的候选数量。
 * @returns 有界的候选定位器列表。
 * @throws 页面关闭或 evaluateAll 失败时抛出底层异常。
 */
async function collectCandidateLocators(
  locator: ReturnType<Frame['locator']>,
  maxLocators: number,
): Promise<ICandidateLocator[]> {
  return locator.evaluateAll((elements, limit) => {
    return elements.slice(0, limit).map((element) => {
      const htmlElement = element as HTMLElement
      const role = htmlElement.getAttribute('role') ?? undefined
      const name = htmlElement.getAttribute('aria-label') ?? undefined
      const input = htmlElement as HTMLInputElement
      const label =
        input.labels?.[0]?.textContent?.trim().slice(0, 240) || undefined
      const placeholder = htmlElement.getAttribute('placeholder') ?? undefined
      const testId = htmlElement.getAttribute('data-testid') ?? undefined
      const text =
        (htmlElement.textContent ?? '').trim().slice(0, 240) || undefined
      const tagName = htmlElement.tagName.toLowerCase()
      const escapedTestId = testId?.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

      return {
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        ...(label ? { label } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(testId ? { testId } : {}),
        ...(text ? { text } : {}),
        ...(escapedTestId ? { css: `[data-testid="${escapedTestId}"]` } : {}),
        confidence: testId || name || label || placeholder ? 0.95 : 0.65,
        ...(tagName === 'button' ? { role: role ?? 'button' } : {}),
      }
    })
  }, maxLocators)
}

/**
 * 对候选定位器的可见文本和属性执行脱敏。
 *
 * @param locator - 页面候选定位器。
 * @param redactor - 宿主注入的脱敏器。
 * @returns 不包含已知秘密的候选定位器。
 * @throws 脱敏器异常由调用方的实现处理。
 */
function redactLocator(
  locator: ICandidateLocator,
  redactor: ISensitiveDataRedactor,
): ICandidateLocator {
  return Object.fromEntries(
    Object.entries(locator).map(([key, value]) => [
      key,
      typeof value === 'string' ? redactor.redact(value) : value,
    ]),
  ) as ICandidateLocator
}
