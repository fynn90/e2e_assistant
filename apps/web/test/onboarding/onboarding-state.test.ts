/**
 * 验证首次激活引导领域状态的顺序、幂等性、Skill 归属与完成确认规则。
 */
import { describe, expect, it } from 'vitest'
import {
  acknowledgeOnboardingCompletion,
  bindOnboardingSkill,
  createOnboardingState,
  dismissOnboarding,
  getNextOnboardingMilestone,
  normalizeOnboardingState,
  recordOnboardingMilestone,
  resumeOnboarding,
} from '../../src/modules/onboarding/domain/onboarding-state'

const T0 = '2026-07-18T00:00:00.000Z'
const T1 = '2026-07-18T00:01:00.000Z'
const T2 = '2026-07-18T00:02:00.000Z'
const T3 = '2026-07-18T00:03:00.000Z'

/**
 * 创建已绑定 Skill 的标准测试状态。
 * @returns 包含工作区和 Skill 里程碑的状态。
 * @throws 不抛出异常。
 */
function createSkillState() {
  return bindOnboardingSkill(
    createOnboardingState('/workspace/a', T0),
    'abc123def',
    T1,
  )
}

describe('onboarding-state', () => {
  it('creates a fresh state with workspace readiness as the first milestone', () => {
    const state = createOnboardingState('/workspace/a', T0)

    expect(state.milestones).toEqual({ 'workspace-ready': T0 })
    expect(state.guideStatus).toBe('active')
    expect(getNextOnboardingMilestone(state)).toBe('skill-ready')
  })

  it('binds a Skill once and keeps the attribution stable after case readiness', () => {
    const skillState = createSkillState()
    const caseState = recordOnboardingMilestone(
      skillState,
      'case-ready',
      T2,
      'abc123def',
    )
    const rebound = bindOnboardingSkill(caseState, 'other1234', T3)

    expect(skillState.activeSkillId).toBe('abc123def')
    expect(skillState.milestones['skill-ready']).toBe(T1)
    expect(rebound).toBe(caseState)
  })

  it('ignores out-of-order and mismatched Skill milestone events', () => {
    const fresh = createOnboardingState('/workspace/a', T0)
    const outOfOrder = recordOnboardingMilestone(
      fresh,
      'case-ready',
      T1,
      'abc123def',
    )
    const skillState = createSkillState()
    const mismatched = recordOnboardingMilestone(
      skillState,
      'case-ready',
      T2,
      'other1234',
    )

    expect(outOfOrder).toBe(fresh)
    expect(mismatched).toBe(skillState)
  })

  it('records milestone timestamps idempotently and completes only after reviewed save', () => {
    const skillState = createSkillState()
    const caseState = recordOnboardingMilestone(
      skillState,
      'case-ready',
      T2,
      'abc123def',
    )
    const duplicateCase = recordOnboardingMilestone(
      caseState,
      'case-ready',
      T3,
      'abc123def',
    )
    const completed = recordOnboardingMilestone(
      caseState,
      'reviewed-script-saved',
      T3,
      'abc123def',
    )

    expect(duplicateCase).toBe(caseState)
    expect(completed.activationCompletedAt).toBe(T3)
    expect(getNextOnboardingMilestone(completed)).toBeNull()
  })

  it('dismisses, resumes, and acknowledges completion without clearing milestones', () => {
    const skillState = createSkillState()
    const dismissed = dismissOnboarding(skillState, T2)
    const resumed = resumeOnboarding(dismissed, T3)
    const caseState = recordOnboardingMilestone(
      resumed,
      'case-ready',
      T2,
      'abc123def',
    )
    const completed = recordOnboardingMilestone(
      caseState,
      'reviewed-script-saved',
      T3,
      'abc123def',
    )
    const acknowledged = acknowledgeOnboardingCompletion(completed, T3)

    expect(dismissed.guideStatus).toBe('dismissed')
    expect(resumed.guideStatus).toBe('active')
    expect(resumed.milestones['skill-ready']).toBe(T1)
    expect(acknowledged.completionAcknowledgedAt).toBe(T3)
    expect(acknowledged.activationCompletedAt).toBe(T3)
  })

  it('rejects malformed, future-version, and cross-workspace records', () => {
    const valid = createOnboardingState('/workspace/a', T0)

    expect(normalizeOnboardingState(valid, '/workspace/a')).toEqual(valid)
    expect(
      normalizeOnboardingState({ ...valid, version: 2 }, '/workspace/a'),
    ).toBeNull()
    expect(normalizeOnboardingState(valid, '/workspace/b')).toBeNull()
    expect(normalizeOnboardingState({ version: 1 }, '/workspace/a')).toBeNull()
  })
})
