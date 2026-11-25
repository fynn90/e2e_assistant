<!-- 命令执行块：终端样式窗口——命令 + 滚动输出（stderr 红色）+ 退出码底栏。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ICommandTimelineItem } from '../timeline'

const props = defineProps<{
  /** 命令执行块时间线项。 */
  item: ICommandTimelineItem
}>()

const outputRef = ref<HTMLElement | null>(null)
/** 用户上翻时暂停自动滚动。 */
const stickToBottom = ref(true)

const running = computed(() => props.item.status === 'streaming')
const failed = computed(
  () =>
    props.item.status === 'failed' ||
    (props.item.exitCode !== undefined && props.item.exitCode !== 0),
)

const footerText = computed(() => {
  if (running.value) return '执行中…'
  const duration = ((props.item.durationMs ?? 0) / 1000).toFixed(1)
  return `退出码 ${props.item.exitCode ?? '?'} · 耗时 ${duration}s`
})

// 输出增长时自动滚到底（用户未上翻时）。
watch(
  () => props.item.stdout + props.item.stderr,
  async () => {
    if (!stickToBottom.value) return
    await nextTick()
    const el = outputRef.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

/** 监听输出区滚动：用户上翻即暂停自动滚动，回到底部恢复。 */
function onOutputScroll(): void {
  const el = outputRef.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}
</script>

<template>
  <div class="command-block" :class="{ failed }">
    <div class="command-line">
      <span class="prompt">$</span>
      <span class="command-text">{{ item.command }}</span>
    </div>
    <div v-if="item.cwd" class="command-cwd">{{ item.cwd }}</div>
    <div ref="outputRef" class="command-output" @scroll="onOutputScroll">
      <pre v-if="item.stdout" class="stdout">{{ item.stdout }}</pre>
      <pre v-if="item.stderr" class="stderr">{{ item.stderr }}</pre>
    </div>
    <div class="command-footer" :class="{ failed, running }">
      {{ footerText }}
    </div>
  </div>
</template>

<style scoped>
.command-block {
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  overflow: hidden;
  font-family: Consolas, Menlo, monospace;
  font-size: 12.5px;
}
.command-block.failed {
  outline: 1px solid #7f1d1d;
}
.command-line {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #1e293b;
}
.prompt {
  color: #4ade80;
  font-weight: 700;
}
.command-text {
  word-break: break-all;
}
.command-cwd {
  padding: 2px 12px;
  color: #64748b;
  font-size: 11.5px;
}
.command-output {
  max-height: 280px;
  overflow-y: auto;
  padding: 8px 12px;
}
.command-output pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
}
.stderr {
  color: #f87171;
}
.command-footer {
  padding: 4px 12px;
  border-top: 1px solid #1e293b;
  color: #94a3b8;
  font-size: 11.5px;
}
.command-footer.failed {
  color: #f87171;
}
.command-footer.running {
  color: #60a5fa;
}
</style>
