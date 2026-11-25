// Workbench 状态：管理 Skill 列表请求生命周期、刷新反馈与错误恢复。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ISkillSummary } from '@fynn90-e2e_assistant/types'
import { fetchSkills } from '../services/skill-api'
import { ApiClientError } from '../services/http-client'

export const useWorkbenchStore = defineStore('workbench', () => {
  const skillList = ref<ISkillSummary[]>([])
  const refreshingSkills = ref(false)
  const skillsInitialized = ref(false)
  const lastSuccessfulRefreshAt = ref<string | null>(null)
  const errorMessage = ref('')
  let refreshController: AbortController | null = null

  const hasSuccessfulSkillLoad = computed(
    () => lastSuccessfulRefreshAt.value !== null,
  )
  const initialLoading = computed(
    () => refreshingSkills.value && !hasSuccessfulSkillLoad.value,
  )

  /**
   * 刷新 Skill 列表，并取消已过期的并发请求。
   * @returns 请求结束后无返回值，成功结果写入 Store。
   * @throws 不向调用方抛出异常；失败原因写入 `errorMessage`。
   */
  async function refreshSkills (): Promise<void> {
    refreshController?.abort()
    const controller = new AbortController()
    refreshController = controller
    refreshingSkills.value = true
    errorMessage.value = ''

    try {
      const response = await fetchSkills(controller.signal)

      if (controller.signal.aborted) {
        return
      }

      skillList.value = response.data
      lastSuccessfulRefreshAt.value = new Date().toISOString()
    } catch (error) {
      if (controller.signal.aborted || isAbortedRequest(error)) {
        return
      }

      errorMessage.value = getSkillListErrorMessage(error)
    } finally {
      if (refreshController === controller) {
        refreshController = null
        refreshingSkills.value = false
        skillsInitialized.value = true
      }
    }
  }

  /**
   * 使当前 Skill 列表状态失效，并中止仍在执行的旧工作区请求。
   * @returns 失效处理完成后无返回值。
   * @throws 不抛出异常。
   */
  function invalidateSkills (): void {
    const controller = refreshController
    refreshController = null
    controller?.abort()
    skillList.value = []
    refreshingSkills.value = false
    skillsInitialized.value = false
    lastSuccessfulRefreshAt.value = null
    errorMessage.value = ''
  }

  /**
   * 清除 Workbench 当前错误信息。
   * @returns 清理完成后无返回值。
   * @throws 不抛出异常。
   */
  function clearError (): void {
    errorMessage.value = ''
  }

  return {
    skillList,
    refreshingSkills,
    skillsInitialized,
    lastSuccessfulRefreshAt,
    errorMessage,
    initialLoading,
    hasSuccessfulSkillLoad,
    refreshSkills,
    invalidateSkills,
    clearError,
  }
})

/**
 * 判断请求异常是否来自主动取消。
 * @param error 待识别的异常。
 * @returns 主动取消时返回 true。
 * @throws 不抛出异常。
 */
function isAbortedRequest (error: unknown): boolean {
  return error instanceof ApiClientError && error.kind === 'aborted'
}

/**
 * 将 Skill 列表异常转换为面向用户的恢复提示。
 * @param error 请求阶段捕获的异常。
 * @returns 可直接展示的中文错误文本。
 * @throws 不抛出异常。
 */
function getSkillListErrorMessage (error: unknown): string {
  if (error instanceof ApiClientError || error instanceof Error) {
    return error.message || '获取 Skill 列表失败，请稍后重试。'
  }

  return '获取 Skill 列表失败，请稍后重试。'
}
