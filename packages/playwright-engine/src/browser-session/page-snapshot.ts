/** 将 Playwright 页面压缩为有界且脱敏的可访问性树和候选定位器快照。 */

import type { Page } from 'playwright'
import type {
  ICandidateLocator,
  IPageSnapshot,
  ISnapshotOptions,
} from '../contracts/browser'
import type { ISensitiveDataRedactor } from '../contracts/observability'
import { createDefaultRedactor } from '../observability/redaction'

const DEFAULT_MAX_A11Y_LENGTH = 240_000
const DEFAULT_MAX_LOCATORS = 100
const CANDIDATE_SELECTOR =
  'button, input, textarea, select, a, [role], [data-testid]'

/**
 * 从页面生成供 Agent 使用的结构化快照。
 *
 * @param page - Playwright 页面对象，仅在 Engine 内部使用。
 * @param options - 快照文本、候选定位器上限和可选脱敏器。
 * @returns 页面 URL、标题、压缩可访问性树和候选定位器。
 * @throws 页面关闭、脚本执行失败或 Playwright 访问失败时抛出底层异常。
 */
export async function createPageSnapshot(
  page: Page,
  options: ISnapshotOptions = {},
): Promise<IPageSnapshot> {
  const maxA11yLength = Math.max(
    1_000,
    options.maxA11yLength ?? DEFAULT_MAX_A11Y_LENGTH,
  )
  const maxLocators = Math.max(1, options.maxLocators ?? DEFAULT_MAX_LOCATORS)
  const redactor =
    options.redactor ?? createDefaultRedactor({ maxLength: maxA11yLength })
  const a11yTree = await maskPasswordValues(
    page,
    await page
      .locator('body')
      .ariaSnapshot()
      .catch(() => ''),
  )
  const candidateLocator = page.locator(CANDIDATE_SELECTOR)
  const candidateCount = await candidateLocator.count()
  const locators = await collectCandidateLocators(candidateLocator, maxLocators)
  const redactedA11yTree = redactor.redact(a11yTree)

  return {
    url: redactor.redact(page.url()),
    title: redactor.redact(await page.title()),
    a11yTree:
      redactedA11yTree.length > maxA11yLength
        ? `${redactedA11yTree.slice(0, maxA11yLength)}\n[内容已截断]`
        : redactedA11yTree,
    candidateLocators: locators.map((locator) =>
      redactLocator(locator, redactor),
    ),
    // truncated 必须与上面的切片判据同源（脱敏后长度）：脱敏本身会改变长度
    // （秘密替换为 [REDACTED]、绝对路径替换为 [PATH]），按脱敏前长度判定会出现
    // 「标记已截断但输出完整」或「输出被切但未标记」的不一致。
    truncated:
      redactedA11yTree.length > maxA11yLength || candidateCount > maxLocators,
    capturedAt: new Date().toISOString(),
  }
}

/**
 * 收集页面中可解释的交互元素定位信息。
 *
 * @param locator - 候选元素的 Playwright locator。
 * @param maxLocators - 最多转换的候选数量。
 * @returns 有界的候选定位器列表。
 * @throws 页面关闭或 evaluateAll 失败时抛出底层异常。
 */
async function collectCandidateLocators(
  locator: ReturnType<Page['locator']>,
  maxLocators: number,
): Promise<ICandidateLocator[]> {
  // 浏览器回调只依赖序列化参数和 DOM，不能引用 Node 模块中的工具函数。
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

/** 密码字段在无障碍树中的占位符；不泄露长度，避免侧信道推断。 */
const PASSWORD_MASK = '[已隐藏]'

/**
 * 遮蔽无障碍树中密码输入框的当前值（v20）。
 *
 * 背景（实测确认）：`ariaSnapshot()` 会把输入框的当前值渲染成
 * `- textbox "密码": S3cr3tP@ss` 这样的节点，因此凭据代理填入的密码
 * 会被后续任何一次 `browser_snapshot` 原样读回模型上下文。
 *
 * 实现选择「按结构遮蔽」而非「按值替换」的原因：按值替换依赖脱敏器已经知道
 * 具体值（真值恰好未被登记、或页面自身预填了密码时就会漏），
 * 而按结构遮蔽只需知道**哪些行是密码字段**，与值本身无关——
 * 两道防线相互独立，任一生效即可阻断泄漏。
 *
 * 定位方式：无障碍树的行形如 `- textbox "标签": 值`，其中「标签」来自
 * 输入框的关联 label / aria-label / placeholder，**不保证包含「密码」字样**。
 * 因此不能只靠行文本判断，必须回到页面按 `input[type=password]` 取可访问名，
 * 再据此匹配对应行——这也是本函数需要 `page` 的原因。
 *
 * @param page - 用于枚举密码字段可访问名的页面对象。
 * @param a11yTree - 原始无障碍树文本。
 * @returns 密码字段的值位置被替换为占位符的树文本。
 * @throws 不抛出异常——枚举失败时返回原树（N1：遮蔽是加固手段，
 *   不应让快照整体失败；真正的防线由脱敏器承担）。
 */
async function maskPasswordValues(
  page: Page,
  a11yTree: string,
): Promise<string> {
  if (!a11yTree) {
    return a11yTree
  }

  let names: string[]
  try {
    names = await page.locator('input[type=password]').evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const element = node as HTMLInputElement
          return (
            element.getAttribute('aria-label') ??
            element.labels?.[0]?.textContent?.trim() ??
            element.getAttribute('placeholder') ??
            ''
          ).trim()
        })
        .filter((name) => name.length > 0),
    )
  } catch {
    return a11yTree
  }

  if (names.length === 0) {
    return a11yTree
  }

  const passwordNames = new Set(names)
  const lines = a11yTree.split('\n')
  // 逐行状态机而非单条正则：密码字段的值可能以「同行冒号后缀」或
  // 「缩进子节点」两种形态出现，且子节点与字段行之间可能隔着
  // `/placeholder` 等其它行（实测 Playwright 会先输出 placeholder 再输出值）。
  // 用「字段行 → 记录其缩进 → 后续出现的首个文本行替换掉」比正则更贴合结构。
  let passwordIndent: number | null = null

  const output = lines.map((line) => {
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    if (passwordIndent !== null) {
      // 仍在密码字段的子节点范围内：缩进更深即为它的子行。
      if (trimmed.length > 0 && indent > passwordIndent) {
        if (trimmed.startsWith('- text: ')) {
          return `${line.slice(0, indent)}- text: ${PASSWORD_MASK}`
        }
        // `/placeholder` 等非值子行原样保留，继续等待值行。
        return line
      }
      // 缩进回到同层或更浅：该字段的子节点已结束。
      // 若始终没遇到值行（空输入框本就不输出值行），无需替换。
      passwordIndent = null
    }

    // 字段行判定：`- textbox "名字":`，名字必须与页面上密码字段的可访问名一致。
    const match = /^-\s*textbox\s+"(.*)":?\s*$/.exec(trimmed)
    if (match && passwordNames.has(match[1])) {
      // 同行直接带值（`- textbox "密码": 明文`）时立即替换。
      if (/:\s+\S/.test(trimmed)) {
        return `${line.slice(0, indent)}- textbox "${match[1]}": ${PASSWORD_MASK}`
      }
      passwordIndent = indent
    }

    return line
  })

  return output.join('\n')
}

/** 快照默认输出限制。 */
export const pageSnapshotDefaults = {
  maxA11yLength: DEFAULT_MAX_A11Y_LENGTH,
  maxLocators: DEFAULT_MAX_LOCATORS,
} as const
