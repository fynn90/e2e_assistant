<!--
  工作台动作卡片（v16，PRD ID-6/ID-7）：对话流中承载用户可点击入口的卡片。

  典型场景：未找到用例时给「创建 e2e SKILL」、缺 SKILL.md 时给「生成 SKILL.md」、
  缺脚本时给「生成 Playwright 脚本」、产物齐备时给「执行测试」。

  交互语义（状态定格）：
    - pending  → 按钮可点，点击后由父级调用动作接口；
    - consumed → 已点击并受理，按钮置灰（卡片保留为历史痕迹）；
    - expired  → 已失效（如会话重启后动作登记丢失），按钮置灰并提示原因。

  为什么点击不产生新的对话轮次：动作卡片是**平台入口**而非对话内容，
  点击直接调动作接口并复用同一会话的时间线（PRD §3「动作卡片」定义）。

  v17 追加一条：目标用例已被删除时（`skillMissing`，L2d）标注「用例已删除」
  并禁用按钮——删除侧不回写历史，标注由服务端在读取块时统一给出。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import type { IWorkbenchActionTimelineItem } from '../timeline'

const props = defineProps<{
  /** 动作卡片项。 */
  item: IWorkbenchActionTimelineItem
  /** 点击处理中（禁用按钮、展示 loading）。 */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** 用户点击卡片上的动作按钮。 */
  trigger: [item: IWorkbenchActionTimelineItem]
}>()

/** 目标用例是否已被删除（v17 L2d：禁用入口并标注）。 */
const skillMissing = computed(() => props.item.skillMissing === true)

/** 是否可点击：仅 pending、不在处理中、且目标用例仍存在。 */
const clickable = computed(
  () => props.item.state === 'pending' && !props.busy && !skillMissing.value,
)

/** 状态徽标文案（非 pending 时展示，说明为何不可再点）。 */
const stateBadge = computed(() => {
  if (skillMissing.value) return '用例已删除'
  switch (props.item.state) {
    case 'consumed':
      return '已执行'
    case 'expired':
      return '已失效'
    default:
      return ''
  }
})

/**
 * 触发动作：仅可点击时向上抛出。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleClick(): void {
  if (!clickable.value) return
  emit('trigger', props.item)
}
</script>

<template>
  <section class="workbench-action" aria-label="操作入口">
    <div class="action-main">
      <div class="action-text">
        <span class="action-title">{{ item.label }}</span>
        <span v-if="item.skillTitle" class="action-skill">
          目标用例：{{ item.skillTitle }}
        </span>
        <span v-if="item.description" class="action-desc">
          {{ item.description }}
        </span>
      </div>
      <div class="action-controls">
        <n-tag v-if="stateBadge" size="tiny" :bordered="false">
          {{ stateBadge }}
        </n-tag>
        <n-button
          type="primary"
          size="small"
          :disabled="!clickable"
          :loading="Boolean(busy)"
          @click="handleClick"
        >
          {{ item.label }}
        </n-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.workbench-action {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  padding: 12px 16px;
}

.action-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  min-width: 0;
}

.action-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.action-title {
  color: var(--color-ink-deep);
  font-size: 13.5px;
  font-weight: 600;
}

.action-skill {
  color: var(--color-ink-body);
  font-size: 12px;
}

.action-desc {
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
}

.action-controls {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-shrink: 0;
}
</style>
