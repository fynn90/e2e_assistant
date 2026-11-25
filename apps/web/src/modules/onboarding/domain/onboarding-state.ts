/**
 * 定义首次激活引导的领域状态、里程碑顺序与纯状态转换规则。
 */

export const ONBOARDING_STATE_VERSION = 1 as const

export const ONBOARDING_MILESTONE_ORDER = [
  'workspace-ready',
  'skill-ready',
  'case-ready',
  'reviewed-script-saved',
] as const

export type TOnboardingMilestone = (typeof ONBOARDING_MILESTONE_ORDER)[number]
export type TOnboardingGuideStatus = 'active' | 'dismissed'
export type TOnboardingMilestones = Partial<
  Record<TOnboardingMilestone, string>
>

export interface IOnboardingStateV1 {
  version: typeof ONBOARDING_STATE_VERSION
  workspaceDirectory: string
  guideStatus: TOnboardingGuideStatus
  milestones: TOnboardingMilestones
  activeSkillId?: string
  startedAt: string
  updatedAt: string
  dismissedAt?: string
  activationCompletedAt?: string
  completionAcknowledgedAt?: string
}

/**
 * 为新工作区创建已开始的首次激活引导状态。
 * @param workspaceDirectory 工作区绝对目录，用于隔离不同项目的引导状态。
 * @param now 当前 ISO 时间字符串。
 * @returns 包含“工作区已配置”里程碑的初始状态。
 * @throws 当工作区目录为空时抛出错误，防止生成无法持久化的状态。
 */
export function createOnboardingState(
  workspaceDirectory: string,
  now: string,
): IOnboardingStateV1 {
  const normalizedDirectory = workspaceDirectory.trim()

  if (!normalizedDirectory) {
    throw new Error('创建引导状态时工作区目录不能为空。')
  }

  return {
    version: ONBOARDING_STATE_VERSION,
    workspaceDirectory: normalizedDirectory,
    guideStatus: 'active',
    milestones: { 'workspace-ready': now },
    startedAt: now,
    updatedAt: now,
  }
}

/**
 * 校验并标准化从持久化层读取的未知引导状态。
 * @param value 持久化层解析得到的未知值。
 * @param workspaceDirectory 当前工作区目录。
 * @returns 有效的 v1 引导状态；无效、跨工作区或未来版本数据返回 null。
 * @throws 不抛出异常，所有无效输入均安全返回 null。
 */
export function normalizeOnboardingState(
  value: unknown,
  workspaceDirectory: string,
): IOnboardingStateV1 | null {
  if (!isRecord(value) || value.version !== ONBOARDING_STATE_VERSION) {
    return null
  }

  const normalizedDirectory = workspaceDirectory.trim()
  if (
    !normalizedDirectory ||
    value.workspaceDirectory !== normalizedDirectory
  ) {
    return null
  }

  if (
    (value.guideStatus !== 'active' && value.guideStatus !== 'dismissed') ||
    typeof value.startedAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isRecord(value.milestones)
  ) {
    return null
  }

  const milestones: TOnboardingMilestones = {}
  for (const milestone of ONBOARDING_MILESTONE_ORDER) {
    const timestamp = value.milestones[milestone]
    if (typeof timestamp === 'string') {
      milestones[milestone] = timestamp
    }
  }

  if (!milestones['workspace-ready']) {
    return null
  }

  let foundIncompleteMilestone = false
  for (const milestone of ONBOARDING_MILESTONE_ORDER) {
    if (!milestones[milestone]) {
      foundIncompleteMilestone = true
    } else if (foundIncompleteMilestone) {
      return null
    }
  }

  const activeSkillId =
    typeof value.activeSkillId === 'string' ? value.activeSkillId : undefined
  if (milestones['skill-ready'] && !activeSkillId) {
    return null
  }

  if (
    (typeof value.activationCompletedAt === 'string' &&
      !milestones['reviewed-script-saved']) ||
    (typeof value.completionAcknowledgedAt === 'string' &&
      typeof value.activationCompletedAt !== 'string')
  ) {
    return null
  }

  return {
    version: ONBOARDING_STATE_VERSION,
    workspaceDirectory: normalizedDirectory,
    guideStatus: value.guideStatus,
    milestones,
    ...(activeSkillId ? { activeSkillId } : {}),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(typeof value.dismissedAt === 'string'
      ? { dismissedAt: value.dismissedAt }
      : {}),
    ...(typeof value.activationCompletedAt === 'string'
      ? { activationCompletedAt: value.activationCompletedAt }
      : {}),
    ...(typeof value.completionAcknowledgedAt === 'string'
      ? { completionAcknowledgedAt: value.completionAcknowledgedAt }
      : {}),
  }
}

/**
 * 记录一个满足前置条件的激活里程碑。
 * @param state 当前引导状态。
 * @param milestone 待记录的里程碑。
 * @param now 当前 ISO 时间字符串。
 * @param skillId 与 Skill 相关的里程碑所属 Skill ID。
 * @returns 新状态；事件不满足顺序或 Skill 归属时返回原状态。
 * @throws 不抛出异常，无效事件通过返回原状态被忽略。
 */
export function recordOnboardingMilestone(
  state: IOnboardingStateV1,
  milestone: TOnboardingMilestone,
  now: string,
  skillId?: string,
): IOnboardingStateV1 {
  if (state.milestones[milestone]) {
    return state
  }

  const milestoneIndex = ONBOARDING_MILESTONE_ORDER.indexOf(milestone)
  const previousMilestone = ONBOARDING_MILESTONE_ORDER[milestoneIndex - 1]
  if (previousMilestone && !state.milestones[previousMilestone]) {
    return state
  }

  if (milestone === 'skill-ready') {
    if (!skillId) {
      return state
    }

    return {
      ...state,
      activeSkillId: skillId,
      milestones: { ...state.milestones, [milestone]: now },
      updatedAt: now,
    }
  }

  if (milestone === 'case-ready' || milestone === 'reviewed-script-saved') {
    if (!skillId || !state.activeSkillId || skillId !== state.activeSkillId) {
      return state
    }
  }

  const nextState: IOnboardingStateV1 = {
    ...state,
    milestones: { ...state.milestones, [milestone]: now },
    updatedAt: now,
  }

  if (milestone === 'reviewed-script-saved') {
    nextState.activationCompletedAt = state.activationCompletedAt ?? now
  }

  return nextState
}

/**
 * 在结构化用例尚未完成前，将引导绑定到用户当前打开的 Skill。
 * @param state 当前引导状态。
 * @param skillId 当前打开的 Skill ID。
 * @param now 当前 ISO 时间字符串。
 * @returns 更新 Skill 归属后的状态；已完成用例里程碑或参数无效时返回原状态。
 * @throws 不抛出异常。
 */
export function bindOnboardingSkill(
  state: IOnboardingStateV1,
  skillId: string,
  now: string,
): IOnboardingStateV1 {
  if (
    !skillId ||
    state.milestones['case-ready'] ||
    state.activeSkillId === skillId
  ) {
    return state
  }

  const milestones = { ...state.milestones }
  if (!milestones['skill-ready']) {
    milestones['skill-ready'] = now
  }

  return {
    ...state,
    activeSkillId: skillId,
    milestones,
    updatedAt: now,
  }
}

/**
 * 将引导标记为已跳过但保留所有激活数据。
 * @param state 当前引导状态。
 * @param now 当前 ISO 时间字符串。
 * @returns 已隐藏引导的新状态。
 * @throws 不抛出异常。
 */
export function dismissOnboarding(
  state: IOnboardingStateV1,
  now: string,
): IOnboardingStateV1 {
  if (state.guideStatus === 'dismissed') {
    return state
  }

  return {
    ...state,
    guideStatus: 'dismissed',
    dismissedAt: now,
    updatedAt: now,
  }
}

/**
 * 恢复已跳过的引导并继续保留既有里程碑。
 * @param state 当前引导状态。
 * @param now 当前 ISO 时间字符串。
 * @returns 已恢复引导的新状态。
 * @throws 不抛出异常。
 */
export function resumeOnboarding(
  state: IOnboardingStateV1,
  now: string,
): IOnboardingStateV1 {
  if (state.guideStatus === 'active') {
    return state
  }

  const { dismissedAt: _dismissedAt, ...rest } = state
  return {
    ...rest,
    guideStatus: 'active',
    updatedAt: now,
  }
}

/**
 * 记录用户已确认查看完成状态，避免后续加载重复展示。
 * @param state 当前引导状态。
 * @param now 当前 ISO 时间字符串。
 * @returns 带完成确认时间的新状态；尚未激活时返回原状态。
 * @throws 不抛出异常。
 */
export function acknowledgeOnboardingCompletion(
  state: IOnboardingStateV1,
  now: string,
): IOnboardingStateV1 {
  if (!state.activationCompletedAt || state.completionAcknowledgedAt) {
    return state
  }

  return {
    ...state,
    completionAcknowledgedAt: now,
    updatedAt: now,
  }
}

/**
 * 获取当前第一个未完成的激活里程碑。
 * @param state 当前引导状态，可为空。
 * @returns 第一个未完成里程碑；全部完成或无状态时返回 null。
 * @throws 不抛出异常。
 */
export function getNextOnboardingMilestone(
  state: IOnboardingStateV1 | null,
): TOnboardingMilestone | null {
  if (!state) {
    return null
  }

  return (
    ONBOARDING_MILESTONE_ORDER.find(
      (milestone) => !state.milestones[milestone],
    ) ?? null
  )
}

/**
 * 判断未知值是否为可读取属性的普通记录。
 * @param value 待判断值。
 * @returns 是对象记录时返回 true。
 * @throws 不抛出异常。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
