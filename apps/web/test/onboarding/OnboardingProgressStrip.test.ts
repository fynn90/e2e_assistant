/**
 * 验证首次激活进度条的语义状态、操作事件和完成提示。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import {
  bindOnboardingSkill,
  createOnboardingState,
  recordOnboardingMilestone,
} from '../../src/modules/onboarding/domain/onboarding-state'
import OnboardingProgressStrip from '../../src/modules/onboarding/components/OnboardingProgressStrip.vue'

const NOW = '2026-07-18T00:00:00.000Z'

/**
 * 挂载进度条并使用轻量 Naive UI Stub 保留按钮与标签语义。
 * @param state 待展示的引导状态。
 * @returns Vue Test Utils 包装器。
 * @throws 组件挂载失败时由测试框架抛出异常。
 */
function mountStrip(state = createOnboardingState('/workspace/a', NOW)) {
  return mount(OnboardingProgressStrip, {
    props: { state },
    global: {
      stubs: {
        NButton: {
          emits: ['click'],
          template: '<button @click="$emit(\'click\')"><slot /></button>',
        },
        NTag: { template: '<span><slot /></span>' },
      },
    },
  })
}

describe('OnboardingProgressStrip', () => {
  it('renders ordered milestones with a textual current state', () => {
    const wrapper = mountStrip()
    const currentStep = wrapper.get('[aria-current="step"]')

    expect(wrapper.findAll('.milestone-item')).toHaveLength(4)
    expect(currentStep.text()).toContain('Skill 已就绪')
    expect(currentStep.text()).toContain('当前')
    expect(wrapper.text()).toContain('不会运行测试')
  })

  it('emits dismissal from the active guide', async () => {
    const wrapper = mountStrip()

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('renders completion and emits acknowledgement after reviewed save', async () => {
    const skillState = bindOnboardingSkill(
      createOnboardingState('/workspace/a', NOW),
      'abc123def',
      NOW,
    )
    const caseState = recordOnboardingMilestone(
      skillState,
      'case-ready',
      NOW,
      'abc123def',
    )
    const completed = recordOnboardingMilestone(
      caseState,
      'reviewed-script-saved',
      NOW,
      'abc123def',
    )
    const wrapper = mountStrip(completed)

    expect(wrapper.text()).toContain('首个 Playwright 脚本已审阅并保存')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('acknowledgeCompletion')).toHaveLength(1)
  })
})
