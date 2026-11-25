// Skill 目录查询模型：提供可复用的搜索、排序与分页派生状态。
import { computed, shallowRef, toValue, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'
import type { ISkillSummary } from '@authine-e2e-agent/types'

export type TSkillCatalogSort = 'updated-desc' | 'created-desc' | 'title-asc'

const DEFAULT_PAGE_SIZE = 25

/**
 * 创建可接收静态值、Ref 或 getter 的 Skill 目录查询模型。
 * @param skillList Skill 摘要输入，可为静态数组或响应式来源。
 * @param pageSize 每页最多展示的 Skill 数量。
 * @returns 查询状态、派生结果与显式更新动作。
 * @throws 不抛出异常。
 */
export function useSkillCatalog(
  skillList: MaybeRefOrGetter<readonly ISkillSummary[]>,
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const query = shallowRef('')
  const sort = shallowRef<TSkillCatalogSort>('updated-desc')
  const page = shallowRef(1)

  const normalizedQuery = computed(() =>
    query.value.trim().toLocaleLowerCase('zh-CN'),
  )
  const filteredSkills = computed(() => {
    const searchText = normalizedQuery.value
    const sourceSkills = [...toValue(skillList)]
    const matchedSkills = searchText
      ? sourceSkills.filter((skill) =>
          [skill.title, skill.id, skill.description].some((value) =>
            value.toLocaleLowerCase('zh-CN').includes(searchText),
          ),
        )
      : sourceSkills

    return matchedSkills.sort((leftSkill, rightSkill) => {
      if (sort.value === 'created-desc') {
        return (
          toTimestamp(rightSkill.createdAt) - toTimestamp(leftSkill.createdAt)
        )
      }

      if (sort.value === 'title-asc') {
        return leftSkill.title.localeCompare(rightSkill.title, 'zh-CN')
      }

      return (
        toTimestamp(rightSkill.updatedAt) - toTimestamp(leftSkill.updatedAt)
      )
    })
  })
  const total = computed(() => toValue(skillList).length)
  const filteredTotal = computed(() => filteredSkills.value.length)
  const pageCount = computed(() =>
    Math.max(1, Math.ceil(filteredTotal.value / pageSize)),
  )
  const visibleSkills = computed(() => {
    const startIndex = (page.value - 1) * pageSize
    return filteredSkills.value.slice(startIndex, startIndex + pageSize)
  })
  const hasQuery = computed(() => normalizedQuery.value.length > 0)

  watch([normalizedQuery, sort], () => {
    page.value = 1
  })
  watch(pageCount, (nextPageCount) => {
    page.value = Math.min(page.value, nextPageCount)
  })

  /**
   * 更新搜索词。
   * @param value 用户输入的搜索文本。
   * @returns 更新完成后无返回值。
   * @throws 不抛出异常。
   */
  function setQuery(value: string): void {
    query.value = value
  }

  /**
   * 清空搜索词并返回第一页。
   * @returns 清理完成后无返回值。
   * @throws 不抛出异常。
   */
  function clearQuery(): void {
    query.value = ''
    page.value = 1
  }

  /**
   * 更新排序方式。
   * @param value 目标排序键。
   * @returns 更新完成后无返回值。
   * @throws 不抛出异常。
   */
  function setSort(value: TSkillCatalogSort): void {
    sort.value = value
  }

  /**
   * 更新当前页码，并约束在有效分页范围内。
   * @param value 目标页码。
   * @returns 更新完成后无返回值。
   * @throws 不抛出异常。
   */
  function setPage(value: number): void {
    page.value = Math.min(Math.max(1, value), pageCount.value)
  }

  return {
    query,
    sort,
    page,
    pageSize,
    total,
    filteredTotal,
    pageCount,
    visibleSkills,
    hasQuery,
    setQuery,
    clearQuery,
    setSort,
    setPage,
  }
}

/**
 * 将时间字符串转换为可稳定比较的时间戳。
 * @param value ISO 或其他 Date 可解析时间文本。
 * @returns 有效时间戳；无效时间返回 0。
 * @throws 不抛出异常。
 */
function toTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}
