<!-- Agent 状态条：展示当前活动状态、事件流连接状态与中止操作。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NSpin, NTag } from 'naive-ui'
import type { TAgentActivity } from '@charlie_deng/e2e-assistant-types'
import type { TWorkConnection } from '../timeline'

const props = withDefaults(
  defineProps<{
    /** Agent 当前活动状态。 */
    activity: TAgentActivity
    /** 状态条文案（如「打开网页 https://baidu.com」）。 */
    label?: string
    /** 事件流连接状态。 */
    connection: TWorkConnection
    /**
     * 是否展示内置「中止」按钮。
     *
     * 生成弹窗自带「停止 Agent」按钮并需承载不可取消阶段语义，
     * 因此传 false 避免出现两个语义相近的中止入口。
     */
    showAbort?: boolean
  }>(),
  { showAbort: true },
)

const emit = defineEmits<{
  /** 用户点击中止按钮。 */
  abort: []
}>()

/** 活动状态 → 展示文案。 */
const activityText = computed(() => {
  if (props.label) return props.label
  const texts: Record<TAgentActivity, string> = {
    idle: '空闲',
    thinking: '思考中…',
    writing: '输出内容…',
    tool_running: '执行工具…',
    command_running: '执行命令…',
    waiting_user: '等待你的确认',
  }
  return texts[props.activity]
})

/** 连接状态 → 徽标类型与文案。 */
const connectionMeta = computed(() => {
  const metas = {
    connecting: { type: 'warning' as const, text: '连接中' },
    live: { type: 'success' as const, text: '实时' },
    reconnecting: { type: 'warning' as const, text: '重连中' },
    offline: { type: 'default' as const, text: '离线' },
  }
  return metas[props.connection]
})

const busy = computed(() => props.activity !== 'idle')
</script>

<template>
  <div class="status-bar">
    <div class="status-left">
      <n-spin v-if="busy" :size="14" class="status-spin" />
      <span
        class="status-activity"
        :class="{ waiting: activity === 'waiting_user' }"
      >
        {{ activityText }}
      </span>
    </div>
    <div class="status-right">
      <n-button
        v-if="busy && props.showAbort"
        size="tiny"
        secondary
        type="error"
        @click="emit('abort')"
      >
        中止
      </n-button>
      <n-tag size="small" :type="connectionMeta.type" round>{{
        connectionMeta.text
      }}</n-tag>
    </div>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px var(--space-page);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-well);
  font-size: 13px;
}
.status-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.status-activity {
  color: var(--color-ink-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-activity.waiting {
  color: #d97706;
  font-weight: 600;
}
.status-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
