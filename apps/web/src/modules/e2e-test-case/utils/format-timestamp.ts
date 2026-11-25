/**
 * 将脚本时间戳格式化为中文相对时间和可审阅的完整本地时间。
 */
export interface IFormattedTimestamp {
  label: string
  title: string
}

/**
 * 格式化 ISO 时间戳，近期时间使用相对表达，title 保留完整本地时间。
 * @param value ISO 时间戳。
 * @param now 当前时间，测试可注入固定值。
 * @returns 短标签和完整本地时间；无效输入原样返回。
 * @throws 不抛出异常。
 */
export function formatTimestamp(
  value: string,
  now: Date = new Date(),
): IFormattedTimestamp {
  const timestamp = new Date(value)

  if (Number.isNaN(timestamp.getTime())) {
    return { label: value, title: value }
  }

  const title = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
  }).format(timestamp)
  const elapsedMilliseconds = Math.max(0, now.getTime() - timestamp.getTime())
  const elapsedMinutes = Math.floor(elapsedMilliseconds / 60_000)

  if (elapsedMinutes < 1) return { label: '刚刚', title }
  if (elapsedMinutes < 60) return { label: `${elapsedMinutes} 分钟前`, title }

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return { label: `${elapsedHours} 小时前`, title }

  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) return { label: `${elapsedDays} 天前`, title }

  return { label: title, title }
}
