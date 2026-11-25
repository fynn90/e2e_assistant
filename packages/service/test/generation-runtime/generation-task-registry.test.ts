/**
 * 验证生成任务注册表的 per-Skill 排他语义（v7 PRD 4.3）。
 */
import { describe, expect, it } from 'vitest'
import { createGenerationTaskRegistry } from '../../src/generation-runtime'

describe('createGenerationTaskRegistry', () => {
  it('同一 Skill 只允许一个生成任务，第二个请求被明确拒绝', () => {
    const registry = createGenerationTaskRegistry()
    const lease = registry.acquire('abc123def', 'session-1')

    // 拒绝而非排队：并发生成会争用浏览器与试运行的本机资源。
    expect(() => registry.acquire('abc123def', 'session-2')).toThrowError(
      expect.objectContaining({
        code: 'CHAT_CONCURRENCY_LIMITED',
        status: 429,
      }),
    )

    lease.release()
  })

  it('不同 Skill 之间互不影响', () => {
    const registry = createGenerationTaskRegistry()
    const first = registry.acquire('abc123def', 'session-1')

    expect(() => registry.acquire('xyz789abc', 'session-2')).not.toThrow()

    first.release()
  })

  it('释放后可以再次占用，重复释放安全', () => {
    const registry = createGenerationTaskRegistry()
    const lease = registry.acquire('abc123def', 'session-1')

    lease.release()
    // 幂等：任务终态可能同时从 finally 与异常分支释放。
    expect(() => lease.release()).not.toThrow()
    expect(() => registry.acquire('abc123def', 'session-2')).not.toThrow()
  })

  it('currentSessionId 反映当前占用者，释放后回到空闲', () => {
    const registry = createGenerationTaskRegistry()

    expect(registry.currentSessionId('abc123def')).toBeUndefined()

    const lease = registry.acquire('abc123def', 'session-1')
    expect(registry.currentSessionId('abc123def')).toBe('session-1')

    lease.release()
    expect(registry.currentSessionId('abc123def')).toBeUndefined()
  })

  it('释放后再占用时，旧租约重复释放不会误删新占用', () => {
    const registry = createGenerationTaskRegistry()
    const stale = registry.acquire('abc123def', 'session-1')
    stale.release()

    const current = registry.acquire('abc123def', 'session-2')
    // 旧租约即便被重复释放（例如同时从 finally 与异常分支触发），
    // 也只能是空操作，不能把新任务的占用清掉。
    stale.release()

    expect(registry.currentSessionId('abc123def')).toBe('session-2')
    current.release()
    expect(registry.currentSessionId('abc123def')).toBeUndefined()
  })
})
