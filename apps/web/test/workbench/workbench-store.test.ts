// Workbench Store 测试：覆盖首次加载、后台刷新保留与过期请求取消。
import { createPinia, setActivePinia } from 'pinia'
import type { ISkillSummary } from '@fynn90-e2e_assistant/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSkills } from '../../src/services/skill-api'
import { useWorkbenchStore } from '../../src/stores/workbench'

vi.mock('../../src/services/skill-api', () => ({
  fetchSkills: vi.fn(),
}))

const mockedFetchSkills = vi.mocked(fetchSkills)
const skill: ISkillSummary = {
  id: 'skill-001',
  title: '登录测试',
  description: '验证登录流程',
  version: '1.0.0',
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-02-01').toISOString(),
}

describe('workbench store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedFetchSkills.mockReset()
  })

  it('tracks the first successful load and freshness timestamp', async () => {
    mockedFetchSkills.mockResolvedValue({ success: true, data: [skill] })
    const store = useWorkbenchStore()
    const refreshPromise = store.refreshSkills()

    expect(store.initialLoading).toBe(true)
    await refreshPromise

    expect(store.skillList).toEqual([skill])
    expect(store.skillsInitialized).toBe(true)
    expect(store.hasSuccessfulSkillLoad).toBe(true)
    expect(store.lastSuccessfulRefreshAt).toEqual(expect.any(String))
    expect(store.initialLoading).toBe(false)
  })

  it('preserves the last successful list when a background refresh fails', async () => {
    mockedFetchSkills.mockResolvedValueOnce({ success: true, data: [skill] })
    const store = useWorkbenchStore()
    await store.refreshSkills()

    mockedFetchSkills.mockRejectedValueOnce(new Error('网络连接失败'))
    await store.refreshSkills()

    expect(store.skillList).toEqual([skill])
    expect(store.errorMessage).toBe('网络连接失败')
    expect(store.hasSuccessfulSkillLoad).toBe(true)
  })

  it('aborts an obsolete list request before applying the next result', async () => {
    let firstSignal: AbortSignal | undefined
    mockedFetchSkills
      .mockImplementationOnce((signal) => {
        firstSignal = signal
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      })
      .mockResolvedValueOnce({ success: true, data: [skill] })

    const store = useWorkbenchStore()
    const firstRequest = store.refreshSkills()
    const secondRequest = store.refreshSkills()
    await Promise.all([firstRequest, secondRequest])

    expect(firstSignal?.aborted).toBe(true)
    expect(store.skillList).toEqual([skill])
    expect(store.errorMessage).toBe('')
  })

  it('invalidates old workspace data and aborts the active refresh', async () => {
    mockedFetchSkills.mockResolvedValueOnce({ success: true, data: [skill] })
    const store = useWorkbenchStore()
    await store.refreshSkills()

    let activeSignal: AbortSignal | undefined
    mockedFetchSkills.mockImplementationOnce((signal) => {
      activeSignal = signal
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const refreshPromise = store.refreshSkills()

    store.invalidateSkills()
    await refreshPromise

    expect(activeSignal?.aborted).toBe(true)
    expect(store.skillList).toEqual([])
    expect(store.skillsInitialized).toBe(false)
    expect(store.hasSuccessfulSkillLoad).toBe(false)
    expect(store.lastSuccessfulRefreshAt).toBeNull()
    expect(store.refreshingSkills).toBe(false)
    expect(store.errorMessage).toBe('')
  })
})
