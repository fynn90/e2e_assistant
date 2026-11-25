/**
 * 执行区块的组件测试（v13 技术方案 §7.5 / F10）。
 *
 * 核心是 **executionId 守卫**：执行记录按 Skill 存放，同一 Skill 的新执行会
 * 覆盖旧记录。不校验 executionId 的话，历史卡片会显示成另一次执行的内容。
 * v16 的 `WorkbenchExecutionBody` 已有同款守卫，两处口径必须一致。
 *
 * 同时断言 v11 的页面内用法未被破坏：**不传 executionId 时不校验**，
 * 仍然只看「该 Skill 最近一次执行」。
 */
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExecutionBlock from '../../src/modules/test-execution/components/ExecutionBlock.vue'
import { useExecutionStore } from '../../src/stores/execution'
import type { IExecutionRecordState } from '../../src/stores/execution'

/** 造一条最小的执行记录。 */
function record(executionId: string): IExecutionRecordState {
  return {
    executionId,
    status: 'completed',
    startedAtMs: Date.now(),
    logs: [],
    stages: [],
    tests: [],
    steps: [],
    issues: [],
  }
}

/**
 * 挂载执行区块。
 *
 * 组件用 `useRouter()` 做就绪摘要的修复跳转，故需安装 router；
 * 用例读取（步骤名）走网络，测试中不关心，交由默认的失败降级处理。
 *
 * @param props - 区块入参。
 * @returns 已挂载的包装器。
 * @throws 不抛出异常。
 */
async function mountBlock(props: { skillId: string; executionId?: string }) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()

  const wrapper = mount(ExecutionBlock, {
    props: { ...props, onOpenReport: vi.fn() },
    global: { plugins: [router] },
  })
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ExecutionBlock 的 executionId 守卫（v13 F10）', () => {
  it('记录属于期望的执行时正常渲染', async () => {
    const store = useExecutionStore()
    store.records['skill-001'] = record('exec-1')

    const wrapper = await mountBlock({
      skillId: 'skill-001',
      executionId: 'exec-1',
    })

    // 正常渲染时不出现降级提示。
    expect(wrapper.text()).not.toContain('过程记录已不可用')
    wrapper.unmount()
  })

  it('记录已被同 Skill 的另一次执行覆盖时降级，**不渲染他人执行**', async () => {
    const store = useExecutionStore()
    // 该 Skill 上跑的是 exec-2，而卡片要展示的是 exec-1。
    store.records['skill-001'] = record('exec-2')

    const wrapper = await mountBlock({
      skillId: 'skill-001',
      executionId: 'exec-1',
    })

    expect(wrapper.text()).toContain('过程记录已不可用')
    // 关键：不能把 exec-2 的日志/步骤画进属于 exec-1 的卡片。
    expect(wrapper.find('.log-stream').exists()).toBe(false)
    expect(wrapper.find('.step-progress').exists()).toBe(false)
    wrapper.unmount()
  })

  it('未传 executionId（v11 页面内用法）：不校验，只看该 Skill 最近一次', async () => {
    const store = useExecutionStore()
    store.records['skill-001'] = record('exec-2')

    const wrapper = await mountBlock({ skillId: 'skill-001' })

    expect(wrapper.text()).not.toContain('过程记录已不可用')
    // 保留 v11 行为：Skill 开发页内无需指定执行 ID。
    expect(wrapper.find('.log-stream').exists()).toBe(true)
    wrapper.unmount()
  })
})
