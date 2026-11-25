// Skill 目录查询模型测试：覆盖检索、排序、分页与响应式输入。
import { nextTick, ref } from 'vue'
import type { ISkillSummary } from '@charlie_deng/e2e-assistant-types'
import { describe, expect, it } from 'vitest'
import { useSkillCatalog } from '../../src/modules/skills/useSkillCatalog'

/**
 * 创建稳定的 Skill 摘要测试数据。
 * @param index Skill 序号。
 * @param overrides 需要覆盖的摘要字段。
 * @returns 可用于目录测试的 Skill 摘要。
 * @throws 不抛出异常。
 */
function createSkill (
  index: number,
  overrides: Partial<ISkillSummary> = {},
): ISkillSummary {
  return {
    id: `skill-${String(index).padStart(3, '0')}`,
    title: `Skill ${String(index).padStart(3, '0')}`,
    description: `描述 ${index}`,
    version: '1.0.0',
    createdAt: new Date(2026, 0, index + 1).toISOString(),
    updatedAt: new Date(2026, 1, index + 1).toISOString(),
    ...overrides,
  }
}

describe('useSkillCatalog', () => {
  it('searches title, id, and description case-insensitively', () => {
    const skills = ref([
      createSkill(1, { title: 'Login Flow' }),
      createSkill(2, { id: 'checkout-special' }),
      createSkill(3, { description: '验证退款流程' }),
    ])
    const catalog = useSkillCatalog(skills)

    catalog.setQuery('login')
    expect(catalog.visibleSkills.value.map((skill) => skill.id)).toEqual([
      'skill-001',
    ])

    catalog.setQuery('CHECKOUT')
    expect(catalog.visibleSkills.value.map((skill) => skill.id)).toEqual([
      'checkout-special',
    ])

    catalog.setQuery('退款')
    expect(catalog.visibleSkills.value.map((skill) => skill.id)).toEqual([
      'skill-003',
    ])
  })

  it('supports all data-backed sort modes', () => {
    const skills = [
      createSkill(1, {
        title: 'Bravo',
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date('2026-03-01').toISOString(),
      }),
      createSkill(2, {
        title: 'Alpha',
        createdAt: new Date('2026-02-01').toISOString(),
        updatedAt: new Date('2026-01-01').toISOString(),
      }),
    ]
    const catalog = useSkillCatalog(skills)

    expect(catalog.visibleSkills.value.map((skill) => skill.title)).toEqual([
      'Bravo',
      'Alpha',
    ])

    catalog.setSort('created-desc')
    expect(catalog.visibleSkills.value.map((skill) => skill.title)).toEqual([
      'Alpha',
      'Bravo',
    ])

    catalog.setSort('title-asc')
    expect(catalog.visibleSkills.value.map((skill) => skill.title)).toEqual([
      'Alpha',
      'Bravo',
    ])
  })

  it('paginates large lists and resets the page when the query changes', async () => {
    const skills = ref(
      Array.from({ length: 55 }, (_, index) => createSkill(index + 1)),
    )
    const catalog = useSkillCatalog(skills)

    expect(catalog.pageCount.value).toBe(3)
    expect(catalog.visibleSkills.value).toHaveLength(25)

    catalog.setPage(3)
    expect(catalog.visibleSkills.value).toHaveLength(5)

    catalog.setQuery('Skill 001')
    await nextTick()
    expect(catalog.page.value).toBe(1)
    expect(catalog.filteredTotal.value).toBe(1)

    skills.value = skills.value.slice(0, 10)
    catalog.clearQuery()
    await nextTick()
    expect(catalog.pageCount.value).toBe(1)
    expect(catalog.page.value).toBe(1)
  })
})
