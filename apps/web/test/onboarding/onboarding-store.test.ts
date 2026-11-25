/**
 * 验证首次激活引导 Pinia Store 的工作区生命周期、跳过恢复和里程碑归属。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  bindOnboardingSkill,
  createOnboardingState,
  dismissOnboarding,
} from '../../src/modules/onboarding/domain/onboarding-state'
import { createOnboardingLocalStorageRepository } from '../../src/modules/onboarding/infrastructure/onboarding-local-storage'
import { useOnboardingStore } from '../../src/modules/onboarding/stores/onboarding'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('onboarding store', () => {
  it('starts only for a fresh workspace and persists the active guide', () => {
    const store = useOnboardingStore()

    store.hydrateWorkspace('/workspace/a')
    expect(store.onboardingState).toBeNull()
    expect(store.guideActive).toBe(false)

    store.beginFreshWorkspace('/workspace/a')
    expect(store.guideActive).toBe(true)
    expect(store.nextMilestone).toBe('skill-ready')

    setActivePinia(createPinia())
    const reloadedStore = useOnboardingStore()
    reloadedStore.hydrateWorkspace('/workspace/a')
    expect(reloadedStore.guideActive).toBe(true)
  })

  it('isolates states when switching project directories', () => {
    const repository = createOnboardingLocalStorageRepository(localStorage)
    const existing = bindOnboardingSkill(
      createOnboardingState('/workspace/a', new Date(0).toISOString()),
      'abc123def',
      new Date(1).toISOString(),
    )
    repository.save(existing)

    const store = useOnboardingStore()
    store.hydrateWorkspace('/workspace/a')
    expect(store.onboardingState?.activeSkillId).toBe('abc123def')

    store.hydrateWorkspace('/workspace/b')
    expect(store.onboardingState).toBeNull()
  })

  it('dismisses and resumes without losing milestones', () => {
    const store = useOnboardingStore()
    store.beginFreshWorkspace('/workspace/a')
    store.recordSkillReady('abc123def')

    expect(store.dismissGuide()).toBe(true)
    expect(store.guideActive).toBe(false)
    expect(store.startOrResumeGuide()).toBe(true)
    expect(store.guideActive).toBe(true)
    expect(store.onboardingState?.milestones['skill-ready']).toBeTruthy()
  })

  it('ignores mismatched Skill events and records activation once', () => {
    const store = useOnboardingStore()
    store.beginFreshWorkspace('/workspace/a')
    store.recordSkillReady('abc123def')

    expect(store.recordCaseReady('other1234')).toBe(false)
    expect(store.recordCaseReady('abc123def')).toBe(true)
    expect(store.recordReviewedScriptSaved('abc123def')).toBe(true)
    const completion = store.onboardingState?.activationCompletedAt
    expect(completion).toBeTruthy()
    expect(store.recordReviewedScriptSaved('abc123def')).toBe(false)
    expect(store.onboardingState?.activationCompletedAt).toBe(completion)
  })

  it('restores an existing dismissed guide for the same workspace', () => {
    const repository = createOnboardingLocalStorageRepository(localStorage)
    const dismissed = dismissOnboarding(
      createOnboardingState('/workspace/a', new Date(0).toISOString()),
      new Date(1).toISOString(),
    )
    repository.save(dismissed)

    const store = useOnboardingStore()
    store.hydrateWorkspace('/workspace/a')

    expect(store.guideActive).toBe(false)
    expect(store.canStartOrResume).toBe(true)
    expect(store.startOrResumeGuide()).toBe(true)
    expect(store.guideActive).toBe(true)
  })

  it('acknowledges completion and suppresses repeated progress display', () => {
    const store = useOnboardingStore()
    store.beginFreshWorkspace('/workspace/a')
    store.recordSkillReady('abc123def')
    store.recordCaseReady('abc123def')
    store.recordReviewedScriptSaved('abc123def')

    expect(store.shouldShowProgress).toBe(true)
    expect(store.acknowledgeCompletion()).toBe(true)
    expect(store.shouldShowProgress).toBe(false)
    expect(store.acknowledgeCompletion()).toBe(false)
  })
})
