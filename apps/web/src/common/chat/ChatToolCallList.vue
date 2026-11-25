<!--
  Chat 中的工具调用步骤展示组件。

  本组件只接收服务端生成的 IToolCallView 安全投影，展示执行状态、耗时和可展开的参数/结果预览；
  不接受原始工具 details，避免将命令输出、文件内容或敏感字段直接暴露给浏览器。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'
import type { IToolCallView } from '@fynn90-e2e_assistant/types'

/**
 * 工具步骤组件属性。
 */
const props = defineProps<{
  /** 当前助手消息关联的安全工具调用列表。 */
  toolCalls: IToolCallView[]
}>()

/**
 * 按 Agent 记录的开始顺序排列工具调用，避免并行调用按完成时间跳动。
 */
const orderedToolCalls = computed(() =>
  [...props.toolCalls].sort((left, right) => left.sequence - right.sequence),
)

/**
 * 将工具状态转换为中文展示文案。
 *
 * @param status - 服务端工具调用状态。
 * @returns 用户可读状态文本。
 */
function statusLabel(status: IToolCallView['status']): string {
  if (status === 'running') return '执行中'
  return status === 'succeeded' ? '已完成' : '失败'
}

/**
 * 将工具状态转换为 Naive UI 标签颜色。
 *
 * @param status - 服务端工具调用状态。
 * @returns 标签颜色标识。
 */
function statusType(
  status: IToolCallView['status'],
): 'default' | 'success' | 'error' {
  if (status === 'running') return 'default'
  return status === 'succeeded' ? 'success' : 'error'
}

/**
 * 计算工具已完成或正在执行的耗时。
 *
 * @param tool - 一个安全工具调用投影。
 * @returns 毫秒级耗时的简短中文文本。
 */
function durationLabel(tool: IToolCallView): string {
  const end = tool.completedAt ?? Date.now()
  const duration = Math.max(0, end - tool.startedAt)
  return duration < 1_000
    ? `${duration} 毫秒`
    : `${(duration / 1_000).toFixed(1)} 秒`
}

/**
 * 稳定格式化安全预览值，供 details/pre 区块显示。
 *
 * @param value - 已由服务端脱敏、截断的 JSON 兼容值。
 * @returns 适合等宽区域展示的文本。
 */
function formatPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[预览无法序列化]'
  }
}
</script>

<template>
  <section
    v-if="orderedToolCalls.length"
    class="tool-calls"
    aria-label="Agent 工具调用"
  >
    <article
      v-for="tool in orderedToolCalls"
      :key="tool.toolCallId"
      class="tool-call"
    >
      <header class="tool-header">
        <div class="tool-heading">
          <strong>{{ tool.toolLabel || tool.toolName }}</strong>
          <span v-if="tool.toolLabel" class="tool-name">{{
            tool.toolName
          }}</span>
        </div>
        <div class="tool-state">
          <span>{{ durationLabel(tool) }}</span>
          <n-tag size="small" :type="statusType(tool.status)">
            {{ statusLabel(tool.status) }}
          </n-tag>
        </div>
      </header>

      <details class="tool-details">
        <summary>
          查看安全调用详情
          <span
            v-if="
              tool.argumentsTruncated ||
              tool.partialResultTruncated ||
              tool.resultTruncated
            "
          >
            （已脱敏或截断）
          </span>
        </summary>
        <div class="tool-preview">
          <strong>参数</strong>
          <pre>{{ formatPreview(tool.arguments) }}</pre>
        </div>
        <div v-if="tool.partialResult !== undefined" class="tool-preview">
          <strong>执行进度</strong>
          <pre>{{ formatPreview(tool.partialResult) }}</pre>
        </div>
        <div v-if="tool.result !== undefined" class="tool-preview">
          <strong>{{ tool.isError ? '错误结果' : '执行结果' }}</strong>
          <pre>{{ formatPreview(tool.result) }}</pre>
        </div>
      </details>
    </article>
  </section>
</template>

<style scoped>
.tool-calls {
  display: grid;
  gap: 8px;
  margin: 10px 0;
}

.tool-call {
  padding: 9px 10px;
  border: 1px solid #dbe4ef;
  border-radius: 10px;
  background: #f8fafc;
}

.tool-header,
.tool-heading,
.tool-state {
  display: flex;
  align-items: center;
}

.tool-header {
  justify-content: space-between;
  gap: 12px;
}

.tool-heading,
.tool-state {
  min-width: 0;
  gap: 7px;
}

.tool-heading strong,
.tool-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-name,
.tool-state {
  color: #64748b;
  font-size: 12px;
}

.tool-details {
  margin-top: 8px;
  color: #475569;
  font-size: 12px;
}

.tool-details summary {
  width: fit-content;
  cursor: pointer;
}

.tool-preview {
  margin-top: 8px;
}

.tool-preview strong {
  display: block;
  margin-bottom: 3px;
}

.tool-preview pre {
  max-height: 220px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  border-radius: 7px;
  background: #eaf0f7;
  color: #334155;
  font:
    11px/1.5 ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
