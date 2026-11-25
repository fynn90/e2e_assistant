/**
 * 工具追踪数据的 JSON 安全规范化与客户端安全预览工具。
 *
 * 本模块隔离持久化序列化和 UI 脱敏逻辑：原始追踪记录需要可 JSON 化，客户端预览则必须
 * 防止敏感字段、二进制内容和无限制大文本穿透 SSE。
 */

/** JSON 可安全写入持久化介质的值结构。 */
export type TJsonSafeValue =
  | string
  | number
  | boolean
  | null
  | TJsonSafeValue[]
  | { [key: string]: TJsonSafeValue }

/** 安全预览的默认递归深度。 */
const DEFAULT_MAX_DEPTH = 6
/**
 * 安全预览单个字符串的默认最大长度。
 *
 * v12-pre：与引擎的快照上限（240_000）对齐，否则 browser_snapshot 返回的完整
 * 页面快照会在工具审计与客户端预览链路被截到 4k，Agent 看到的与用户回看的不是同一份内容。
 * 图片类字段不受本常量影响——BINARY_KEY_PATTERN 会在长度判断之前把它们替换为占位摘要。
 */
const DEFAULT_MAX_STRING_LENGTH = 240_000
/** 安全预览单个数组的默认最大元素数。 */
const DEFAULT_MAX_ARRAY_LENGTH = 50
/** 安全预览单个对象的默认最大属性数。 */
const DEFAULT_MAX_OBJECT_KEYS = 50

/** 需要在客户端预览中遮蔽的字段名片段。 */
const SENSITIVE_KEY_PATTERN =
  /api[-_]?key|authorization|password|passwd|secret|token|credential|cookie/i
/** 可能承载图片或 base64 二进制内容的字段名片段。 */
const BINARY_KEY_PATTERN = /^(data|base64|binary|bytes)$/i

/**
 * 将未知值转换成无循环引用、无函数和无 bigint 的 JSON 安全值。
 *
 * @param value - 需要持久化的未知值。
 * @returns 可稳定 JSON.stringify 的深拷贝值。
 */
export function toJsonSafeValue(value: unknown): TJsonSafeValue {
  return normalizeValue(value, new WeakSet<object>())
}

/**
 * 将持久化值转换为可经 SSE 发送的安全预览。
 *
 * @param value - 原始或已经 JSON 安全化的值。
 * @returns 预览值与是否发生遮蔽、截断或摘要替换的标志。
 */
export function toSafePreview(value: unknown): {
  value: TJsonSafeValue
  truncated: boolean
} {
  return previewValue(toJsonSafeValue(value), {
    depth: 0,
    key: undefined,
  })
}

/**
 * 递归规范化未知值，消除 JSON.stringify 不支持的结构。
 *
 * @param value - 当前待规范化值。
 * @param seen - 已访问对象集合，用于处理循环引用。
 * @returns JSON 安全值。
 */
function normalizeValue(value: unknown, seen: WeakSet<object>): TJsonSafeValue {
  if (value === null) return null

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return `${value}n`
    case 'undefined':
      return '[undefined]'
    case 'symbol':
      return `[symbol:${value.description ?? ''}]`
    case 'function':
      return `[function:${value.name || 'anonymous'}]`
    case 'object':
      break
    default:
      return String(value)
  }

  if (value instanceof Date) {
    return value.toISOString()
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    }
  }
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const result = value.map((item) => normalizeValue(item, seen))
    seen.delete(value)
    return result
  }

  const result: { [key: string]: TJsonSafeValue } = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = normalizeValue(item, seen)
  }
  seen.delete(value)
  return result
}

/**
 * 递归生成面向客户端的安全预览。
 *
 * @param value - 已 JSON 安全化的当前值。
 * @param context - 当前递归层级及字段名。
 * @returns 安全值与处理标记。
 */
function previewValue(
  value: TJsonSafeValue,
  context: { depth: number; key: string | undefined },
): { value: TJsonSafeValue; truncated: boolean } {
  if (context.key && SENSITIVE_KEY_PATTERN.test(context.key)) {
    return { value: '[已脱敏]', truncated: true }
  }
  if (
    context.key &&
    BINARY_KEY_PATTERN.test(context.key) &&
    typeof value === 'string'
  ) {
    return {
      value: `[二进制内容，长度 ${value.length}]`,
      truncated: true,
    }
  }
  if (context.depth >= DEFAULT_MAX_DEPTH) {
    return { value: '[层级过深，已截断]', truncated: true }
  }
  if (typeof value === 'string') {
    return value.length > DEFAULT_MAX_STRING_LENGTH
      ? {
          value: `${value.slice(0, DEFAULT_MAX_STRING_LENGTH)}…[已截断，共 ${value.length} 字符]`,
          truncated: true,
        }
      : { value, truncated: false }
  }
  if (typeof value !== 'object' || value === null) {
    return { value, truncated: false }
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, DEFAULT_MAX_ARRAY_LENGTH)
      .map((item) =>
        previewValue(item, { depth: context.depth + 1, key: undefined }),
      )
    const childTruncated = items.some((item) => item.truncated)
    const truncated = childTruncated || value.length > DEFAULT_MAX_ARRAY_LENGTH
    const preview = items.map((item) => item.value)
    if (value.length > DEFAULT_MAX_ARRAY_LENGTH) {
      preview.push(`[其余 ${value.length - DEFAULT_MAX_ARRAY_LENGTH} 项已截断]`)
    }
    return { value: preview, truncated }
  }

  const entries = Object.entries(value)
  const preview: { [key: string]: TJsonSafeValue } = {}
  let truncated = entries.length > DEFAULT_MAX_OBJECT_KEYS
  for (const [key, item] of entries.slice(0, DEFAULT_MAX_OBJECT_KEYS)) {
    const result = previewValue(item, { depth: context.depth + 1, key })
    preview[key] = result.value
    truncated ||= result.truncated
  }
  if (entries.length > DEFAULT_MAX_OBJECT_KEYS) {
    preview.__truncated__ = `其余 ${entries.length - DEFAULT_MAX_OBJECT_KEYS} 个字段已截断`
  }
  return { value: preview, truncated }
}
