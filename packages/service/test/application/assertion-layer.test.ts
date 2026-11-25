/**
 * 断言层红线（v17 §6.5.1 / PRD G5c）的单元测试。
 *
 * 测试**按字段逐项锁定**（而非一个「综合用例」）——这是技术方案 §9 明确要求的：
 * 清单漏项会让红线出现缺口，而缺口正是「测试配合缺陷」的入口。新增字段时
 * 必须显式归类，逐字段的用例能立刻暴露「新字段没被判」。
 */
import { describe, expect, it } from 'vitest'
import type { IE2ETestCase } from '@authine-e2e-agent/types'
import {
  describeAssertionLayerRefusal,
  findAssertionLayerChanges,
} from '../../src/application/agent-workbench/assertion-layer'

/** 构造一个基准用例（三个启用步骤）。 */
function createCase(overrides: Partial<IE2ETestCase> = {}): IE2ETestCase {
  return {
    schemaVersion: '1.0',
    id: 'tc_abc123456',
    title: '云7登录',
    description: '登录页端到端',
    baseUrl: 'http://localhost:5173',
    tags: ['冒烟'],
    preconditions: [{ id: 'p1', description: '已安装依赖' }],
    steps: [
      {
        id: 's1',
        order: 1,
        description: '打开登录页',
        action: '导航到 /login',
        expectedResult: '登录页可见',
        testData: {},
        enabled: true,
      },
      {
        id: 's2',
        order: 2,
        description: '提交表单',
        action: '点击「提交」按钮',
        expectedResult: '跳转到 /dashboard',
        testData: {},
        enabled: true,
      },
      {
        id: 's3',
        order: 3,
        description: '退出',
        action: '点击「退出」',
        expectedResult: '回到 /login',
        testData: {},
        enabled: true,
      },
    ],
    ...overrides,
  }
}

describe('findAssertionLayerChanges（逐字段锁定）', () => {
  it('完全相同的用例不报违规', () => {
    const current = createCase()
    expect(findAssertionLayerChanges(current, createCase())).toEqual([])
  })

  it('① expectedResult 变化 → 拒绝', () => {
    const current = createCase()
    const target = createCase({
      steps: current.steps.map((step) =>
        step.id === 's2'
          ? { ...step, expectedResult: '跳转到 /home' }
          : step,
      ),
    })

    const violations = findAssertionLayerChanges(current, target)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.path).toBe('steps[2].expectedResult')
  })

  it('② title 变化 → 拒绝', () => {
    const violations = findAssertionLayerChanges(
      createCase(),
      createCase({ title: '云7登录（改）' }),
    )
    expect(violations.some((item) => item.path === 'title')).toBe(true)
  })

  it('② description 变化 → 拒绝', () => {
    const violations = findAssertionLayerChanges(
      createCase(),
      createCase({ description: '改了描述' }),
    )
    expect(violations.some((item) => item.path === 'description')).toBe(true)
  })

  it('③ 删除步骤（步骤数减少）→ 拒绝', () => {
    const target = createCase({
      steps: createCase().steps.slice(0, 2),
    })
    const violations = findAssertionLayerChanges(createCase(), target)
    expect(violations.some((item) => item.path === 'steps')).toBe(true)
    // 被移除的步骤要显式点名（用户看得见）。
    expect(violations[0]?.reason).toContain('第 3 步')
  })

  it('③ 含断言的步骤由启用改为停用 → 拒绝', () => {
    const current = createCase()
    const target = createCase({
      steps: current.steps.map((step) =>
        step.id === 's2' ? { ...step, enabled: false } : step,
      ),
    })
    const violations = findAssertionLayerChanges(current, target)
    expect(violations.some((item) => item.path === 'steps[2].enabled')).toBe(true)
  })

  it('action 变化 → 允许（操作层）', () => {
    const current = createCase()
    const target = createCase({
      steps: current.steps.map((step) =>
        step.id === 's2' ? { ...step, action: '点击「保存」按钮' } : step,
      ),
    })
    expect(findAssertionLayerChanges(current, target)).toEqual([])
  })

  it('步骤 description 变化 → 允许（步骤名属操作层）', () => {
    const current = createCase()
    const target = createCase({
      steps: current.steps.map((step) =>
        step.id === 's1' ? { ...step, description: '打开登录入口' } : step,
      ),
    })
    expect(findAssertionLayerChanges(current, target)).toEqual([])
  })

  it('preconditions 变化 → 允许（操作层）', () => {
    const target = createCase({
      preconditions: [{ id: 'p1', description: '改过的前置条件' }],
    })
    expect(findAssertionLayerChanges(createCase(), target)).toEqual([])
  })

  it('新增步骤 → 允许（补齐缺失的前置操作）', () => {
    const current = createCase()
    const target = createCase({
      steps: [
        ...current.steps,
        {
          id: 's4',
          order: 4,
          description: '关闭浏览器',
          action: '关闭',
          expectedResult: '已关闭',
          testData: {},
          enabled: true,
        },
      ],
    })
    expect(findAssertionLayerChanges(current, target)).toEqual([])
  })

  it('testData 变化 → 允许（操作层）', () => {
    const current = createCase()
    const target = createCase({
      steps: current.steps.map((step) =>
        step.id === 's2'
          ? { ...step, testData: { user: 'admin' } }
          : step,
      ),
    })
    expect(findAssertionLayerChanges(current, target)).toEqual([])
  })
})

describe('describeAssertionLayerRefusal（G5d 的引导文案）', () => {
  it('不是一句干巴巴的「不允许」，而是引导模型如实报告', () => {
    const violations = findAssertionLayerChanges(
      createCase(),
      createCase({ title: '改标题' }),
    )
    const text = describeAssertionLayerRefusal(violations)

    expect(text).toContain('断言层变更已被平台拒绝')
    // G5d：必须把模型推向「如实报告可能是缺陷」而非死路。
    expect(text).toContain('可能是被测系统的缺陷')
    expect(text).toContain('查看报告')
    expect(text).toContain('在开发页打开用例')
  })
})
