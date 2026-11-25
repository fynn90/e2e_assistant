/**
 * 请求日志降噪规则测试（v19 §5 / AC-05）。
 *
 * 规则只有一条：`/assets/*` 且**成功**的请求不打印；其余一律保持。
 * 四象限断言把「什么算噪声」固定下来，防止后续放宽到 `/api/*` 或连错误也静默。
 */
import { describe, expect, it } from 'vitest'
import { isQuietHttpRequest } from '../../src/http/logger'

function entry(path: string, status: number) {
  return {
    requestId: 'request-test-id',
    method: 'GET',
    path,
    status,
    durationMs: 3,
  }
}

describe('isQuietHttpRequest', () => {
  it('静态资源成功请求属噪声', () => {
    expect(isQuietHttpRequest(entry('/assets/index-abc123.js', 200))).toBe(true)
    expect(isQuietHttpRequest(entry('/assets/index-abc123.css', 304))).toBe(true)
  })

  it('静态资源失败请求仍要记录', () => {
    // 前端产物缺失往往表现为这里的 404，静默会让它变成无从排查的空白页。
    expect(isQuietHttpRequest(entry('/assets/missing.js', 404))).toBe(false)
    expect(isQuietHttpRequest(entry('/assets/index.js', 500))).toBe(false)
  })

  it('API 与健康检查请求不受影响', () => {
    expect(isQuietHttpRequest(entry('/api/skills', 200))).toBe(false)
    expect(isQuietHttpRequest(entry('/health', 200))).toBe(false)
  })

  it('与 /assets 前缀相似但不属于静态目录的路径不被静默', () => {
    expect(isQuietHttpRequest(entry('/assets-backup/x.js', 200))).toBe(false)
    expect(isQuietHttpRequest(entry('/', 200))).toBe(false)
  })
})
