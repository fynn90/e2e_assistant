/**
 * render_view 工具（v17 §5.1）的单元测试。
 *
 * 本组的核心是**协议传的是选择，不是数据**：
 *   ① 参数校验挡住坏卡片（缺 skillId、给多余的 skillId）；
 *   ② 宿主收到的参数里**没有任何数据字段**——模型传的数据一律被忽略；
 *   ③ 对同一参数两次调用应得到等价的宿主调用（平台自取的确定性）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { TWorkbenchRenderParams } from '@charlie_deng/e2e-assistant-types'
import {
  createRenderViewTool,
  type IViewHost,
} from '../../src/tools/render-view'

/** 构造一个记录调用参数的视图宿主替身。 */
function createHost (): {
  host: IViewHost
  calls: TWorkbenchRenderParams[]
} {
  const calls: TWorkbenchRenderParams[] = []
  return {
    host: {
      async renderView (params) {
        calls.push(params)
        return { ok: true, message: '卡片已上屏' }
      },
    },
    calls,
  }
}

describe('render_view 的参数校验', () => {
  it('skill-detail 缺 skillId → 拒绝且提示可自修复', async () => {
    const { host, calls } = createHost()
    const tool = createRenderViewTool(host)

    const result = await tool.execute(
      'call-1',
      { viewKind: 'skill-detail' },
      undefined,
      undefined,
    )

    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('需要目标用例的九位唯一 ID')
    expect(text).toContain('list_skills')
    expect(result.details.ok).toBe(false)
    // 本地就拦住，不打一次无谓的宿主调用。
    expect(calls).toHaveLength(0)
  })

  it('run-history / readiness 同样要求 skillId', async () => {
    const { host } = createHost()
    const tool = createRenderViewTool(host)

    for (const viewKind of ['run-history', 'readiness'] as const) {
      const result = await tool.execute(
        'call-1',
        { viewKind },
        undefined,
        undefined,
      )
      expect(result.details.ok).toBe(false)
    }
  })

  it('skill-list 传了 skillId → 拒绝（它是跨用例的视图）', async () => {
    const { host, calls } = createHost()
    const tool = createRenderViewTool(host)

    const result = await tool.execute(
      'call-1',
      { viewKind: 'skill-list', skillId: 'abc123456' },
      undefined,
      undefined,
    )

    expect(result.details.ok).toBe(false)
    if (result.content[0]?.type === 'text') {
      expect(result.content[0].text).toContain('不接受 skillId')
    }
    expect(calls).toHaveLength(0)
  })

  it('capability 无参数 → 放行，且宿主收到的参数只有 viewKind', async () => {
    const { host, calls } = createHost()
    const tool = createRenderViewTool(host)

    const result = await tool.execute(
      'call-1',
      { viewKind: 'capability' },
      undefined,
      undefined,
    )

    expect(result.details.ok).toBe(true)
    expect(calls).toEqual([{ viewKind: 'capability' }])
  })

  it('skill-list 带筛选 → 只有筛选条件，没有数据字段（协议传选择）', async () => {
    const { host, calls } = createHost()
    const tool = createRenderViewTool(host)

    await tool.execute(
      'call-1',
      { viewKind: 'skill-list', status: 'last-failed', keyword: '登录' },
      undefined,
      undefined,
    )

    expect(calls).toHaveLength(1)
    // **关键断言**：宿主收到的参数里没有 rows / payload / data 这类数据字段。
    const params = calls[0] as Record<string, unknown>
    expect(Object.keys(params).sort()).toEqual([
      'keyword',
      'status',
      'viewKind',
    ])
  })

  it('模型多传的数据字段被忽略（注入伪造数据的回归）', async () => {
    const { host, calls } = createHost()
    const tool = createRenderViewTool(host)

    // 模拟模型硬塞一个 rows 字段（协议不允许，但参数是松对象）。
    await tool.execute(
      'call-1',
      {
        viewKind: 'skill-list',
        // @ts-expect-error 故意传 schema 之外的字段，验证它被丢弃。
        rows: [{ skillId: 'fake', title: '伪造的行' }],
      },
      undefined,
      undefined,
    )

    const params = calls[0] as Record<string, unknown>
    expect(params.rows).toBeUndefined()
    expect(Object.keys(params)).toEqual(['viewKind'])
  })

  it('空白 skillId 按缺失处理（不做 trim 后成空的漏网）', async () => {
    const { host, calls } = createHost()
    const tool = createRenderViewTool(host)

    await tool.execute(
      'call-1',
      { viewKind: 'skill-detail', skillId: '   ' },
      undefined,
      undefined,
    )

    expect(calls).toHaveLength(0)
  })
})

describe('render_view 的宿主结果透传', () => {
  it('宿主拒绝时把原因与引导交给模型（不编造卡片）', async () => {
    const host: IViewHost = {
      async renderView () {
        return { ok: false, message: '工作区内不存在该用例。' }
      },
    }
    const tool = createRenderViewTool(host)

    const result = await tool.execute(
      'call-1',
      { viewKind: 'skill-detail', skillId: 'abc123456' },
      undefined,
      undefined,
    )

    expect(result.details.ok).toBe(false)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('工作区内不存在该用例')
    expect(text).toContain('不要编造一个已经出现的卡片')
  })

  it('同一参数两次调用 → 宿主收到等价参数（平台自取的确定性）', async () => {
    const { host, calls } = createHost()
    const tool = createRenderViewTool(host)
    const params = { viewKind: 'run-history', skillId: 'abc123456' } as const

    await tool.execute('call-1', params, undefined, undefined)
    await tool.execute('call-2', params, undefined, undefined)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
  })
})
