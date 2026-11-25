<!-- 工具调用块：图标化的动作卡片，按 action 选图标，状态徽标展示进度。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { NSpin } from 'naive-ui'
import IconFont from '../../../common/icon/IconFont.vue'
import { toolActionIcon } from '../icons'
import type { IToolTimelineItem } from '../timeline'

const props = defineProps<{
  /** 工具调用块时间线项。 */
  item: IToolTimelineItem
}>()

const expanded = ref(false)

/**
 * 截图加载失败标记。
 *
 * 探查截图存放在 Skill 的 temp/ 之下，任务终态随整个 temp/ 一并删除，
 * 因此**任务结束后的历史会话里图片必然失效**——这是既定行为，不是异常。
 * 失败时降级为文字占位，不让一个坏掉的图片链接破坏整条时间线的观感。
 */
const imageFailed = ref(false)

/** 工具动作对应的图标字形名（映射表见 ../icons）。 */
const iconName = computed(() => toolActionIcon(props.item.action))
const running = computed(() => props.item.status === 'streaming')
const failed = computed(() => props.item.status === 'failed')

/** 状态行：成功摘要 / 失败提示 / 执行中。 */
const statusText = computed(() => {
  if (running.value) return props.item.text || '执行中…'
  if (failed.value) return props.item.summary ?? '执行失败'
  return props.item.summary ?? '完成'
})

const durationText = computed(() =>
  props.item.durationMs === undefined
    ? ''
    : `${(props.item.durationMs / 1000).toFixed(1)}s`,
)
</script>

<template>
  <div class="tool-block" :class="{ running, failed }">
    <button class="tool-header" type="button" @click="expanded = !expanded">
      <IconFont class="tool-icon" :name="iconName" :size="15" />
      <span class="tool-title">{{ item.title }}</span>
      <span v-if="item.subtitle" class="tool-subtitle">{{
        item.subtitle
      }}</span>
      <span class="tool-status">
        <n-spin v-if="running" :size="12" />
        <span v-else-if="failed" class="mark failed-mark" aria-label="失败"
          >✗</span
        >
        <span v-else class="mark ok-mark" aria-label="成功">✓</span>
      </span>
      <span v-if="durationText" class="tool-duration">{{ durationText }}</span>
    </button>
    <div v-if="expanded" class="tool-detail">
      <div class="tool-status-line" :class="{ failed }">{{ statusText }}</div>
      <div class="tool-name">工具：{{ item.toolName }}</div>

      <!-- 截图缩略图（v12-pre）：让用户看到 Agent 核对时实际看到的页面。
           图片本体在 Skill 的 temp/ 下，任务结束后已随临时工作区删除，故历史会话中通常为占位。 -->
      <figure v-if="item.image" class="tool-image">
        <img
          v-if="!imageFailed"
          :src="item.image.url"
          :alt="`${item.title}截图`"
          :width="item.image.width"
          :height="item.image.height"
          loading="lazy"
          @error="imageFailed = true"
        />
        <div v-else class="tool-image-missing">
          截图仅在生成过程中可见，任务结束后已随临时文件清理
        </div>
        <figcaption>{{ item.image.width }}×{{ item.image.height }}</figcaption>
      </figure>
    </div>
  </div>
</template>

<style scoped>
.tool-block {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface);
  overflow: hidden;
  transition: border-color var(--motion-fast) var(--ease-out);
}
.tool-block.running {
  border-color: #bfdbfe;
  background: #eff6ff;
}
.tool-block.failed {
  border-color: #fecaca;
  background: #fef2f2;
}
.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  color: var(--color-ink-deep);
}
.tool-header:hover {
  background: rgb(0 0 0 / 2%);
}
/* 图标随标题排版；颜色统一为中性墨色，与时间线其余图标成一套（字号走 size prop） */
.tool-icon {
  flex-shrink: 0;
  color: var(--color-ink-muted);
}
.tool-title {
  font-weight: 600;
  flex-shrink: 0;
}
.tool-subtitle {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-ink-muted);
  font-size: 12.5px;
}
.tool-status {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}
.mark {
  font-weight: 700;
  font-size: 13px;
}
.ok-mark {
  color: #059669;
}
.failed-mark {
  color: #dc2626;
}
.tool-duration {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--color-ink-muted);
}
.tool-detail {
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
  font-size: 12.5px;
  color: var(--color-ink-body);
}
.tool-status-line.failed {
  color: #dc2626;
}
.tool-name {
  margin-top: 4px;
  color: var(--color-ink-muted);
  font-size: 12px;
}
/* 截图缩略图：限高 + 可点开看大图，避免长图把时间线撑得极高 */
.tool-image {
  margin: 8px 0 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tool-image img {
  max-width: 100%;
  max-height: 260px;
  width: auto;
  height: auto;
  object-fit: contain;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: #fff;
  cursor: zoom-in;
}
.tool-image-missing {
  padding: 8px 10px;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  color: var(--color-ink-muted);
  font-size: 12px;
}
.tool-image figcaption {
  color: var(--color-ink-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
</style>
