/**
 * markdown 资源文件前置元信息（frontmatter）解析工具。
 *
 * 支持形如
 *   ---
 *   name: example
 *   description: when to use
 *   disable-model-invocation: true
 *   ---
 *   <正文>
 * 的极简 frontmatter。仅解析 `key: value` 形式的标量字段（字符串 / 布尔），
 * 不引入额外 YAML 依赖，满足系统内置资源的元数据需求。
 */

/** frontmatter 分隔符 */
const FRONTMATTER_DELIMITER = '---'

/** 解析结果：元数据字段 + 正文内容 */
export interface ParsedFrontmatter {
  /** 解析出的元数据字段（key 为小写，value 为字符串或布尔） */
  metadata: Record<string, string | boolean>
  /** frontmatter 之后的正文内容（去除开头的空行） */
  body: string
}

/**
 * 尝试从 markdown 文本中解析前置元信息。
 *
 * @param text - markdown 原始文本
 * @returns 解析结果；当文本不是以 `---` 开头、或找不到结束分隔符时返回 null
 * @throws 无（纯解析函数，失败返回 null）
 */
export function parseFrontmatter(text: string): ParsedFrontmatter | null {
  // 去掉可能的 BOM，再按行拆分
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  // 首行必须是分隔符，才视为存在 frontmatter
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return null
  }

  // 找到结束分隔符
  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_DELIMITER) {
      endIndex = i
      break
    }
  }
  if (endIndex === -1) {
    return null
  }

  // 解析分隔符之间的 key: value 字段
  const metadata: Record<string, string | boolean> = {}
  for (const line of lines.slice(1, endIndex)) {
    const parsed = parseKeyValue(line)
    if (parsed) {
      metadata[parsed.key] = parsed.value
    }
  }

  // 正文 = 结束分隔符之后的内容（去掉开头的空行）
  const body = lines
    .slice(endIndex + 1)
    .join('\n')
    .replace(/^\n+/, '')

  return { metadata, body }
}

/**
 * 解析单行 `key: value`。
 *
 * @param line - 单行原始内容
 * @returns 解析出的键值；空行、注释行或格式不合法时返回 null
 */
function parseKeyValue(
  line: string,
): { key: string; value: string | boolean } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return null
  }

  const separatorIndex = trimmed.indexOf(':')
  if (separatorIndex === -1) {
    return null
  }

  const key = trimmed.slice(0, separatorIndex).trim()
  if (!key) {
    return null
  }

  const rawValue = trimmed.slice(separatorIndex + 1).trim()

  // 布尔值
  if (rawValue === 'true') {
    return { key, value: true }
  }
  if (rawValue === 'false') {
    return { key, value: false }
  }

  // 字符串（去掉首尾引号）
  const value = rawValue.replace(/^["']|["']$/g, '')
  return { key, value }
}
