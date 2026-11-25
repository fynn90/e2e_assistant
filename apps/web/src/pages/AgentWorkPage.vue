<!-- Agent 工作台页面：会话列表 + 可复用 Agent 工作面板（状态条 / 时间线 / 输入区）的一体化布局。 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useAgentWorkStore } from '../stores/agent-work'
import {
  deleteAgentSession,
  renameAgentSession,
} from '../services/agent-work-api'
import SessionList from '../modules/agent-work/components/SessionList.vue'
import AgentWorkPanel from '../modules/agent-work/components/AgentWorkPanel.vue'

const store = useAgentWorkStore()
const message = useMessage()
const sessionsLoading = ref(false)

onMounted(() => {
  // v17 C7：标记视图已挂载——任务终态在页面可见时不出全局提示。
  store.viewAttached = true
  void refreshSessions()
})

onBeforeUnmount(() => {
  // v17 C7：离开页面时不等于释放——有任务在跑则保持订阅，让终态能触发提示
  //（见 store.detachView 的说明）。
  store.detachView()
})

/**
 * 加载会话列表。
 * @returns 列表加载完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function refreshSessions(): Promise<void> {
  sessionsLoading.value = true
  try {
    await store.loadSessions()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '加载会话列表失败。')
  } finally {
    sessionsLoading.value = false
  }
}

/**
 * 选中历史会话：恢复完整工作时间线。
 * @param sessionId 用户选中的会话 ID。
 * @returns 会话恢复完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleSelect(sessionId: string): Promise<void> {
  try {
    await store.openSession(sessionId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '打开会话失败。')
  }
}

/**
 * 新建会话：清空当前时间线，等待首条消息。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleCreate(): void {
  store.dispose()
}

/**
 * 重命名会话（v17 S1）。
 *
 * 只改展示标题，不影响任何任务状态与结果呈现（S4）；成功后刷新列表让新标题上屏。
 *
 * @param sessionId 会话 ID。
 * @param title 新标题（已由调用方 trim 与校验）。
 * @returns 请求完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleRename(sessionId: string, title: string): Promise<void> {
  try {
    await renameAgentSession(sessionId, title)
    await refreshSessions()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重命名会话失败。')
  }
}

/**
 * 删除会话（v17 S2）。
 *
 * **只删对话记录**：不影响任何用例、产物与报告（S2）。二次确认由 `SessionList`
 * 承担，因此本处理器只在用户已确认后执行。
 *
 * @param sessionId 会话 ID。
 * @returns 请求完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleRemove(sessionId: string): Promise<void> {
  try {
    const result = await deleteAgentSession(sessionId)
    // 删除的是当前打开的会话：清掉面板，避免停留在「已消失的会话」上。
    if (store.sessionId === result.sessionId) {
      store.dispose()
    }
    await refreshSessions()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '删除会话失败。')
  }
}
</script>

<template>
  <div class="agent-work-page">
    <aside class="work-sidebar">
      <SessionList
        :sessions="store.sessions"
        :active-session-id="store.sessionId"
        :loading="sessionsLoading"
        @select="handleSelect"
        @create="handleCreate"
        @rename="handleRename"
        @remove="handleRemove"
      />
    </aside>

    <AgentWorkPanel class="work-main" interactive />
  </div>
</template>

<style scoped>
.agent-work-page {
  display: flex;
  /* 撑满视口剩余空间（工作台页头 64px），使侧栏 / 时间线 / 输入区内部自滚动 */
  height: calc(100vh - 64px);
  height: calc(100dvh - 64px);
  background: var(--color-surface);
}
.work-sidebar {
  width: 260px;
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
}
.work-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
@media (max-width: 760px) {
  .work-sidebar {
    width: 224px;
  }
}
</style>
