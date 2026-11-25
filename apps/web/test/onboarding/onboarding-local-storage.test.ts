/**
 * 验证首次激活引导 localStorage 仓储的工作区隔离与异常降级行为。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createOnboardingState } from '../../src/modules/onboarding/domain/onboarding-state'
import {
  buildOnboardingStorageKey,
  createOnboardingLocalStorageRepository,
} from '../../src/modules/onboarding/infrastructure/onboarding-local-storage'

const NOW = '2026-07-18T00:00:00.000Z'

beforeEach(() => {
  localStorage.clear()
})

describe('onboarding-local-storage', () => {
  it('round-trips valid state without leaking across workspaces', () => {
    const repository = createOnboardingLocalStorageRepository(localStorage)
    const state = createOnboardingState('/workspace/a', NOW)

    expect(repository.save(state)).toBe(true)
    expect(repository.load('/workspace/a')).toEqual(state)
    expect(repository.load('/workspace/b')).toBeNull()
  })

  it('ignores malformed and unsupported persisted records', () => {
    const repository = createOnboardingLocalStorageRepository(localStorage)
    localStorage.setItem(buildOnboardingStorageKey('/workspace/a'), '{bad json')
    expect(repository.load('/workspace/a')).toBeNull()

    localStorage.setItem(
      buildOnboardingStorageKey('/workspace/a'),
      JSON.stringify({
        ...createOnboardingState('/workspace/a', NOW),
        version: 2,
      }),
    )
    expect(repository.load('/workspace/a')).toBeNull()
  })

  it('does not write merely by loading an absent record', () => {
    const repository = createOnboardingLocalStorageRepository(localStorage)

    expect(repository.load('/workspace/a')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('falls back safely when storage access throws', () => {
    const throwingStorage = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    } as unknown as Storage
    const repository = createOnboardingLocalStorageRepository(throwingStorage)

    expect(repository.load('/workspace/a')).toBeNull()
    expect(repository.save(createOnboardingState('/workspace/a', NOW))).toBe(
      false,
    )
  })
})
