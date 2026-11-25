/**
 * SKILL.md 正文与用例字段的文本比对工具（仅供覆盖度与等值校验使用）。
 *
 * 模型“原文照抄”多行中文时，稳定产生两类**不改变语义**的差异，二者都会让精确匹配
 * 把「已覆盖」误判为「未覆盖」，使合法用例无法生成文档：
 *   1. 排版异形：引号中英文混用（`”` / `"`）、破折号形态不同、全半角混排；
 *   2. 逐字转录笔误：长句里漏掉一个字母（如 `baseline` 写成 `basline`）。
 *
 * 因此本模块把判定放宽为两步：
 *   1. {@link normalizeForCoverage} 消除同义异形字符，使排版差异不再影响比较；
 *   2. {@link isTextCovered} 按行有序匹配，允许单行存在少量字符差异（差异预算）。
 *
 * **放宽的边界是刻意保守的**：只吸收排版差异与个别字符差异，不吸收结构差异。
 * 「行数不足」「行序颠倒」仍判定为未覆盖（由 skill-document.test.ts 守住），
 * 因为那才真正意味着模型丢失了用例信息。
 */

/**
 * 允许的字符差异比例：字段行按行长比例获得差异预算。
 *
 * **不设下限**是关键：行长与冗余度成正比——长行有足够上下文供人判断「这是笔误」，
 * 短行则几乎没有冗余，1 个字符的差异往往就是语义差异。若给短行保底 1 个字符的
 * 宽容度，6 字的「第二行内容。」会被当成「第一行内容。」的笔误而放行，
 * 使「行序必须一致」这条守卫失效。
 *
 * 5% 使 20 字以上的行才获得首个差异预算。
 */
const ALLOWED_DIFFERENCE_RATIO = 0.05

/**
 * 差异预算上限，防止长行获得过大宽容度。
 *
 * 比例与上限共同决定预算：`min(上限, floor(行长 × 比例))`。
 * 设上限是必要的——85 字的行按 5% 可得 4 个字符预算，而真实转录笔误
 * （如 `baseline` → `basline`）通常只有 1~2 个字符；过宽的预算会让
 * 单字符级的语义改动（插入否定词）一并溜过。
 *
 * **本校验的固有边界**（无法通过调参消除）：插入否定词与漏写字母在编辑距离上
 * 完全同形——`baseline`→`basline` 与 `截取`→`不截取` 的距离都是 1。
 * 任何基于编辑距离的规则都无法区分二者。因此本校验只能保证**结构级忠实**
 * （行不丢失、不错序、无大段改写），不能保证**逐字语义忠实**；
 * 后者的兜底依赖脚本生成阶段以结构化用例为权威（见 playwright_script_generation）。
 */
const MAX_ALLOWED_DIFFERENCES = 2

/** 各类引号（含书名号、方头括号等排版等价形态）统一为 ASCII 双引号。 */
const QUOTE_PATTERN = /[“”„‟«»‹›「」『』【】｢｣❝❞]/g

/** 各类单引号与重音符统一为 ASCII 单引号。 */
const APOSTROPHE_PATTERN = /[‘’‚‛`´]/g

/** 各类破折号 / 连字符 / 波浪号统一为 ASCII 连字符。 */
const DASH_PATTERN = /[—–―‒‐‑−〜～]/g

/** 全角字母与数字（与半角一一对应，仅编码不同）。 */
const FULLWIDTH_ALNUM_PATTERN = /[Ａ-Ｚａ-ｚ０-９]/g

/** 省略号统一为三个点，避免单双省略号写法差异。 */
const ELLIPSIS_PATTERN = /…/g

/**
 * 归一化文本，用于「是否覆盖」与「是否等值」的比较。
 *
 * 处理两类不承载语义的差异：换行符差异（CRLF / CR → LF）、以及
 * {@link normalizeCoverageLine} 定义的逐行排版差异。
 * **不合并行、不改变行数**，因此「整段按原顺序出现」的覆盖语义依然成立。
 *
 * @param text - 正文或字段原文。
 * @returns 逐行归一并以 LF 连接的文本。
 */
export function normalizeForCoverage(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(normalizeCoverageLine)
    .join('\n')
    .trim()
}

/**
 * 判断字段内容是否被正文覆盖。
 *
 * 覆盖语义是「字段的各行按原顺序在正文中依次出现」，允许：
 *   - 正文中该行**包含**字段行（用于适配 `- 操作：首行内容` 这类标签与首行同行的写法）；
 *   - 或该行与字段行的相似度不低于 {@link LINE_SIMILARITY_THRESHOLD}（吸收转录笔误）。
 *
 * 空行视为排版，不参与匹配。采用贪心最早匹配：对「子序列匹配」而言，
 * 为每个字段行选择最早的匹配位置可最大化剩余可匹配空间，故贪心即最优，
 * 无需回溯，复杂度为 O(正文行数 × 字段行数)。
 *
 * @param normalizedContent - 已经 {@link normalizeForCoverage} 处理的正文。
 * @param fieldText - 待判定是否被覆盖的字段原文（内部自行归一化）。
 * @returns 覆盖时返回 true。
 * @throws 不抛出异常。
 */
export function isTextCovered(
  normalizedContent: string,
  fieldText: string,
): boolean {
  const fieldLines = normalizeForCoverage(fieldText)
    .split('\n')
    .filter((line) => line.length > 0)

  // 字段为空（如用例未填写 expectedResult）时视为无需覆盖。
  if (fieldLines.length === 0) {
    return true
  }

  const contentLines = normalizedContent.split('\n')
  let searchFrom = 0

  for (const fieldLine of fieldLines) {
    const matchedIndex = findLineMatch(contentLines, fieldLine, searchFrom)
    if (matchedIndex < 0) {
      return false
    }
    searchFrom = matchedIndex + 1
  }

  return true
}

/**
 * 从指定位置起查找首个匹配的正文行下标。
 *
 * @param contentLines - 已归一的正文行。
 * @param fieldLine - 已归一的字段行。
 * @param searchFrom - 起始下标（含）。
 * @returns 匹配到的行下标；未匹配时返回 -1。
 * @throws 不抛出异常。
 */
function findLineMatch(
  contentLines: readonly string[],
  fieldLine: string,
  searchFrom: number,
): number {
  for (let index = searchFrom; index < contentLines.length; index += 1) {
    const contentLine = contentLines[index]
    if (contentLine === undefined) continue

    if (
      contentLine.includes(fieldLine) ||
      countCharacterDifferences(contentLine, fieldLine) <=
        allowedDifferenceCount(fieldLine)
    ) {
      return index
    }
  }

  return -1
}

/**
 * 归一化单行文本，消除同义异形字符。
 *
 * @param line - 原始行。
 * @returns 归一化后的行（首尾无空白）。
 * @throws 不抛出异常。
 */
function normalizeCoverageLine(line: string): string {
  // JS 的 \s 已覆盖全角空格与不换行空格，故空白折叠在此一并完成。
  return line
    .replace(/\s+/g, ' ')
    .replace(QUOTE_PATTERN, '"')
    .replace(APOSTROPHE_PATTERN, "'")
    .replace(DASH_PATTERN, '-')
    .replace(ELLIPSIS_PATTERN, '...')
    .replace(FULLWIDTH_ALNUM_PATTERN, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0xfee0),
    )
    .trim()
}

/**
 * 计算字段行在正文行中的**最少字符差异数**。
 *
 * 不能直接比较两整行：正文行常带标签前缀（如 `- 操作：`）或列表符号，
 * 这些是**文档排版**而非字段内容，却会占用差异预算。若按整行比较，
 * 32 字的字段只漏 1 个字也会被前缀放大成 6 处差异而被误拒。
 *
 * 因此取「正文行中与字段行最相近的等长窗口」作为比较对象：
 * 字段行必须作为**连续片段**出现（保留「按原顺序连续出现」的覆盖语义），
 * 正文行在该片段之外的装饰性字符不参与计算。
 *
 * 实现为滑动窗口取最小编辑距离。字段行较长时用长度差作为下界提前剪枝。
 *
 * @param contentLine - 已归一的正文行。
 * @param fieldLine - 已归一的字段行。
 * @returns 最少差异字符数；字段行为空时返回 0。
 * @throws 不抛出异常。
 */
function countCharacterDifferences(
  contentLine: string,
  fieldLine: string,
): number {
  const contentPoints = [...contentLine]
  const fieldPoints = [...fieldLine]
  const fieldLength = fieldPoints.length

  if (fieldLength === 0) {
    return 0
  }

  // 正文行更短：字段行不可能作为连续片段完整覆盖，按整段比较（差异数必然偏高，属正确拒绝）。
  if (contentPoints.length <= fieldLength) {
    return levenshteinDistance(contentPoints, fieldPoints)
  }

  let bestDistance = Number.POSITIVE_INFINITY

  // 窗口长度在字段行长度附近浮动：笔误可能造成 1~2 个字符的插入 / 删除。
  for (const windowLength of [fieldLength, fieldLength + 1, fieldLength - 1]) {
    if (windowLength <= 0 || windowLength > contentPoints.length) continue

    for (
      let start = 0;
      start + windowLength <= contentPoints.length;
      start += 1
    ) {
      // 下界剪枝：窗口与字段的长度差已是距离下界，若已不可能更优则跳过。
      const lengthGap = Math.abs(windowLength - fieldLength)
      if (lengthGap >= bestDistance) continue

      const distance = levenshteinDistance(
        contentPoints.slice(start, start + windowLength),
        fieldPoints,
      )
      if (distance < bestDistance) {
        bestDistance = distance
        if (bestDistance === 0) break
      }
    }

    if (bestDistance === 0) break
  }

  return bestDistance
}

/**
 * 计算字段行允许的差异字符数。
 *
 * @param fieldLine - 已归一的字段行。
 * @returns 允许的差异字符数；不足 20 字的行返回 0，即要求完全一致。
 * @throws 不抛出异常。
 */
function allowedDifferenceCount(fieldLine: string): number {
  const byRatio = Math.floor([...fieldLine].length * ALLOWED_DIFFERENCE_RATIO)
  return Math.min(byRatio, MAX_ALLOWED_DIFFERENCES)
}

/**
 * 计算两个码点数组的编辑距离（滚动数组实现，空间 O(min(n, m))）。
 *
 * @param left - 左值的码点数组。
 * @param right - 右值的码点数组。
 * @returns 编辑距离（插入 / 删除 / 替换代价均为 1）。
 * @throws 不抛出异常。
 */
function levenshteinDistance(
  left: readonly string[],
  right: readonly string[],
): number {
  // 让较短的一侧作为滚动数组，减少内存占用。
  const [shorter, longer] =
    left.length <= right.length ? [left, right] : [right, left]

  let previous = Array.from({ length: shorter.length + 1 }, (_, i) => i)

  for (let longIndex = 1; longIndex <= longer.length; longIndex += 1) {
    const current = [longIndex]

    for (let shortIndex = 1; shortIndex <= shorter.length; shortIndex += 1) {
      const substitutionCost =
        longer[longIndex - 1] === shorter[shortIndex - 1] ? 0 : 1

      current[shortIndex] = Math.min(
        (current[shortIndex - 1] ?? 0) + 1,
        (previous[shortIndex] ?? 0) + 1,
        (previous[shortIndex - 1] ?? 0) + substitutionCost,
      )
    }

    previous = current
  }

  return previous[shorter.length] ?? 0
}
