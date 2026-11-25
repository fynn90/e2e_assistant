<!-- 系统配置路由页：组合配置展示、保存反馈与工作区切换后的 Skill 状态失效。 -->
<script setup lang="ts">
import { NAlert } from 'naive-ui'
import type { IUpdateConfigRequest } from '@authine-e2e-agent/types'
import WorkspaceSummaryCard from '../components/WorkspaceSummaryCard.vue'
import { useGlobalMessage } from '../composables/useGlobalMessage'
import { usePlatformStore } from '../stores/platform'
import { useWorkbenchStore } from '../stores/workbench'

const platformStore = usePlatformStore()
const workbenchStore = useWorkbenchStore()
const message = useGlobalMessage()

/**
 * 保存平台配置，并在项目目录变化后清除旧工作区的 Skill 状态。
 * @param payload 已通过前端校验的配置更新载荷。
 * @returns 保存流程完成后无返回值。
 * @throws 不向上抛出异常，平台 Store 会记录失败原因。
 */
async function saveConfig(payload: IUpdateConfigRequest): Promise<void> {
  const previousProjectDirectory =
    platformStore.configSummary?.projectDirectory ?? ''
  const saved = await platformStore.update(payload)

  if (!saved) {
    return
  }

  if (
    platformStore.configSummary?.projectDirectory !== previousProjectDirectory
  ) {
    workbenchStore.invalidateSkills()
  }

  message.success('平台配置已保存')
}
</script>

<template>
  <div class="page-pad">
    <n-alert
      v-if="platformStore.errorMessage"
      type="error"
      :show-icon="false"
      class="page-alert"
      closable
      @close="platformStore.clearError"
    >
      {{ platformStore.errorMessage }}
    </n-alert>

    <workspace-summary-card
      v-if="platformStore.configSummary"
      :config-path="platformStore.configPath"
      :config-summary="platformStore.configSummary"
      :issues="platformStore.issues"
      :saving="platformStore.submitting"
      @save="saveConfig"
    />
  </div>
</template>

<style scoped>
.page-pad {
  max-width: 1240px;
  margin: 0 auto;
  padding: var(--space-page);
}
.page-alert {
  margin-bottom: var(--space-lg);
}
@media (max-width: 760px) {
  .page-pad {
    padding: var(--space-md);
  }
}
</style>
