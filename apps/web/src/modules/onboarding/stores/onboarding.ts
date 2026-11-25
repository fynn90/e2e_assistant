/**
 * 管理跨路由的首次激活引导状态，并将所有状态变更持久化到工作区作用域。
 */
import { computed, readonly, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  acknowledgeOnboardingCompletion,
  bindOnboardingSkill,
  createOnboardingState,
  dismissOnboarding,
  getNextOnboardingMilestone,
  recordOnboardingMilestone,
  resumeOnboarding,
  type IOnboardingStateV1,
} from '../domain/onboarding-state'
import {
  createOnboardingLocalStorageRepository,
  type IOnboardingStateRepository,
} from '../infrastructure/onboarding-local-storage'

export const useOnboardingStore = defineStore('onboarding', () => {
  const repository: IOnboardingStateRepository =
    createOnboardingLocalStorageRepository()
  const workspaceDirectory = ref('')
  const onboardingState = ref<IOnboardingStateV1 | null>(null)

  const guideActive = computed(
    () => onboardingState.value?.guideStatus === 'active',
  )
  const activationCompleted = computed(() =>
    Boolean(onboardingState.value?.activationCompletedAt),
  )
  const completionAcknowledged = computed(() =>
    Boolean(onboardingState.value?.completionAcknowledgedAt),
  )
  const shouldShowProgress = computed(
    () => guideActive.value && !completionAcknowledged.value,
  )
  const canStartOrResume = computed(
    () =>
      Boolean(workspaceDirectory.value) &&
      !activationCompleted.value &&
      (!onboardingState.value ||
        onboardingState.value.guideStatus === 'dismissed'),
  )
  const nextMilestone = computed(() =>
    getNextOnboardingMilestone(onboardingState.value),
  )

  /**
   * 加载指定工作区已存在的引导状态，但不会自动创建或启动引导。
   * @param projectDirectory 平台配置中的项目目录。
   * @returns 加载完成后无返回值。
   * @throws 不抛出异常，存储异常由仓储安全降级。
   */
  function hydrateWorkspace(projectDirectory: string): void {
    const normalizedDirectory = projectDirectory.trim()
    workspaceDirectory.value = normalizedDirectory
    onboardingState.value = normalizedDirectory
      ? repository.load(normalizedDirectory)
      : null
  }

  /**
   * 为刚完成首次初始化的工作区创建新的激活引导。
   * @param projectDirectory 首次初始化成功的项目目录。
   * @returns 创建成功后无返回值。
   * @throws 工作区目录为空时不创建状态，其余异常由领域层约束避免。
   */
  function beginFreshWorkspace(projectDirectory: string): void {
    const normalizedDirectory = projectDirectory.trim()
    if (!normalizedDirectory) {
      return
    }

    workspaceDirectory.value = normalizedDirectory
    applyState(createOnboardingState(normalizedDirectory, nowIso()))
  }

  /**
   * 手动开始尚无记录的引导，或恢复此前跳过的引导。
   * @returns 引导成功开始或恢复时返回 true，否则返回 false。
   * @throws 不抛出异常。
   */
  function startOrResumeGuide(): boolean {
    if (!workspaceDirectory.value || activationCompleted.value) {
      return false
    }

    if (!onboardingState.value) {
      applyState(createOnboardingState(workspaceDirectory.value, nowIso()))
      return true
    }

    applyState(resumeOnboarding(onboardingState.value, nowIso()))
    return true
  }

  /**
   * 跳过当前引导展示，同时保留已完成里程碑。
   * @returns 状态发生变化时返回 true。
   * @throws 不抛出异常。
   */
  function dismissGuide(): boolean {
    if (!onboardingState.value) {
      return false
    }

    return applyTransition(dismissOnboarding(onboardingState.value, nowIso()))
  }

  /**
   * 记录用户已查看首次激活完成提示。
   * @returns 状态发生变化时返回 true。
   * @throws 不抛出异常。
   */
  function acknowledgeCompletion(): boolean {
    if (!onboardingState.value) {
      return false
    }

    return applyTransition(
      acknowledgeOnboardingCompletion(onboardingState.value, nowIso()),
    )
  }

  /**
   * 将引导绑定到用户新建或打开的 Skill，并记录 Skill 已就绪里程碑。
   * @param skillId 当前 Skill ID。
   * @returns 状态发生变化时返回 true。
   * @throws 不抛出异常。
   */
  function recordSkillReady(skillId: string): boolean {
    if (!onboardingState.value) {
      return false
    }

    return applyTransition(
      bindOnboardingSkill(onboardingState.value, skillId, nowIso()),
    )
  }

  /**
   * 记录当前引导 Skill 已保存可生成的结构化用例。
   * @param skillId 已保存结构化用例的 Skill ID。
   * @returns 状态发生变化时返回 true。
   * @throws 不抛出异常，非当前引导 Skill 的事件会被领域层忽略。
   */
  function recordCaseReady(skillId: string): boolean {
    return recordSkillMilestone('case-ready', skillId)
  }

  /**
   * 记录当前引导 Skill 的生成脚本已完成审阅并成功保存。
   * @param skillId 已保存脚本的 Skill ID。
   * @returns 状态发生变化时返回 true。
   * @throws 不抛出异常，非当前引导 Skill 的事件会被领域层忽略。
   */
  function recordReviewedScriptSaved(skillId: string): boolean {
    return recordSkillMilestone('reviewed-script-saved', skillId)
  }

  /**
   * 记录需要 Skill 归属校验的里程碑。
   * @param milestone 用例就绪或脚本已审阅保存里程碑。
   * @param skillId 事件所属 Skill ID。
   * @returns 状态发生变化时返回 true。
   * @throws 不抛出异常。
   */
  function recordSkillMilestone(
    milestone: 'case-ready' | 'reviewed-script-saved',
    skillId: string,
  ): boolean {
    if (!onboardingState.value) {
      return false
    }

    return applyTransition(
      recordOnboardingMilestone(
        onboardingState.value,
        milestone,
        nowIso(),
        skillId,
      ),
    )
  }

  /**
   * 应用并持久化新的领域状态。
   * @param nextState 新领域状态。
   * @returns 应用完成后无返回值。
   * @throws 不抛出异常，持久化失败时保留当前会话内状态。
   */
  function applyState(nextState: IOnboardingStateV1): void {
    onboardingState.value = nextState
    repository.save(nextState)
  }

  /**
   * 仅在领域状态确实变化时应用并持久化转换结果。
   * @param nextState 领域转换返回的状态。
   * @returns 状态引用变化时返回 true。
   * @throws 不抛出异常。
   */
  function applyTransition(nextState: IOnboardingStateV1): boolean {
    if (nextState === onboardingState.value) {
      return false
    }

    applyState(nextState)
    return true
  }

  return {
    onboardingState: readonly(onboardingState),
    workspaceDirectory: readonly(workspaceDirectory),
    guideActive,
    activationCompleted,
    completionAcknowledged,
    shouldShowProgress,
    canStartOrResume,
    nextMilestone,
    hydrateWorkspace,
    beginFreshWorkspace,
    startOrResumeGuide,
    dismissGuide,
    acknowledgeCompletion,
    recordSkillReady,
    recordCaseReady,
    recordReviewedScriptSaved,
  }
})

/**
 * 获取当前 ISO 时间字符串，集中保证领域状态时间格式一致。
 * @returns 当前时间的 ISO 字符串。
 * @throws 系统时间不可序列化时由原生 Date 抛出异常。
 */
function nowIso(): string {
  return new Date().toISOString()
}
