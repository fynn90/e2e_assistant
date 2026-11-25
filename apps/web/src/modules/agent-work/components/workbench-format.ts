/**
 * 工作台卡片的展示格式化（纯函数，供 v17 各卡片共用）。
 *
 * 为什么抽出来：同一组数字（耗时、时间戳、字节数、结果统计）在清单卡、历史卡、
 * 连续执行卡里都要展示，各自实现一份迟早出现「同一次执行在这张卡显示 12.3s、
 * 在那张卡显示 12345ms」的不一致。
 */

/**
 * 把毫秒时长格式化为可读文本。
 *
 * @param durationMs - 毫秒时长；缺失或非法时返回 '-'。
 * @returns 形如「850ms / 12.3s / 2m 05s」的文本。
 * @throws 不抛出异常。
 */
export function formatDuration(durationMs: number | undefined): string {
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return '-'
  }
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`
}

/**
 * 把 ISO 时间格式化为本地可读文本。
 *
 * @param isoText - ISO 8601 字符串。
 * @returns 本地时区的可读时间；解析失败时原样返回输入。
 * @throws 不抛出异常。
 */
export function formatTimestamp(isoText: string): string {
  if (!isoText) return ''
  const parsed = Date.parse(isoText)
  return Number.isNaN(parsed) ? isoText : new Date(parsed).toLocaleString()
}

/**
 * 把字节数格式化为可读文本（报告清理卡展示「将释放多少空间」）。
 *
 * @param bytes - 字节数；缺失或负数时返回空串（不占位）。
 * @returns 形如「1.2 MB / 340 KB / 512 B」的文本。
 * @throws 不抛出异常。
 */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return ''
  }
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** 结果统计的摘要文本（「通过 3 / 失败 1 / 跳过 1」式的紧凑表达）。 */
export interface IRunCountsSummary {
  passed?: number
  failed?: number
  interrupted?: number
  skipped?: number
}

/**
 * 把结果统计拼成一句紧凑文本，零值项不出现（零值行是噪音）。
 *
 * @param counts - 各状态计数。
 * @returns 形如「通过 3 · 失败 1」的文本；全为零时返回「无结果」。
 * @throws 不抛出异常。
 */
export function formatRunCounts(counts: IRunCountsSummary): string {
  const parts: string[] = []
  if ((counts.passed ?? 0) > 0) parts.push(`通过 ${counts.passed}`)
  if ((counts.failed ?? 0) > 0) parts.push(`失败 ${counts.failed}`)
  if ((counts.interrupted ?? 0) > 0) parts.push(`中断 ${counts.interrupted}`)
  if ((counts.skipped ?? 0) > 0) parts.push(`跳过 ${counts.skipped}`)
  return parts.length > 0 ? parts.join(' · ') : '无结果'
}

/**
 * 判读一次执行的结果态别（清单卡与历史卡的状态着色依据）。
 *
 * @param counts - 各状态计数。
 * @returns `failed`（有失败）/ `interrupted`（有中断且无失败）/ `passed`（其余）。
 * @throws 不抛出异常。
 */
export function runOutcomeKind(
  counts: IRunCountsSummary,
): 'passed' | 'failed' | 'interrupted' {
  if ((counts.failed ?? 0) > 0) return 'failed'
  if ((counts.interrupted ?? 0) > 0) return 'interrupted'
  return 'passed'
}
