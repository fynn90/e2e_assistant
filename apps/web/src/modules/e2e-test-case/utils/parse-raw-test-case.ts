/**
 * 解析原始 e2e_schema.json 文本，并提供包含行列信息的可恢复错误。
 */
import { parseE2ETestCase, type IE2ETestCase } from '@authine-e2e-agent/types'

export class RawE2ETestCaseParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RawE2ETestCaseParseError'
  }
}

/**
 * 将原始 JSON 文本解析为共享 E2E 领域对象。
 *
 * @param content - Monaco 原始编辑器中的 JSON 文本。
 * @returns 通过共享 Zod Schema 校验的 E2E 用例。
 * @throws RawE2ETestCaseParseError 当 JSON 或 Schema 不合法时抛出。
 */
export function parseRawE2ETestCase(content: string): IE2ETestCase {
  let input: unknown

  try {
    input = JSON.parse(content)
  } catch (error) {
    throw new RawE2ETestCaseParseError(formatJsonParseError(content, error), {
      cause: error,
    })
  }

  try {
    return parseE2ETestCase(input)
  } catch (error) {
    const firstIssue = getFirstSchemaIssue(error)
    throw new RawE2ETestCaseParseError(
      firstIssue
        ? `Schema 校验失败（${firstIssue.path}）：${firstIssue.message}`
        : 'Schema 校验失败。',
      { cause: error },
    )
  }
}

function formatJsonParseError(content: string, error: unknown): string {
  const message = error instanceof Error ? error.message : 'JSON 格式不正确。'
  const positionMatch = /position\s+(\d+)/i.exec(message)

  if (!positionMatch) {
    return `JSON 格式错误：${message}`
  }

  const position = Number(positionMatch[1])
  const prefix = content.slice(0, position)
  const line = prefix.split('\n').length
  const lastLineBreak = prefix.lastIndexOf('\n')
  const column = position - lastLineBreak
  return `JSON 格式错误（第 ${line} 行，第 ${column} 列）：${message}`
}

function getFirstSchemaIssue(
  error: unknown,
): { path: string; message: string } | null {
  if (!error || typeof error !== 'object' || !('issues' in error)) {
    return null
  }

  const issues = (error as { issues?: unknown }).issues

  if (!Array.isArray(issues) || !issues[0] || typeof issues[0] !== 'object') {
    return null
  }

  const issue = issues[0] as { path?: unknown; message?: unknown }
  return {
    path: Array.isArray(issue.path)
      ? issue.path.join('.') || '<root>'
      : '<root>',
    message:
      typeof issue.message === 'string' ? issue.message : '数据结构不正确。',
  }
}
