// 删除确认弹框测试：验证后果说明、删除调用与成功/失败事件语义。
// naive-ui 的 NModal 会 teleport 到 body，因此断言与触发均基于 document.body 查询。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISkillSummary } from '@fynn90-e2e_assistant/types'
import SkillDeleteConfirmModal from '../../src/modules/skills/SkillDeleteConfirmModal.vue'

const mocks = vi.hoisted(() => ({
  deleteSkill: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('../../src/services/skill-api', () => ({
  deleteSkill: mocks.deleteSkill,
}))

vi.mock('../../src/composables/useGlobalMessage', () => ({
  useGlobalMessage: () => ({
    success: mocks.success,
    error: mocks.error,
    warning: mocks.warning,
    raw: {},
  }),
}))

const fixtureSkill: ISkillSummary = {
  id: 'abc123xyz',
  title: '云枢登录测试',
  description: '验证登录',
  version: '1.0.0',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(1).toISOString(),
}

/**
 * 挂载删除确认弹框。
 * @returns Vue Test Utils 包装器。
 * @throws 挂载失败时由测试框架抛出。
 */
function mountModal () {
  return mount(SkillDeleteConfirmModal, {
    props: { show: true, skill: fixtureSkill },
  })
}

/**
 * 在 body 中查找包含指定文本的按钮。
 * @param text 按钮文本片段。
 * @returns 匹配的按钮元素；无匹配时返回 undefined。
 * @throws 不抛出异常。
 */
function findBodyButton (text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes(text),
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.deleteSkill.mockReset()
  mocks.success.mockReset()
  mocks.error.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SkillDeleteConfirmModal', () => {
  it('展示 Skill 名称、ID 与不可恢复的后果说明', () => {
    mountModal()

    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('云枢登录测试')
    expect(bodyText).toContain('abc123xyz')
    expect(bodyText).toContain('此操作不可撤销')
    expect(bodyText).toContain('skill.list.json')
    expect(bodyText).toContain('.e2e-agent')
  })

  it('确认删除后调用接口、提示成功并上报 deleted', async () => {
    mocks.deleteSkill.mockResolvedValue({
      success: true,
      data: { skillId: 'abc123xyz' },
    })
    const wrapper = mountModal()

    findBodyButton('确认删除')!.click()
    await flushPromises()

    expect(mocks.deleteSkill).toHaveBeenCalledWith('abc123xyz')
    expect(mocks.success).toHaveBeenCalled()
    expect(wrapper.emitted('deleted')).toEqual([['abc123xyz']])
    expect(wrapper.emitted('update:show')?.[0]).toEqual([false])
  })

  it('删除失败时提示错误且不上报 deleted', async () => {
    mocks.deleteSkill.mockRejectedValue(new Error('删除失败'))
    const wrapper = mountModal()

    findBodyButton('确认删除')!.click()
    await flushPromises()

    expect(mocks.error).toHaveBeenCalledWith('删除失败')
    expect(wrapper.emitted('deleted')).toBeUndefined()
  })
})
