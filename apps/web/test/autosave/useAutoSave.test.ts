/**
 * 实时保存编排的单元测试（PRD 7.2–7.6 / AC-09、AC-10）。
 *
 * 覆盖：防抖合并、跳过无变化、串行（保存期间新改动进入下一轮）、
 * 退避重试 1s/2s/4s、重试耗尽转 failed、冲突转 conflict 不重试、
 * flushSilently 等待待发改动、失败不回滚本地内容。
 */
import { defineComponent, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../src/services/http-client'
import { useAutoSave } from '../../src/common/autosave/useAutoSave'
import type {
  ISaveTarget,
  ISaveTargetResult,
} from '../../src/common/autosave/types'

/** 构造一个记录调用、可编排结果的保存目标。 */
function createTarget(
  options: {
    key?: string
    results?: Array<ISaveTargetResult | Error>
  } = {},
) {
  const calls: string[] = []
  const results = [...(options.results ?? [])]
  const target: ISaveTarget = {
    key: options.key ?? 'SKILL.md',
    async save(content) {
      calls.push(content)
      const next = results.shift()
      if (next instanceof Error) throw next
      return next ?? { version: 'v'.repeat(64), diagnostics: [] }
    },
  }
  return { target, calls }
}

/**
 * 挂载一个持有 useAutoSave 的宿主组件。
 *
 * useAutoSave 依赖 onBeforeUnmount 与 watch，必须在组件 setup 中运行。
 */
function mountAutoSave(setup: () => ReturnType<typeof useAutoSave>) {
  let api!: ReturnType<typeof useAutoSave>
  const wrapper = mount(
    defineComponent({
      setup() {
        api = setup()
        return () => null
      },
    }),
  )
  return { api, wrapper }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAutoSave 防抖与合并（PRD 7.3）', () => {
  it('连续 markDirty 只发起一次请求', async () => {
    const content = ref('a')
    const { target, calls } = createTarget()
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = 'b'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(300)
    content.value = 'c'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(300)
    content.value = 'd'
    api.markDirty()

    // 防抖窗口内多次输入尚未触发请求。
    expect(calls).toEqual([])

    await vi.advanceTimersByTimeAsync(800)
    // 合并为一次请求，发送最后一次内容。
    expect(calls).toEqual(['d'])
    expect(api.state.value).toBe('saved')
    wrapper.unmount()
  })

  it('内容改回原样时不发起请求', async () => {
    const content = ref('original')
    const { target, calls } = createTarget()
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    // 先建立基准：成功保存一次。
    content.value = 'changed'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)
    expect(calls).toEqual(['changed'])

    // 改回原样后再改回来：内容与基准一致，不得发请求。
    content.value = 'original'
    api.markDirty()
    content.value = 'changed'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)

    expect(calls).toEqual(['changed'])
    expect(api.state.value).toBe('saved')
    wrapper.unmount()
  })

  it('输入时状态立即变为 pending，不等待网络', () => {
    const content = ref('a')
    const { target } = createTarget()
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = 'b'
    api.markDirty()

    expect(api.state.value).toBe('pending')
    expect(api.dirty.value).toBe(true)
    wrapper.unmount()
  })
})

describe('useAutoSave 串行与合并（PRD 7.3）', () => {
  it('保存期间的新改动在下一轮合并发送', async () => {
    const content = ref('a')
    const pendingResolvers: Array<(value: ISaveTargetResult) => void> = []
    const calls: string[] = []
    const target: ISaveTarget = {
      key: 'SKILL.md',
      save(next) {
        calls.push(next)
        return new Promise((resolve) => pendingResolvers.push(resolve))
      },
    }
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = 'first'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)
    expect(calls).toEqual(['first'])

    // 第一轮在途时用户继续输入：不得并发发送，进入下一轮。
    content.value = 'second'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)
    expect(calls).toEqual(['first'])

    pendingResolvers.shift()!({
      version: 'v1'.padEnd(64, '0'),
      diagnostics: [],
    })
    await vi.advanceTimersByTimeAsync(0)

    // 第一轮完成后发起合并后的第二轮。
    expect(calls).toEqual(['first', 'second'])
    pendingResolvers.shift()!({
      version: 'v2'.padEnd(64, '0'),
      diagnostics: [],
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(api.state.value).toBe('saved')
    wrapper.unmount()
  })
})

describe('useAutoSave 失败处理（PRD 7.5 / AC-10）', () => {
  it('失败按 1s → 2s → 4s 退避重试，最多 3 次', async () => {
    const content = ref('a')
    const attempts: number[] = []
    let attempt = 0
    const target: ISaveTarget = {
      key: 'SKILL.md',
      async save() {
        attempt += 1
        attempts.push(attempt)
        throw new Error('网络错误')
      },
    }
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = 'b'
    api.markDirty()
    const done = api.flushSilently()

    // 首次 + 三次重试 = 4 次尝试。
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    await done

    expect(attempts).toEqual([1, 2, 3, 4])
    expect(api.state.value).toBe('failed')
    // 本地内容不回滚：失败后 getContent 仍是用户输入。
    expect(content.value).toBe('b')
    wrapper.unmount()
  })

  it('重试成功则回到 saved', async () => {
    const content = ref('a')
    let attempt = 0
    const target: ISaveTarget = {
      key: 'SKILL.md',
      async save() {
        attempt += 1
        if (attempt === 1) throw new Error('瞬时失败')
        return { version: 'v'.repeat(64), diagnostics: [] }
      },
    }
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = 'b'
    api.markDirty()
    const done = api.flushSilently()
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(1000)
    await done

    expect(attempt).toBe(2)
    expect(api.state.value).toBe('saved')
    wrapper.unmount()
  })

  it('版本冲突转 conflict 且不重试', async () => {
    const content = ref('a')
    let attempt = 0
    const target: ISaveTarget = {
      key: 'SKILL.md',
      async save() {
        attempt += 1
        throw new ApiClientError({
          message: '文件已在外部修改，请刷新后重试。',
          code: 'FILE_VERSION_CONFLICT',
          status: 409,
        })
      },
    }
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = 'b'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)

    expect(attempt).toBe(1)
    expect(api.state.value).toBe('conflict')
    expect(api.errorMessage.value).toContain('外部修改')
    // 冲突同样不回滚本地内容。
    expect(content.value).toBe('b')
    wrapper.unmount()
  })

  it('重试成功后同步回填诊断', async () => {
    const content = ref('a')
    const target: ISaveTarget = {
      key: 'SKILL.md',
      async save() {
        return {
          version: 'v'.repeat(64),
          diagnostics: [
            {
              code: 'SKILL_DOCUMENT_INVALID',
              message: '缺少章节。',
              severity: 'error',
            },
          ],
        }
      },
    }
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = 'b'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)

    // edit 模式：诊断不阻断写入，仅用于界面提示。
    expect(api.state.value).toBe('saved')
    expect(api.diagnostics.value).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('useAutoSave 收尾 flush（PRD 7.6 / AC-09）', () => {
  it('flushSilently 等待防抖窗口内的待发改动写完', async () => {
    const content = ref('a')
    const { target, calls } = createTarget()
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = 'last input'
    api.markDirty()

    // 尚未到防抖窗口，flushSilently 应立刻发送而不是等待窗口。
    await api.flushSilently()

    expect(calls).toEqual(['last input'])
    expect(api.state.value).toBe('saved')
    wrapper.unmount()
  })

  it('无目标时 flushSilently 不发请求', async () => {
    const content = ref('a')
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({
        getContent: () => content.value,
        target: ref<ISaveTarget | null>(null),
      }),
    )

    content.value = 'b'
    api.markDirty()
    await api.flushSilently()

    expect(api.canSave.value).toBe(false)
    wrapper.unmount()
  })
})

describe('useAutoSave 目标切换', () => {
  it('切换文件时清空基准并中止在途请求', async () => {
    const content = ref('a')
    const targetA = createTarget({ key: 'a.ts' })
    const targetB = createTarget({ key: 'b.ts' })
    const current: Ref<ISaveTarget | null> = ref(targetA.target)
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: current }),
    )

    content.value = 'draft-a'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)
    expect(targetA.calls).toEqual(['draft-a'])

    // 切换到另一个文件：基准清空，新内容不会因「跳过无变化」被误判为已同步。
    current.value = targetB.target
    content.value = 'draft-b'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)

    expect(targetB.calls).toEqual(['draft-b'])
    wrapper.unmount()
  })
})

describe('useAutoSave 校验阻断（v10 PRD 5.3）', () => {
  /** 构造携带问题明细的校验阻断异常（EnvFileBlockedError 形态）。 */
  function createBlockedError(): Error & { issues: unknown } {
    return {
      name: 'EnvFileBlockedError',
      message: 'key "password" 不符合命名规则。',
      code: 'ENV_FILE_INVALID',
      issues: [
        {
          code: 'ENV_KEY_FORMAT',
          message: 'key "password" 不符合命名规则。',
          key: 'password',
        },
      ],
    } as unknown as Error & { issues: unknown }
  }

  it('校验失败转 blocked：不退避重试、问题明细透传、本地内容不回滚', async () => {
    const content = ref('a')
    let attempt = 0
    const target: ISaveTarget = {
      key: 'env.json',
      async save() {
        attempt += 1
        throw createBlockedError()
      },
    }
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = '{ "password": 1 }'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)

    // 只尝试一次：校验失败重试必然再次失败。
    expect(attempt).toBe(1)
    expect(api.state.value).toBe('blocked')
    expect(api.blockedIssues.value).toHaveLength(1)
    expect(api.blockedIssues.value[0]?.code).toBe('ENV_KEY_FORMAT')
    expect(api.errorMessage.value).toBe('')
    // 本地内容不回滚：用户修正后再次保存即恢复。
    expect(content.value).toBe('{ "password": 1 }')
    wrapper.unmount()
  })

  it('用户修正内容后再次保存恢复 saved', async () => {
    const content = ref('a')
    let attempt = 0
    const target: ISaveTarget = {
      key: 'env.json',
      async save() {
        attempt += 1
        if (attempt === 1) throw createBlockedError()
        return { version: 'v'.repeat(64), diagnostics: [] }
      },
    }
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    content.value = '{ "password": 1 }'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)
    expect(api.state.value).toBe('blocked')

    // 用户修正后输入：状态回到 pending（问题明细保留供参考），保存成功后清空。
    content.value = '{ "E2E_PASSWORD": "1" }'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)

    expect(attempt).toBe(2)
    expect(api.state.value).toBe('saved')
    expect(api.blockedIssues.value).toEqual([])
    wrapper.unmount()
  })
})

/**
 * 释放时机的契约（v13 PRD R-6 / 技术方案 §3.4）。
 *
 * 背景：`autoDispose` 的默认值依赖 `getCurrentInstance()` —— 在组件 `setup`
 * 中创建会挂上卸载钩子，在**事件处理器**中创建则不会。这让「实例何时被释放」
 * 取决于调用点所在的上下文，同一段代码移动位置就会改变行为。
 *
 * 工作台的产物卡片需要**跨页面存活**（用户离开 Skill 开发页后仍能编辑与保存），
 * 因此 store 中的调用方显式传 `false`，改由 store 的 reset() 统一释放。
 */
describe('useAutoSave 的释放时机（v13 R-6）', () => {
  it('默认在宿主组件卸载时释放：卸载后待发的防抖定时器被取消', async () => {
    const content = ref('a')
    const { target, calls } = createTarget()
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({ getContent: () => content.value, target: ref(target) }),
    )

    // 先标记脏数据（此时定时器在等防抖窗口），再卸载。
    content.value = 'b'
    api.markDirty()
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(2000)

    // 释放取消了待发定时器，因此没有发出请求。
    expect(calls).toEqual([])
  })

  it('autoDispose:false 时，宿主组件卸载后实例仍可保存（跨页面存活）', async () => {
    const content = ref('a')
    const { target, calls } = createTarget()
    const { api, wrapper } = mountAutoSave(() =>
      useAutoSave({
        getContent: () => content.value,
        target: ref(target),
        autoDispose: false,
      }),
    )

    wrapper.unmount()

    // 卸载后仍能保存：工作台在用户离开页面后继续允许编辑产物卡片。
    content.value = 'b'
    api.markDirty()
    await vi.advanceTimersByTimeAsync(800)

    expect(calls).toEqual(['b'])
    expect(api.state.value).toBe('saved')
    // 由调用方显式释放。
    api.dispose()
  })

  it('dispose 取消待发保存（autoDispose:false 的调用方负责释放）', async () => {
    const content = ref('a')
    const { target, calls } = createTarget()
    const { api } = mountAutoSave(() =>
      useAutoSave({
        getContent: () => content.value,
        target: ref(target),
        autoDispose: false,
      }),
    )

    content.value = 'b'
    api.markDirty()
    api.dispose()
    await vi.advanceTimersByTimeAsync(2000)

    expect(calls).toEqual([])
  })
})
