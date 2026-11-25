<!-- Skill 管理路由页：组合列表加载、刷新反馈、首次激活引导与开发页导航。 -->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { NAlert } from 'naive-ui'
import { useRouter } from 'vue-router'
import type { ISkillSummary } from '@charlie_deng/e2e-assistant-types'
import OnboardingProgressStrip from '../modules/onboarding/components/OnboardingProgressStrip.vue'
import { useOnboardingStore } from '../modules/onboarding/stores/onboarding'
import SkillListCard from '../modules/skills/SkillListCard.vue'
import { createSkillDevelopmentDefaultLocation } from '../router/skill-development-navigation'
import { useWorkbenchStore } from '../stores/workbench'

const router = useRouter()
const workbenchStore = useWorkbenchStore()
const onboardingStore = useOnboardingStore()

const backgroundErrorMessage = computed(() =>
  workbenchStore.hasSuccessfulSkillLoad ? workbenchStore.errorMessage : '',
)
const initialSkillError = computed(() =>
  workbenchStore.hasSuccessfulSkillLoad ? '' : workbenchStore.errorMessage,
)

onMounted(() => void workbenchStore.refreshSkills())

/**
 * 记录 Skill 激活里程碑并打开对应开发工作区。
 * @param skillId 待打开的 Skill ID。
 * @returns 导航触发后无返回值。
 * @throws 不抛出异常，路由失败由 Vue Router 处理。
 */
function openSkill(skillId: string): void {
  onboardingStore.recordSkillReady(skillId)
  // 从列表进入 Skill 的**落地页**：产品刻意选择 E2E 用例工作区（commit 9d528b2），
  // 而非 Chat。异常回退场景才用 Chat（见 useSkillDevelopment 的注释）。
  void router.push(createSkillDevelopmentDefaultLocation(skillId))
}

/**
 * 处理新建 Skill 成功事件并进入该 Skill。
 * @param skill 新创建的 Skill 摘要。
 * @returns 处理完成后无返回值。
 * @throws 不抛出异常。
 */
function handleCreated(skill: ISkillSummary): void {
  openSkill(skill.id)
}

/**
 * 手动开始或恢复当前工作区的首次激活引导。
 * @returns 操作完成后无返回值。
 * @throws 不抛出异常。
 */
function startOnboarding(): void {
  onboardingStore.startOrResumeGuide()
}
</script>

<template>
  <div class="page-pad">
    <n-alert
      v-if="backgroundErrorMessage"
      type="error"
      :show-icon="false"
      class="page-alert"
      closable
      @close="workbenchStore.clearError"
    >
      {{ backgroundErrorMessage }} 当前列表仍保留上次成功同步的结果。
    </n-alert>

    <onboarding-progress-strip
      v-if="
        onboardingStore.shouldShowProgress && onboardingStore.onboardingState
      "
      class="onboarding-strip"
      :state="onboardingStore.onboardingState"
      @dismiss="onboardingStore.dismissGuide"
      @acknowledge-completion="onboardingStore.acknowledgeCompletion"
    />

    <skill-list-card
      :skill-list="workbenchStore.skillList"
      :initial-loading="workbenchStore.initialLoading"
      :initial-load-error="initialSkillError"
      :refreshing-skills="workbenchStore.refreshingSkills"
      :last-successful-refresh-at="workbenchStore.lastSuccessfulRefreshAt"
      :show-onboarding-entry="
        onboardingStore.canStartOrResume && !onboardingStore.shouldShowProgress
      "
      @refresh="workbenchStore.refreshSkills"
      @open-skill="openSkill"
      @created="handleCreated"
      @deleted="workbenchStore.refreshSkills"
      @start-onboarding="startOnboarding"
    />
  </div>
</template>

<style scoped>
.page-pad {
  max-width: 1240px;
  margin: 0 auto;
  padding: 0;
}
.page-alert,
.onboarding-strip {
  margin-bottom: var(--space-lg);
}
</style>
