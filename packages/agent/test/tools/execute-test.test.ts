/**
 * execute_test 工具（v16 放开 skillId）的单元测试。
 *
 * 覆盖三件事：缺参 / 非法 ID 被拦下且提示可自修复；合法 ID 透传宿主；
 * 宿主失败结果原样转述（含不得重试的指令）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createExecuteTestTool,
  type ITestRunnerHost,
} from '../../src/tools/execute_test'

/** 构造可观测的执行宿主替身。 */
function createHost(overrides: Partial<ITestRunnerHost> = {}): {
  host: ITestRunnerHost
  startExecution: ReturnType<typeof vi.fn>
} {
  const startExecution = vi.fn(async () => ({
    ok: true as const,
    executionId: 'exec-1',
    message: '已发起执行。',
  }))
  return {
    host: { startExecution, ...overrides },
    startExecution,
  }
}

describe('execute_test 的 skillId 校验', () => {
  it('非法 ID 被拦下且提示先检索（不触达宿主）', async () => {
    const { host, startExecution } = createHost()
    const tool = createExecuteTestTool(host)

    const result = await tool.execute(
      'call-1',
      { skillId: '云7登录' },
      undefined,
      undefined,
    )

    expect(startExecution).not.toHaveBeenCalled()
    expect(result.details.ok).toBe(false)
    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('九位')
    expect(text).toContain('list_skills')
  })

  it('合法 ID 原样透传给宿主（目标是唯一 ID，不是路径）', async () => {
    const { host, startExecution } = createHost()
    const tool = createExecuteTestTool(host)

    const result = await tool.execute(
      'call-1',
      { skillId: 'abc123456' },
      undefined,
      undefined,
    )

    expect(startExecution).toHaveBeenCalledWith({ skillId: 'abc123456' })
    expect(result.details).toMatchObject({ ok: true, executionId: 'exec-1' })
  })

  it('取消信号随会话中止透传', async () => {
    const { host, startExecution } = createHost()
    const tool = createExecuteTestTool(host)
    const controller = new AbortController()

    await tool.execute(
      'call-1',
      { skillId: 'abc123456' },
      controller.signal,
      undefined,
    )

    expect(startExecution).toHaveBeenCalledWith({
      skillId: 'abc123456',
      signal: controller.signal,
    })
  })

  it('就绪失败时列出全部问题并要求如实转述、不得重试', async () => {
    const { host } = createHost({
      startExecution: async () => ({
        ok: false as const,
        issues: [
          {
            code: 'ENV_REFERENCE_MISSING',
            message: 'env.json 缺少 key：E2E_PASSWORD',
          },
          {
            code: 'EXECUTION_NO_TESTS',
            message: 'test.spec.ts 中没有测试定义。',
          },
        ],
      }),
    })
    const tool = createExecuteTestTool(host)

    const result = await tool.execute(
      'call-1',
      { skillId: 'abc123456' },
      undefined,
      undefined,
    )

    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('E2E_PASSWORD')
    expect(text).toContain('test.spec.ts 中没有测试定义')
    expect(text).toContain('不要重试')
    expect(result.details.ok).toBe(false)
    expect(result.details.issues).toHaveLength(2)
  })
})
