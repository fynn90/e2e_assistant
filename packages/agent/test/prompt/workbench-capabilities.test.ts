/**
 * 能力清单同源（v17 §5.3 / PRD H3）的单元测试。
 *
 * 本组的价值在于**锁定「一处事实、两个出口」**：`renderCapabilityPromptSection`
 *（提示词）与 `toCapabilityViewPayload`（能力卡）必须来自同一份常量——
 * 加一个能力时两处同时变，否则会出现「对能做的事说「不支持」」或
 * 「承诺平台做不到的事」（H3 明确禁止）。
 *
 * 另附 **P 组提示词的快照测试**（§9 明确要求）：防止提示词被后续改动悄悄删掉。
 */
import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_CAPABILITY_MANIFEST,
  renderCapabilityPromptSection,
  toCapabilityViewPayload,
} from '../../src/prompt/sections/workbench-capabilities'
import { getWorkbenchThresholdSection } from '../../src/prompt/workbench-section'

describe('能力清单同源（H3）', () => {
  it('提示词与能力卡都覆盖清单里的全部能力域', () => {
    const prompt = renderCapabilityPromptSection()
    const payload = toCapabilityViewPayload()

    for (const domain of WORKBENCH_CAPABILITY_MANIFEST.domains) {
      // 提示词里出现该域的标签与每个示例说法。
      expect(prompt).toContain(domain.label)
      for (const example of domain.examples) {
        expect(prompt).toContain(example)
      }

      // 能力卡里有同名的域，且示例逐条一致。
      const fromCard = payload.domains.find((item) => item.key === domain.key)
      expect(fromCard?.label).toBe(domain.label)
      expect(fromCard?.examples).toEqual(domain.examples)
    }
  })

  it('「不做的事」两个出口逐条一致（含替代路径）', () => {
    const prompt = renderCapabilityPromptSection()
    const payload = toCapabilityViewPayload()

    expect(payload.notSupported).toHaveLength(
      WORKBENCH_CAPABILITY_MANIFEST.notSupported.length,
    )

    for (const item of WORKBENCH_CAPABILITY_MANIFEST.notSupported) {
      // 提示词里必须带上「能力名 → 替代路径」。
      expect(prompt).toContain(item.label)
      expect(prompt).toContain(item.alternative)

      const fromCard = payload.notSupported.find(
        (candidate) => candidate.label === item.label,
      )
      expect(fromCard?.alternative).toBe(item.alternative)
    }
  })

  it('加一个能力时两个出口同时变（模拟清单扩展）', () => {
    const extended = {
      domains: [
        ...WORKBENCH_CAPABILITY_MANIFEST.domains,
        { key: 'demo', label: '演示能力', examples: ['演示一下'] },
      ],
      notSupported: WORKBENCH_CAPABILITY_MANIFEST.notSupported,
    }

    const prompt = renderCapabilityPromptSection(extended)
    const payload = toCapabilityViewPayload(extended)

    // 两个出口都能看到新增项——没有「改了一处、漏了另一处」的缝隙。
    expect(prompt).toContain('演示能力')
    expect(payload.domains.some((item) => item.key === 'demo')).toBe(true)
  })

  it('安全边界在提示词里有单独说明（与「能力外」区分回应，U5）', () => {
    const prompt = renderCapabilityPromptSection()
    expect(prompt).toContain('永不接入')
    expect(prompt).toContain('环境变量的值')
    expect(prompt).toContain('工作区之外')
  })
})

describe('P 组提示词快照（§9：防止被后续改动悄悄删掉）', () => {
  it('门槛区块包含三条判定标准与两个边界', () => {
    const section = getWorkbenchThresholdSection()

    // 三条判定标准。
    expect(section).toContain('目标唯一')
    expect(section).toContain('动作明确')
    expect(section).toContain('参数完整')

    // 「充分 ≠ 完整」这一侧（防过度询问，P4）。
    expect(section).toContain('充分')
    expect(section).toContain('不等于')
    expect(section).toContain('直接做')

    // 只读不受约束（P1）。
    expect(section).toContain('只读操作不受本门槛约束')

    // 四组好/坏对照（§4.1.1 的基准）。
    expect(section).toContain('跑一下登录用例')
    expect(section).toContain('把目标地址改一下')
    expect(section).toContain('跑一下云7登录')
    expect(section).toContain('把报告清一下')
  })

  it('门槛区块明确列出受约束的动作（P1 的适用范围）', () => {
    const section = getWorkbenchThresholdSection()
    for (const action of ['执行', '生成', '修复', '用例变更', '报告清理', '用例删除']) {
      expect(section).toContain(action)
    }
  })
})
