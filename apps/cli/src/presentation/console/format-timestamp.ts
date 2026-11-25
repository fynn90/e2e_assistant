/**
 * 面板中时间字段的格式化。
 *
 * 运行态记录里的 `startedAt` 是 ISO 8601（带时区偏移的 UTC 表示），直接打印
 * 既冗长又不直观；面板上统一转成本地时区的 `YYYY-MM-DD HH:mm:ss`。
 */

/** 不足两位时左补零。 */
function padTwoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 把 ISO 时间字符串格式化为本地时区的 `YYYY-MM-DD HH:mm:ss`。
 *
 * 解析失败时返回 null 而不是抛错——面板上的一个时间字段不该让整次启动失败，
 * 调用方据此决定不渲染该行。
 *
 * @param isoTimestamp - ISO 8601 时间字符串，如运行态记录里的 `startedAt`。
 * @returns 本地时间文本；取值缺失或无法解析时返回 null。
 * @throws 不抛出异常。
 */
export function formatLocalTimestamp(
  isoTimestamp: string | undefined,
): string | null {
  if (!isoTimestamp) {
    return null
  }

  const timestamp = new Date(isoTimestamp)

  if (Number.isNaN(timestamp.getTime())) {
    return null
  }

  const datePart = `${timestamp.getFullYear()}-${padTwoDigits(timestamp.getMonth() + 1)}-${padTwoDigits(timestamp.getDate())}`
  const timePart = `${padTwoDigits(timestamp.getHours())}:${padTwoDigits(timestamp.getMinutes())}:${padTwoDigits(timestamp.getSeconds())}`

  return `${datePart} ${timePart}`
}

/** 一小时的毫秒数。 */
const MILLISECONDS_PER_HOUR = 3_600_000
/** 一天的毫秒数。 */
const MILLISECONDS_PER_DAY = 86_400_000
/** 一分钟内视为「刚刚启动」的阈值。 */
const JUST_STARTED_THRESHOLD_MS = 60_000

/**
 * 把启动时刻换算成「已运行多久」的中文描述。
 *
 * 用于 status 面板：用户想知道服务跑了多久，而 `startedAt` 的绝对时刻
 * 需要自己心算。不到 24 小时按「小时 + 分钟」表述，超过则改用「天 + 小时」——
 * 「运行了 50 小时」远不如「运行了 2 天 2 小时」直观。
 *
 * 解析失败返回 null（调用方据此不渲染该行）；时钟回拨导致的负时长按
 * `刚刚启动` 处理，不显示负数——那会让用户以为出了故障。
 *
 * @param isoTimestamp - 服务启动时刻（ISO 8601）。
 * @param now - 当前时刻；缺省取系统时间，测试可注入以获得确定结果。
 * @returns 中文时长描述；取值缺失或无法解析时返回 null。
 * @throws 不抛出异常。
 */
export function formatElapsedDuration(
  isoTimestamp: string | undefined,
  now: Date = new Date(),
): string | null {
  if (!isoTimestamp) {
    return null
  }

  const startedAt = new Date(isoTimestamp)

  if (Number.isNaN(startedAt.getTime())) {
    return null
  }

  const elapsedMs = now.getTime() - startedAt.getTime()

  if (elapsedMs < JUST_STARTED_THRESHOLD_MS) {
    return '刚刚启动'
  }

  if (elapsedMs < MILLISECONDS_PER_HOUR) {
    return `${Math.floor(elapsedMs / 60_000)} 分钟`
  }

  if (elapsedMs < MILLISECONDS_PER_DAY) {
    const hours = Math.floor(elapsedMs / MILLISECONDS_PER_HOUR)
    const minutes = Math.floor((elapsedMs % MILLISECONDS_PER_HOUR) / 60_000)
    // 分钟为 0 时省略，避免「运行了 2 小时 0 分」这种啰嗦表述。
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  }

  const days = Math.floor(elapsedMs / MILLISECONDS_PER_DAY)
  const hours = Math.floor(
    (elapsedMs % MILLISECONDS_PER_DAY) / MILLISECONDS_PER_HOUR,
  )

  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
}
