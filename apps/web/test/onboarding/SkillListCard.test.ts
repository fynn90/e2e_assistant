// Skill 目录组件测试：验证首次使用引导、入门入口、卡片键盘打开与删除确认契约。
import type { ISkillSummary } from '@fynn90-e2e_assistant/types'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SkillListCard from '../../src/modules/skills/SkillListCard.vue'

/**
 * 挂载 Skill 目录并使用轻量 Naive UI Stub 保留交互语义。
 * @param skillList 待展示的 Skill 摘要列表。
 * @returns Vue Test Utils 包装器。
 * @throws 组件挂载失败时由测试框架抛出异常。
 */
function mountSkillList (skillList: ISkillSummary[] = []) {
  return mount(SkillListCard, {
    props: {
      skillList,
      refreshingSkills: false,
      showOnboardingEntry: true,
    },
    global: {
      stubs: {
        NButton: {
          emits: ['click'],
          template: '<button @click="$emit(\'click\')"><slot /></button>',
        },
        NInput: { template: '<input />' },
        NSelect: { template: '<select />' },
        NPagination: { template: '<nav />' },
        NResult: { template: '<section><slot name="footer" /></section>' },
        NSkeleton: { template: '<span />' },
        NTag: { template: '<span><slot /></span>' },
        SkillCreateModal: {
          props: ['show'],
          template: '<div data-test="create-modal">{{ show }}</div>',
        },
        SkillDeleteConfirmModal: {
          props: ['show', 'skill'],
          template:
            '<div data-test="delete-modal" :data-show="show" @click="$emit(\'deleted\')"></div>',
        },
      },
    },
  })
}

describe('SkillListCard onboarding states', () => {
  it('teaches the first action and opens the existing create modal', async () => {
    const wrapper = mountSkillList()

    expect(wrapper.text()).toContain('创建第一个 Skill')
    expect(wrapper.text()).toContain('不会运行测试')
    const createButton = wrapper
      .findAll('button')
      .find((button) => button.text() === '新建 Skill')
    expect(createButton).toBeTruthy()
    await createButton!.trigger('click')
    expect(wrapper.get('[data-test="create-modal"]').text()).toBe('true')
  })

  it('emits the manual onboarding entry action', async () => {
    const wrapper = mountSkillList()
    const onboardingButton = wrapper
      .findAll('button')
      .find((button) => button.text() === '查看入门流程')

    await onboardingButton!.trigger('click')
    expect(wrapper.emitted('startOnboarding')).toHaveLength(1)
  })

  it('keeps nonempty Skill cards keyboard accessible', async () => {
    const wrapper = mountSkillList([
      {
        id: 'abc123def',
        title: '登录测试',
        description: '验证登录',
        version: '1',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(1).toISOString(),
      },
    ])
    // 卡片行由 SkillCard 子组件渲染（提交 142452d 由 SkillListItem 重命名而来）。
    const row = wrapper.get('.skill-card')

    expect(row.attributes('tabindex')).toBe('0')
    await row.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('openSkill')).toEqual([['abc123def']])
  })
})

describe('SkillListCard delete interactions', () => {
  const fixtureSkill: ISkillSummary = {
    id: 'xyz789abc',
    title: '云枢登录测试',
    description: '验证登录',
    version: '1.0.0',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1).toISOString(),
  }

  it('clicking the trash opens the confirm modal without opening the Skill', async () => {
    const wrapper = mountSkillList([fixtureSkill])
    const deleteButton = wrapper.get('.skill-card-delete')

    await deleteButton.trigger('click')

    expect(wrapper.emitted('openSkill')).toBeUndefined()
    expect(
      wrapper.get('[data-test="delete-modal"]').attributes('data-show'),
    ).toBe('true')
  })

  it('confirming the modal bubbles the deleted event upward', async () => {
    const wrapper = mountSkillList([fixtureSkill])
    await wrapper.get('.skill-card-delete').trigger('click')
    await wrapper.get('[data-test="delete-modal"]').trigger('click')

    expect(wrapper.emitted('deleted')).toHaveLength(1)
  })
})
