<!--
  应用根组件：平台启动门禁、配置初始化、工作区激活引导，以及 **Agent 工作台（v13）**。

  v13 的两处新增：

    1. **工作台抽屉挂载点**：从 Skill 开发页上移到应用外壳，因此所有路由都能展开，
       且是同一个实例（PRD G-1/G-2）。
    2. **完成通知 provider 与宿主**：`n-notification-provider` 提供顶部右侧
       滑入的提示容器（PRD N-3）；`WorkbenchNoticeHost` 在其**内部**消费通知 ——
       本组件渲染了 provider，自身不在其子树中，故必须由子组件承担（见该组件注释）。

  抽屉本身用 `v-if` 控制显隐，因此**通知的监听不能挂在抽屉里**：收起时组件
  不渲染，watch 会一并消失，而需求恰恰要求「收起时才提示」（PRD N-1）。
  这正是把监听放在常驻宿主上的原因。

  v17 追加一个并列的宿主：`/agent` 会话任务的终态提示（PRD C7）。两条通道
  各自负责自己的任务来源、互不重复，因此是两个组件而不是一个。
-->
<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import {
  NAlert,
  NButton,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  NResult,
} from 'naive-ui'
import { RouterView } from 'vue-router'
import InitializationFormCard from './components/InitializationFormCard.vue'
import PageLoadingCard from './components/PageLoadingCard.vue'
import WorkbenchNoticeHost from './components/WorkbenchNoticeHost.vue'
import AgentSessionNoticeHost from './components/AgentSessionNoticeHost.vue'
import GlobalChatDrawer from './modules/agent-work/components/GlobalChatDrawer.vue'
import { usePlatformStore } from './stores/platform'
import { useOnboardingStore } from './modules/onboarding/stores/onboarding'
import { naiveThemeOverrides } from './theme/naive-theme'

const platformStore = usePlatformStore()
const onboardingStore = useOnboardingStore()
const hasPageError = computed(() => Boolean(platformStore.errorMessage))

onMounted(() => void platformStore.bootstrap())
watch(
  () => platformStore.configSummary?.projectDirectory,
  (projectDirectory) => {
    if (projectDirectory) {
      onboardingStore.hydrateWorkspace(projectDirectory)
    }
  },
)

/**
 * 提交首次初始化或修复配置，并同步对应工作区的激活引导状态。
 * @returns 配置提交完成后无返回值。
 * @throws 不抛出异常，平台 Store 会将失败原因写入页面错误状态。
 */
async function submitConfiguration(): Promise<void> {
  const freshInitialization = platformStore.pageState === 'uninitialized'
  const saved = freshInitialization
    ? await platformStore.initialize()
    : await platformStore.update()

  if (!saved || !platformStore.configSummary) {
    return
  }

  if (freshInitialization) {
    onboardingStore.beginFreshWorkspace(
      platformStore.configSummary.projectDirectory,
    )
  } else {
    onboardingStore.hydrateWorkspace(
      platformStore.configSummary.projectDirectory,
    )
  }
}
</script>

<template>
  <n-config-provider :theme-overrides="naiveThemeOverrides">
    <n-dialog-provider>
      <n-message-provider>
        <!-- 完成提示容器：顶部右侧（PRD N-3）；全站此前未使用 notification，
             因此新引入它不会影响任何既有 message 的位置与动效。 -->
        <n-notification-provider placement="top-right">
          <!-- 平台就绪门禁与 v9 一致：未就绪时展示初始化 / 错误页，不渲染工作台。 -->
          <template v-if="platformStore.pageState === 'ready'">
            <router-view />

            <!-- Agent 工作台（v13 PRD G-1）：应用级唯一实例，任意路由可用 -->
            <global-chat-drawer />

            <!-- 完成提示宿主：必须常驻（不随抽屉显隐卸载），否则收起时收不到终态 -->
            <workbench-notice-host />

            <!-- `/agent` 会话终态提示宿主（v17 C7）：与上一条是并列的两条通道；
                 同样必须常驻——用户离开 /agent 才需要它，而那正是页面卸载的时刻 -->
            <agent-session-notice-host />
          </template>

          <div v-else class="page-shell">
            <div class="page-content">
              <div class="page-grid">
                <n-alert
                  v-if="
                    hasPageError &&
                    platformStore.pageState !== 'service-unavailable'
                  "
                  type="error"
                  :show-icon="false"
                >
                  {{ platformStore.errorMessage }}
                </n-alert>

                <page-loading-card
                  v-if="platformStore.pageState === 'loading'"
                />

                <n-result
                  v-else-if="platformStore.pageState === 'service-unavailable'"
                  status="error"
                  title="本地服务不可用"
                  :description="platformStore.errorMessage"
                >
                  <template #footer>
                    <n-button type="primary" @click="platformStore.bootstrap"
                      >重试</n-button
                    >
                  </template>
                </n-result>

                <initialization-form-card
                  v-else
                  :mode="
                    platformStore.pageState === 'corrupted'
                      ? 'repair'
                      : 'initialize'
                  "
                  :config-path="platformStore.configPath"
                  :form-model="platformStore.formModel"
                  :submitting="platformStore.submitting"
                  @submit="submitConfiguration"
                  @update="platformStore.clearError"
                />
              </div>
            </div>
          </div>
        </n-notification-provider>
      </n-message-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>

<style scoped>
.page-shell {
  min-height: 100vh;
  padding: 40px 20px;
  background-color: #f8fafc;
}
.page-content {
  max-width: 1240px;
  margin: 0 auto;
}
.page-grid {
  display: grid;
  gap: 20px;
}
@media (max-width: 640px) {
  .page-shell {
    padding: 20px 14px;
  }
}
</style>
