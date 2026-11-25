/**
 * env.json（Skill 敏感数据文件，PRD v10 第 4 章）的解析与格式校验。
 *
 * 单一职责：把 env.json 文本解析为结构化结果并执行 R1–R5 格式校验，
 * 产出携带定位信息的问题列表。本模块是**纯函数**，不读取文件系统，
 * 供 Web 端保存前校验与服务端写入闸门共同调用，保证两端判定同源。
 */

import { PLATFORM_BUILTIN_ENV_KEYS } from '../api/user-workspace'

/**
 * env.json key 的合法命名规则：大写字母或下划线开头，仅含大写字母、数字和下划线。
 *
 * 与既有 `${ENV:NAME}` 占位符语法（PRD 6.1.3 数据契约）保持同一规则，
 * 保证引用链路两端的 key 语法统一。
 */
export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/

/** Skill 敏感数据文件名（v10，PRD 4.1）；与 skill-manager 侧常量同值。 */
export const SKILL_ENV_FILE_NAME = 'env.json'

/** env.json 的默认内容（空对象，格式化输出）；创建 Skill 与存量补建共用。 */
export const DEFAULT_ENV_FILE_CONTENT = '{\n}'

/** env.json 单条校验问题，携带定位信息供编辑器与校验反馈区展示。 */
export interface IEnvFileIssue {
  /**
   * 问题类型，与 PRD 4.2 的 R1–R5 一一对应：
   * R1 语法错误、R2 顶层类型、R3 key 命名、R4 key 重复、R5 value 类型。
   */
  code:
    | 'ENV_SYNTAX_ERROR'
    | 'ENV_TOP_LEVEL_TYPE'
    | 'ENV_KEY_FORMAT'
    | 'ENV_KEY_DUPLICATED'
    | 'ENV_VALUE_TYPE'
    | 'ENV_KEY_RESERVED'
  /** 面向用户的中文说明（含行号或 key 名）。 */
  message: string
  /** 违规 key 名（R3/R4/R5 时提供）。 */
  key?: string
  /** 1 起始的行号（可定位时提供）。 */
  line?: number
  /** 1 起始的列号（可定位时提供）。 */
  column?: number
}

/** env.json 的解析校验结果。 */
export interface IEnvFileParseResult {
  /** 校验通过时为解析后的扁平键值对象；存在任一问题时为 null。 */
  data: Record<string, string> | null
  /** 全部问题（R1–R5 逐条产出，不短路）。 */
  issues: IEnvFileIssue[]
}

/**
 * 解析并校验 env.json 文本（PRD 4.2 的 R1–R5）。
 *
 * 校验按规则逐条执行并累计全部问题，便于用户一次修完：
 * R1 合法 JSON → R2 顶层对象 → R4 key 重复（文本扫描）→ R3 key 命名 → R5 value 类型。
 * R1 失败时后续规则无法执行（无法解析），此时仅返回语法错误；
 * R2 失败时跳过逐条目检查（无法枚举对象条目）。
 *
 * @param text - env.json 的原始文本内容。
 * @returns 解析结果：`data` 在无任何问题时为解析出的扁平对象，否则为 null。
 * @throws 不抛出异常——所有失败形态都转换为结构化问题返回。
 */
export function parseEnvFileContent(text: string): IEnvFileParseResult {
  const issues: IEnvFileIssue[] = []

  // R1：整体必须是合法 JSON；失败时从异常消息中提取出错位置。
  let parsed: unknown
  const syntaxIssue = tryParseJson(text, (value) => {
    parsed = value
  })

  if (syntaxIssue) {
    issues.push(syntaxIssue)
    return { data: null, issues }
  }

  // R2：顶层必须是普通对象，不允许数组、字符串、数字、布尔或 null。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    issues.push({
      code: 'ENV_TOP_LEVEL_TYPE',
      message: 'env.json 的顶层必须是一个对象，如 { "KEY": "值" }。',
    })
    return { data: null, issues }
  }

  const entries = Object.entries(parsed as Record<string, unknown>)

  // R4：JSON.parse 会静默丢弃重复 key，必须在原始文本上扫描才能检出。
  issues.push(...findDuplicatedKeys(text))

  // R3 / R5 / 保留名（v14）：逐条目校验 key 命名、value 类型与平台内置名占用。
  for (const [key, value] of entries) {
    if (!ENV_KEY_PATTERN.test(key)) {
      issues.push({
        code: 'ENV_KEY_FORMAT',
        message: `key "${key}" 不符合命名规则：请使用大写字母开头的名称，仅含大写字母、数字和下划线。`,
        key,
      })
    }

    // v14（W38）：平台内置环境变量不可被业务占用——执行期由平台注入子进程，
    // 业务同名定义会被平台值覆盖且语义错乱，因此在解析层直接拒绝落盘。
    if (PLATFORM_BUILTIN_ENV_KEYS.includes(key)) {
      issues.push({
        code: 'ENV_KEY_RESERVED',
        message: `key "${key}" 是平台内置变量，不能在 env.json 中定义。`,
        key,
      })
    }

    if (typeof value !== 'string') {
      issues.push({
        code: 'ENV_VALUE_TYPE',
        message: `key "${key}" 的值必须是字符串。`,
        key,
      })
    }
  }

  if (issues.length > 0) {
    return { data: null, issues }
  }

  return { data: parsed as Record<string, string>, issues }
}

/**
 * 提取合法 env.json 数据的全部 key（按字母序排列）。
 *
 * @param data - 已通过 `parseEnvFileContent` 校验的扁平键值对象。
 * @returns 字母序 key 列表，供下拉数据源与失效判定使用。
 * @throws 不抛出异常。
 */
export function extractEnvFileKeys(data: Record<string, string>): string[] {
  return Object.keys(data).sort()
}

/**
 * 尝试解析 JSON 文本，失败时产出携带行列定位的语法错误问题（R1）。
 *
 * @param text - 待解析的 JSON 文本。
 * @param onParse - 解析成功时接收解析结果的回调。
 * @returns 解析失败时返回语法错误问题；成功时返回 null。
 * @throws 不抛出异常。
 */
function tryParseJson(
  text: string,
  onParse: (value: unknown) => void,
): IEnvFileIssue | null {
  try {
    onParse(JSON.parse(text) as unknown)
    return null
  } catch (error) {
    const position = extractJsonErrorPosition(error)
    const location = position === null ? null : toLineColumn(text, position)

    return {
      code: 'ENV_SYNTAX_ERROR',
      message: location
        ? `第 ${location.line} 行第 ${location.column} 列：JSON 语法错误，请检查标点、引号与括号。`
        : 'JSON 语法错误，请检查标点、引号与括号。',
      ...(location ? { line: location.line, column: location.column } : {}),
    }
  }
}

/**
 * 从 JSON.parse 异常消息中提取出错字符位置。
 *
 * V8 的异常消息形如 `... in JSON at position 123`；无法识别时返回 null，
 * 问题文案退化为不带定位的通用说明。
 * @param error - JSON.parse 抛出的异常。
 * @returns 0 起始的出错字符位置；无法识别时返回 null。
 * @throws 不抛出异常。
 */
function extractJsonErrorPosition(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = /position (\d+)/i.exec(message)
  return match ? Number(match[1]) : null
}

/**
 * 把 0 起始的字符位置换算为 1 起始的行列位置。
 *
 * @param text - 原始文本。
 * @param position - 0 起始的字符位置（超界时按文本末尾处理）。
 * @returns 1 起始的行号与列号。
 * @throws 不抛出异常。
 */
function toLineColumn(
  text: string,
  position: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length))
  const before = text.slice(0, clamped)
  const lines = before.split('\n')
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  }
}

/**
 * 在原始文本中扫描顶层 key 的重复定义（R4）。
 *
 * 采用轻量字符扫描：追踪字符串与转义状态以及大括号深度，
 * 仅在「顶层对象（深度 1）的 key 位置」收集键名，嵌套结构中的同名 key 不会误报
 * （嵌套值本身会被 R5 拒绝）。语法层面的残缺文本由 R1 先行拦截，本扫描不重复报错。
 *
 * @param text - 已通过 R1 校验的 env.json 原始文本。
 * @returns 每个重复 key 一条问题；无重复时返回空数组。
 * @throws 不抛出异常。
 */
function findDuplicatedKeys(text: string): IEnvFileIssue[] {
  const occurrences = new Map<string, number>()
  let depth = 0
  let inString = false
  let escaped = false
  // 当前处于「key 字符串」的候选状态：深度 1 中冒号之前的顶层字符串。
  let pendingKey: string | null = null
  let expectKeyValueSeparator = false

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      } else if (depth === 1 && pendingKey !== null) {
        pendingKey += char
      }
      continue
    }

    if (char === '"') {
      inString = true
      // 深度 1 中新出现的字符串是 key 候选；冒号确认其身份。
      if (depth === 1) {
        pendingKey = ''
        expectKeyValueSeparator = true
      }
      continue
    }

    if (char === ':' && depth === 1 && expectKeyValueSeparator) {
      // 冒号确认当前字符串是 key：记录一次出现。
      if (pendingKey !== null) {
        occurrences.set(pendingKey, (occurrences.get(pendingKey) ?? 0) + 1)
      }
      pendingKey = null
      expectKeyValueSeparator = false
      continue
    }

    if (char === '{' || char === '[') {
      depth += 1
      continue
    }

    if (char === '}' || char === ']') {
      depth -= 1
      pendingKey = null
      expectKeyValueSeparator = false
      continue
    }

    if (char === ',' && depth === 1) {
      pendingKey = null
      expectKeyValueSeparator = false
    }
  }

  const issues: IEnvFileIssue[] = []

  for (const [key, count] of occurrences) {
    if (count > 1) {
      issues.push({
        code: 'ENV_KEY_DUPLICATED',
        message: `key "${key}" 重复定义。`,
        key,
      })
    }
  }

  return issues
}
