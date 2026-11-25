/**
 * 卡片操作区交互按钮的组件测试（PRD §4.3 B-4 / v9 6.2、6.3、6.5、6.7）。
 *
 * v13 修订：三张卡片的「关闭」按钮全部移除（PRD B-4）——销毁内容的职责移交
 * 抽屉底部的「清空」，收起由遮罩 / 收起图标 / Esc 承担。因此：
 *   - SKILL.md 卡片只剩主按钮「生成 Playwright 脚本」；
 *   - 脚本卡片与终止卡片的操作区**完全为空**；
 *   - `isLatest` 这个 prop 随之消失（它唯一的用途是「关闭按钮只出现在最新卡片上」）。
 *
 * 尺寸断言直接读 naive-ui 渲染出的尺寸类（`n-button--small-type`），
 * 不使用组件替身——替身会吞掉 `size` 到样式的映射，反而测不到真实渲染结果。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SkillDocumentCardActions from '../../src/modules/agent-work/components/SkillDocumentCardActions.vue'
import PlaywrightScriptCardActions from '../../src/modules/agent-work/components/PlaywrightScriptCardActions.vue'
import StageFailureCardActions from '../../src/modules/agent-work/components/StageFailureCardActions.vue'

/**
 * 判断按钮是否以「小号」渲染。
 * @param classes 按钮元素的 class 列表。
 * @returns 命中 naive-ui 小号尺寸类时返回 true。
 * @throws 不抛出异常。
 */
function isSmall(classes: readonly string[] | undefined): boolean {
  return Boolean(classes?.includes('n-button--small-type'))
}

describe('SkillDocumentCardActions（v9 PRD 6.3 / 6.7）', () => {
  it('渲染「生成 Playwright 脚本」小号按钮，不再有「关闭」（B-4）', async () => {
    const wrapper = mount(SkillDocumentCardActions, {
      props: { primaryAction: null },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons.map((button) => button.text())).toEqual([
      '生成 Playwright 脚本',
    ])
    // 按钮尺寸为小号：最小号（tiny）在卡片底部过于局促，关键主操作点击目标偏小。
    expect(buttons.every((button) => isSmall(button.classes()))).toBe(true)

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('generateScript')).toHaveLength(1)
    wrapper.unmount()
  })

  it('主按钮执行成功后置灰，并保留含时间戳的完整文案', () => {
    const wrapper = mount(SkillDocumentCardActions, {
      props: {
        primaryAction: {
          executedAt: '2026-09-16T10:24:00.000Z',
          label: '生成 Playwright 脚本 ✓ 已于 10:24 生成',
        },
      },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.text()).toContain('已于')
    expect(buttons[0]!.attributes('disabled')).toBeDefined()
    expect(isSmall(buttons[0]!.classes())).toBe(true)
    wrapper.unmount()
  })

  it('有阶段运行中时主按钮禁用', () => {
    const wrapper = mount(SkillDocumentCardActions, {
      props: { primaryAction: null, primaryDisabled: true },
    })

    const primary = wrapper
      .findAll('button')
      .find((button) => button.text() === '生成 Playwright 脚本')!
    expect(primary.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe('PlaywrightScriptCardActions（v13）', () => {
  it('操作区提供「查看测试脚本」，不再有「关闭」（B-4）', () => {
    const wrapper = mount(PlaywrightScriptCardActions)

    const buttons = wrapper.findAll('button')
    expect(buttons.map((button) => button.text())).toEqual(['查看测试脚本'])
    wrapper.unmount()
  })

  it('点击「查看测试脚本」触发 openScript 事件', async () => {
    const wrapper = mount(PlaywrightScriptCardActions)

    await wrapper.get('button').trigger('click')

    expect(wrapper.emitted('openScript')).toHaveLength(1)
    wrapper.unmount()
  })

  it('有版本号时展示截断后的版本，方便核对打开的是哪一版', () => {
    const wrapper = mount(PlaywrightScriptCardActions, {
      props: { version: 'abcdef1234567890' },
    })

    expect(wrapper.text()).toContain('版本 abcdef12')
    wrapper.unmount()
  })

  it('无版本号时不渲染版本文字（早期记录可能没有）', () => {
    const wrapper = mount(PlaywrightScriptCardActions)

    expect(wrapper.find('.script-version').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('StageFailureCardActions（v13 B-4）', () => {
  it('操作区为空：终止卡片不再有任何按钮', () => {
    const wrapper = mount(StageFailureCardActions)

    expect(wrapper.findAll('button')).toHaveLength(0)
    wrapper.unmount()
  })
})
