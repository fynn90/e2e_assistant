<!-- 轮次分隔：一轮对话的开始标记（用户输入预览）与结束状态（结局 / 用量）。 -->
<script setup lang="ts">
import { computed } from 'vue'
import IconFont from '../../../common/icon/IconFont.vue'
import { TURN_AVATAR_ICON } from '../icons'
import type { ITurnTimelineItem } from '../timeline'

const props = defineProps<{
  /** 轮次块时间线项。 */
  item: ITurnTimelineItem
}>()

/** 轮次结局 → 展示文案与样式。 */
const outcomeMeta = computed(() => {
  switch (props.item.outcome) {
    case 'succeeded':
      return { text: '已完成', className: 'ok' }
    case 'failed':
      return { text: '失败', className: 'failed' }
    case 'aborted':
      return { text: '已中止', className: 'aborted' }
    default:
      return { text: '进行中…', className: 'running' }
  }
})

const usageText = computed(() => {
  const usage = props.item.usage
  if (
    !usage ||
    (usage.inputTokens === undefined && usage.outputTokens === undefined)
  )
    return ''
  return `tokens ↑${usage.inputTokens ?? '?'} ↓${usage.outputTokens ?? '?'}`
})
</script>

<template>
  <div class="turn-divider">
    <div class="turn-user">
      <IconFont class="turn-avatar" :name="TURN_AVATAR_ICON" :size="16" />
      <span class="turn-user-text">{{
        item.inputPreview ?? '（继续上轮）'
      }}</span>
    </div>
    <div class="turn-outcome" :class="outcomeMeta.className">
      {{ outcomeMeta.text }}
      <span v-if="item.errorMessage" class="turn-error"
        >：{{ item.errorMessage }}</span
      >
      <span v-if="usageText" class="turn-usage">{{ usageText }}</span>
    </div>
  </div>
</template>

<style scoped>
.turn-divider {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  /*
    左内边距 13px = 卡片的 1px 边框 + 12px 内边距。
    思考块 / 工具块的图标正好落在 13px 处，轮次头像取同一值即可与它们成一条竖线。
  */
  padding: 14px 14px 6px 13px;
  border-top: 1px solid var(--color-border);
  margin-top: 12px;
}
.turn-divider:first-child {
  border-top: none;
  margin-top: 0;
}
.turn-user {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: 78%;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--color-ink-deep);
}
/*
  轮次头像框：浅蓝圆角底 + 品牌蓝图标，标记「这一轮由用户发起」。

  尺寸从 28px 收到 21px，是为了与时间线其余图标对齐：图标字形在框内居中，
  框越宽则字形离框左越远，偏差约为 (框宽 − 17) / 2。原先 28px 框让字形右出
  6.5px，与思考块 / 工具块的图标明显不在一条竖线上；收到 21px 后实测偏差
  降至 2px 以内（相对思考块 2px、工具块 1.75px），观感上已成一列，同时框内
  仍保留 3.5px 留白，底色不至被图标填满。

  改造前是手写 SVG，改用字体图标后不再是 flex 容器——图标字形以 line-height
  参与行内排版，靠 text-align 与 line-height 即可居中，无需再包一层对齐。
  字号走 IconFont 的 size prop；此处保留背景与颜色，它们是头像框的视觉本体。
*/
.turn-avatar {
  flex-shrink: 0;
  /* inline-block 才能让 width/height 生效（原为 inline-flex，仅用于对齐内部 SVG） */
  display: inline-block;
  width: 21px;
  height: 21px;
  border-radius: 6px;
  background: rgb(59 130 246 / 12%);
  color: #2563eb;
  /* 字号由 IconFont 的 size 内联提供；行高撑满头像框即可让字形垂直居中 */
  line-height: 21px;
  text-align: center;
}
.turn-user-text {
  white-space: pre-wrap;
  word-break: break-word;
}
.turn-outcome {
  flex-shrink: 0;
  margin-top: 0;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-ink-muted);
}
.turn-outcome.ok {
  color: #059669;
}
.turn-outcome.failed {
  color: #dc2626;
}
.turn-outcome.aborted {
  color: #d97706;
}
.turn-error {
  margin-left: 4px;
  color: inherit;
}
.turn-usage {
  margin-left: 8px;
  font-weight: 400;
  color: #c4c9d1;
}
</style>
