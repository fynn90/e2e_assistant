/**
 * 验证 E2E 草稿步骤操作保持稳定 ID 和连续顺序。
 */
import { reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  cloneTestCaseDraft,
  createStep,
  deleteStep,
  duplicateStep,
  insertStepAfter,
  moveStep,
} from '../../src/modules/e2e-test-case/utils/test-case-draft'

describe('E2E test case draft utilities', () => {
  it('clones Vue reactive drafts into detached plain data', () => {
    const source = reactive({
      schemaVersion: '1.0' as const,
      id: 'case_original',
      title: '登录测试',
      description: '验证登录流程',
      baseUrl: 'https://example.test',
      tags: ['smoke'],
      preconditions: [],
      steps: [{ ...createStep(1), id: 'step_original' }],
    })

    const cloned = cloneTestCaseDraft(source)

    expect(cloned).toEqual(source)
    expect(cloned).not.toBe(source)
    expect(cloned.steps[0]).not.toBe(source.steps[0])
  })

  it('duplicates with a new stable id and normalizes order', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => '11111111-2222-3333-4444-555555555555',
    })
    const source = [
      { ...createStep(1), id: 'step_original', description: 'original' },
    ]
    const duplicated = duplicateStep(source, 0)

    expect(duplicated).toHaveLength(2)
    expect(duplicated[0]?.id).toBe('step_original')
    expect(duplicated[1]?.id).not.toBe('step_original')
    expect(duplicated.map((step) => step.order)).toEqual([1, 2])
    vi.unstubAllGlobals()
  })

  it('inserts a new stable step after the selected row', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
    const steps = [
      { ...createStep(1), id: 'a' },
      { ...createStep(2), id: 'b' },
    ]
    const inserted = insertStepAfter(steps, 0)

    expect(inserted.map((step) => step.id)).toEqual([
      'a',
      'step_aaaaaaaabbbbccccddddeeeeeeeeeeee',
      'b',
    ])
    expect(inserted.map((step) => step.order)).toEqual([1, 2, 3])
    vi.unstubAllGlobals()
  })

  it('moves and deletes without changing remaining ids', () => {
    const steps = [
      { ...createStep(1), id: 'a' },
      { ...createStep(2), id: 'b' },
      { ...createStep(3), id: 'c' },
    ]

    expect(moveStep(steps, 2, 0).map((step) => [step.id, step.order])).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ])
    expect(deleteStep(steps, 1).map((step) => [step.id, step.order])).toEqual([
      ['a', 1],
      ['c', 2],
    ])
  })
})
