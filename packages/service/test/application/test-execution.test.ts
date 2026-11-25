/** 验证执行就绪校验（J2/J4/J5/J6）与执行事件总线的 seq/环形缓冲/补发（v11）。 */

import { describe, expect, it } from 'vitest'
import {
  checkBaseUrlConfigured,
  checkEnvReferencesForExecution,
  checkExecutionMutex,
  checkScriptHasTests,
} from '../../src/application/test-execution/execution-precheck'
import { createExecutionEventBus } from '../../src/application/test-execution/execution-event-bus'

const scriptWithTest = `
  import { test, expect } from '@playwright/test'
  test('登录成功', async ({ page }) => {
    await test.step('step_login', async () => {
      await expect(page).toHaveTitle(/工作台/)
    })
  })
`

describe('checkScriptHasTests（J2）', () => {
  it('空文件与纯辅助函数不通过', () => {
    expect(checkScriptHasTests('')).toHaveLength(1)
    expect(checkScriptHasTests('// 注释')).toHaveLength(1)
    expect(
      checkScriptHasTests('export function helper() { return 1 }'),
    ).toHaveLength(1)
  })

  it('包含 test() 的脚本通过', () => {
    expect(checkScriptHasTests(scriptWithTest)).toHaveLength(0)
  })
})

describe('checkEnvReferencesForExecution（J4）', () => {
  it('脚本无 process.env 引用时 env.json 缺失也不阻断', () => {
    const issues = checkEnvReferencesForExecution(scriptWithTest, {
      status: 'missing',
    })
    expect(issues).toHaveLength(0)
  })

  it('引用的 key 全部缺失时逐 key 列出问题', () => {
    const script = `${scriptWithTest}\nconst a = process.env.E2E_A; const b = process.env.E2E_B`
    const issues = checkEnvReferencesForExecution(script, {
      status: 'ok',
      keys: new Set(['E2E_A']),
      values: { E2E_A: 'x' },
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('E2E_B')
  })

  it('全部 key 就绪时通过', () => {
    const script = `${scriptWithTest}\nconst a = process.env.E2E_A`
    const issues = checkEnvReferencesForExecution(script, {
      status: 'ok',
      keys: new Set(['E2E_A']),
      values: { E2E_A: 'x' },
    })
    expect(issues).toHaveLength(0)
  })

  it('env.json 非法且脚本存在引用时阻断并提示修复', () => {
    const script = `${scriptWithTest}\nconst a = process.env.E2E_A`
    const issues = checkEnvReferencesForExecution(script, { status: 'invalid' })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.target).toBe('env-file')
  })
})

describe('checkBaseUrlConfigured（J5）', () => {
  it('空值阻断并携带跳转目标', () => {
    for (const value of [undefined, null, '', '   ']) {
      const issues = checkBaseUrlConfigured(value)
      expect(issues).toHaveLength(1)
      expect(issues[0]?.target).toBe('test-case')
    }
  })

  it('已配置时通过', () => {
    expect(checkBaseUrlConfigured('https://example.test')).toHaveLength(0)
  })
})

describe('checkExecutionMutex（J6）', () => {
  it('有任务运行时阻断', () => {
    const issues = checkExecutionMutex('session-1')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('生成/执行')
  })

  it('空闲时通过', () => {
    expect(checkExecutionMutex(undefined)).toHaveLength(0)
  })
})

describe('createExecutionEventBus', () => {
  it('seq 单调分配', () => {
    const bus = createExecutionEventBus()
    const first = bus.publish('run-1', { type: 'log', line: 'a' })
    const second = bus.publish('run-1', { type: 'log', line: 'b' })
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
  })

  it('afterSeq 补发缓冲内缺口；undefined 从头回放', () => {
    const bus = createExecutionEventBus()
    bus.publish('run-1', { type: 'log', line: 'a' })
    bus.publish('run-1', { type: 'log', line: 'b' })
    bus.publish('run-1', { type: 'log', line: 'c' })

    const received: number[] = []
    bus.subscribe('run-1', 1, (event) => received.push(event.seq))()
    expect(received).toEqual([2, 3])

    const replayed: number[] = []
    bus.subscribe('run-1', undefined, (event) => replayed.push(event.seq))()
    expect(replayed).toEqual([1, 2, 3])
  })

  it('log 行超出容量时淘汰最旧且保持结构化事件全量', () => {
    const bus = createExecutionEventBus({ logCapacity: 3 })

    bus.publish('run-1', { type: 'log', line: 'l1' })
    bus.publish('run-1', { type: 'log', line: 'l2' })
    bus.publish('run-1', { type: 'test-start', title: 't' })
    bus.publish('run-1', { type: 'log', line: 'l3' })
    bus.publish('run-1', { type: 'log', line: 'l4' })
    bus.publish('run-1', { type: 'log', line: 'l5' })

    const buffer: Array<{ seq: number; type: string }> = []
    bus.subscribe('run-1', undefined, (event) =>
      buffer.push({ seq: event.seq, type: event.type }),
    )()

    const logCount = buffer.filter((item) => item.type === 'log').length
    expect(logCount).toBeLessThanOrEqual(3)
    // 结构化事件不被 log 淘汰逻辑清除。
    expect(buffer.some((item) => item.type === 'test-start')).toBe(true)
    // seq 单调不减。
    const seqs = buffer.map((item) => item.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })

  it('dispose 释放通道', () => {
    const bus = createExecutionEventBus()
    bus.publish('run-1', { type: 'log', line: 'a' })
    bus.dispose('run-1')
    expect(bus.currentSeq('run-1')).toBe(0)
  })
})
