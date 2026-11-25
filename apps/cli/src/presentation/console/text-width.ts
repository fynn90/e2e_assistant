/**
 * 终端文本可见宽度计算。
 *
 * 为什么需要它：面板边框要求每行左边框与右边框严格对齐，而 `String.length`
 * 数的是 UTF-16 码元——中文（2 列）、emoji（2 列）、组合符（0 列）全都会算错，
 * 导致右边框锯齿状错位。ANSI 转义序列更是会额外增加长度。
 *
 * 为什么不用 `\p{East_Asian_Width=Wide}`：该属性**不是**合法的 JS 正则属性
 * （实测抛 SyntaxError）。`\p{Extended_Pictographic}` 虽合法但结果错误——
 * `♻`/`▶`/`⚠` 是 pictographic 却只占 1 列，`🚀`/`🤖` 才占 2 列。
 * 因此这里按字素簇逐段判定：组合符与变体选择符零宽、Emoji_Presentation 与
 * CJK 全角双宽、其余单宽。
 *
 * 正确性以 `@earendil-works/pi-tui` 的 `visibleWidth` 为基准逐例校准
 * （含 ZWJ 家庭 emoji、国旗、肤色修饰、键帽、VS16、ANSI），见同目录单测。
 */

/** 匹配 CSI 序列（颜色、加粗等 SGR 均由它承载）。 */
const ANSI_CSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'g',
)

/** 变体选择符 16：使前一个字符以 emoji 形式呈现（宽度从 1 变 2）。 */
const VARIATION_SELECTOR_16 = String.fromCharCode(0xfe0f)

/** 制表符按终端惯例占 3 列（与 pi-tui 一致）。 */
const TAB_WIDTH = 3

/** 以组合符开头的字素簇不占额外宽度（如 e + 声调符号）。 */
const COMBINING_MARK_START = /^\p{Mark}/u

/** 默认以双宽呈现的 emoji（实测覆盖 🚀🤖🟢 等面板所用图形）。 */
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u

/** 按字素簇切分：一个可见「字」可能由多个码元组成（emoji + 变体符、ZWJ 序列、国旗对）。 */
const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * 判断单个码点是否落在双宽区（CJK、韩文、全角标点与补充平面 emoji 区）。
 *
 * 这些区间的宽度无法由 JS 内置 Unicode 属性正则表达，故显式列出。
 * 未覆盖的补充平面 emoji 由 `EMOJI_PRESENTATION` 兜底。
 *
 * @param codePoint - 字素簇的首个码点。
 * @returns 该码点占两列时返回 true。
 * @throws 不抛出异常。
 */
function isWideCodePoint (codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

/**
 * 计算文本在终端中占用的列数（忽略 ANSI 转义序列）。
 *
 * 面板渲染据此补齐空格，保证边框对齐。
 *
 * @param text - 待测量的文本，可含 ANSI 转义序列与多行。
 * @returns 文本占用的列数；换行符不计宽。
 * @throws 不抛出异常。
 */
export function measureTextWidth (text: string): number {
  const plainText = text.replace(ANSI_CSI_PATTERN, '')
  let totalWidth = 0

  for (const { segment } of graphemeSegmenter.segment(plainText)) {
    const firstCodePoint = segment.codePointAt(0)

    if (firstCodePoint === undefined) {
      continue
    }

    // 换行由调用方按行处理，不应计入宽度。
    if (firstCodePoint === 0x0a || firstCodePoint === 0x0d) {
      continue
    }

    if (firstCodePoint === 0x09) {
      totalWidth += TAB_WIDTH
      continue
    }

    // 先判零宽再判双宽：组合符可能同时命中 emoji 属性，顺序反了会算成 2 列。
    if (COMBINING_MARK_START.test(segment)) {
      continue
    }

    // 带变体选择符 16 的字素簇按 emoji 呈现，恒为双宽（如 ♻️、⚠️）。
    if (segment.includes(VARIATION_SELECTOR_16)) {
      totalWidth += 2
      continue
    }

    if (EMOJI_PRESENTATION.test(segment) || isWideCodePoint(firstCodePoint)) {
      totalWidth += 2
      continue
    }

    totalWidth += 1
  }

  return totalWidth
}

/**
 * 按可见宽度把文本截断到指定列数，超出部分以省略号结尾。
 *
 * 按字素簇切分，因此不会把 emoji 或组合字符从中间截开产生乱码。
 *
 * @param text - 待截断的文本（应为不含 ANSI 的纯文本）。
 * @param maxWidth - 允许占用的最大列数。
 * @returns 截断后的文本；未超宽时原样返回。
 * @throws 不抛出异常。
 */
export function truncateToWidth (text: string, maxWidth: number): string {
  if (measureTextWidth(text) <= maxWidth) {
    return text
  }

  const ellipsis = '…'
  const ellipsisWidth = measureTextWidth(ellipsis)
  const budget = maxWidth - ellipsisWidth
  let accumulatedWidth = 0
  let truncatedText = ''

  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = measureTextWidth(segment)

    if (accumulatedWidth + segmentWidth > budget) {
      break
    }

    accumulatedWidth += segmentWidth
    truncatedText += segment
  }

  return `${truncatedText}${ellipsis}`
}

/**
 * 按可见宽度右补空格，使文本恰好占满指定列数。
 *
 * @param text - 待补齐的文本（应为不含 ANSI 的纯文本）。
 * @param targetWidth - 目标列数。
 * @returns 补齐后的文本；已超宽时原样返回。
 * @throws 不抛出异常。
 */
export function padToWidth (text: string, targetWidth: number): string {
  const paddingWidth = targetWidth - measureTextWidth(text)

  return paddingWidth > 0 ? text + ' '.repeat(paddingWidth) : text
}

/**
 * 折行过程中的「当前行」状态。
 *
 * 单独建模是为了让累积、换行与超宽硬切三件事各自有明确入口，
 * 主循环因此只表达「这个词放得下吗」这一层判断。
 */
interface IWrappingState {
  /** 已完成的各行（不含缩进）。 */
  lines: string[]
  /** 当前正在累积的一行。 */
  currentLine: string
}

/**
 * 结束当前行（若为空则什么都不做），并开始新的一行。
 *
 * @param state - 折行状态（就地修改）。
 * @param nextLine - 新行的初始内容。
 * @returns 换行后无返回值。
 * @throws 不抛出异常。
 */
function breakLine (state: IWrappingState, nextLine: string): void {
  if (state.currentLine) {
    state.lines.push(state.currentLine)
  }

  state.currentLine = nextLine
}

/**
 * 试图把一个词拼到当前行；放不下则先结束当前行再另起一行。
 *
 * @param state - 折行状态（就地修改）。
 * @param token - 待拼入的词及其接续方式。
 * @param availableWidth - 每行可用的列数。
 * @returns 拼入后无返回值。
 * @throws 不抛出异常。
 */
function appendWord (
  state: IWrappingState,
  token: IWrapToken,
  availableWidth: number,
): void {
  // 仅当原文本该处有空白、且当前行非空时才补空格：
  // 中文逐字断行时不能凭空插入空格，否则整句会被塞满空格。
  const needsSpace = token.spaced && state.currentLine.length > 0
  const separatorWidth = needsSpace ? 1 : 0
  const projectedWidth =
    measureTextWidth(state.currentLine) +
    separatorWidth +
    measureTextWidth(token.text)

  if (projectedWidth <= availableWidth) {
    state.currentLine = state.currentLine
      ? `${state.currentLine}${needsSpace ? ' ' : ''}${token.text}`
      : token.text
    return
  }

  breakLine(state, token.text)
}

/**
 * 折行的一个「词」。
 */
interface IWrapToken {
  /** 词文本。 */
  text: string
  /** 原文本中该词之前是否有空白；决定拼接时是否补空格。 */
  spaced: boolean
}

/** 中日韩表意文字与非空白的全角标点：这些字符之间可以任意断行。 */
const CJK_BREAKABLE = /[⺀-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/

/**
 * 把一行文本切成可断行的「词」。
 *
 * 两者规则不同，不能混为一谈：
 *   - **拉丁文**按空格断词——`e2e_assistant start` 必须整体保留，从中间断开无法阅读；
 *   - **中文**按字断行——中文词间没有空格，若整句当作一个词就只能任意位置硬切，
 *     会出现「端口 5826 / 被占用」这种把半句甩到下一行的难看排版（中文排版惯例
 *     是逐字断行）。
 *
 * 因此按字素簇扫描：连续的非 CJK 字符合并为一个词，每个 CJK 字符各自成词。
 *
 * @param text - 待切分的文本。
 * @returns 词序列；空白作为分隔符被丢弃。
 * @throws 不抛出异常。
 */
function tokenizeForWrapping (text: string): IWrapToken[] {
  const tokens: IWrapToken[] = []
  let latinWord = ''
  /** 扫描过程中是否刚遇到过空白；用于标记下一个词的接续方式。 */
  let pendingSpace = false
  /** 上一个词之前是否有空白；用于给续接的拉丁词沿用标记。 */
  let latinWordSpaced = false

  /** 收束当前累积的拉丁词。 */
  const flushLatinWord = (): void => {
    if (latinWord) {
      tokens.push({ text: latinWord, spaced: latinWordSpaced })
      latinWord = ''
    }
  }

  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (/\s/.test(segment)) {
      flushLatinWord()
      pendingSpace = true
      continue
    }

    if (CJK_BREAKABLE.test(segment)) {
      flushLatinWord()
      tokens.push({ text: segment, spaced: pendingSpace })
      pendingSpace = false
      continue
    }

    // 拉丁词的首个字符决定它是否需要前置空格；词中后续字符不改变该标记。
    if (!latinWord) {
      latinWordSpaced = pendingSpace
      pendingSpace = false
    }

    latinWord += segment
  }

  flushLatinWord()

  return tokens
}

/**
 * 按可见宽度把文本折成多行；折行后每行以缩进开头。
 *
 * 用于卡片内的说明性句子（如状态标题、陈旧记录提示）：拉丁文按空格断词、
 * 中文逐字断行，且一律按可见宽度计算——不能用字符数，否则中文行会明显超宽
 * 冲出边框。断词规则详见 `tokenizeForWrapping`。
 *
 * @param text - 待折行的文本（应为不含 ANSI 的纯文本）。
 * @param maxWidth - 每行允许的最大列数。
 * @param options - `indent`：续行与首行共用的行首缩进，计入宽度。
 * @returns 折行后的各行文本；无需折行时返回单元素数组。
 * @throws 不抛出异常。
 */
export function wrapTextToWidth (
  text: string,
  maxWidth: number,
  options: { indent?: string } = {},
): string[] {
  const indent = options.indent ?? ''
  const availableWidth = maxWidth - measureTextWidth(indent)

  if (availableWidth <= 0) {
    return [`${indent}${text}`]
  }

  const state: IWrappingState = { lines: [], currentLine: '' }

  for (const token of tokenizeForWrapping(text)) {
    // 放得下时只有一个「段」；超宽词（如无空格的长路径）被切成若干段，
    // 逐段交给 appendWord：放不下就换行，最后一段仍可与后续词拼接。
    const chunks = hardSplitToWidth(token.text, availableWidth)

    chunks.forEach((chunk, index) => {
      // 只有首个切段沿用原词的接续方式：后续切段是同一词的延续，不加空格。
      appendWord(
        state,
        { text: chunk, spaced: index === 0 && token.spaced },
        availableWidth,
      )
    })
  }

  if (state.currentLine) {
    state.lines.push(state.currentLine)
  }

  return state.lines.length > 0
    ? state.lines.map((line) => `${indent}${line}`)
    : [indent]
}

/**
 * 把一个超宽的单「词」按可见宽度硬切成多段。
 *
 * @param word - 待切分的词（不含空白）。
 * @param maxWidth - 每段允许的最大列数。
 * @returns 切分后的各段文本。
 * @throws 不抛出异常。
 */
function hardSplitToWidth (word: string, maxWidth: number): string[] {
  const chunks: string[] = []
  let currentChunk = ''
  let currentWidth = 0

  for (const { segment } of graphemeSegmenter.segment(word)) {
    const segmentWidth = measureTextWidth(segment)

    if (currentWidth + segmentWidth > maxWidth && currentChunk) {
      chunks.push(currentChunk)
      currentChunk = ''
      currentWidth = 0
    }

    currentChunk += segment
    currentWidth += segmentWidth
  }

  if (currentChunk) {
    chunks.push(currentChunk)
  }

  return chunks
}
