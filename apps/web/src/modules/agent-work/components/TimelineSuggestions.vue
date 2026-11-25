<!--
  空态建议问题（v17，PRD H1）：会话无任何内容时展示 3–4 个可点击的示例。

  三条约束：
    1. 建议问题**由服务端按工作区现状生成**（有失败提示看失败、缺产物提示盘点
       缺口），前端不写死——写死的话它就只是无关痛痒的样板话；
    2. 点击即作为用户消息发送（由父级走既有发送路径）；
    3. **加载失败不展示 chips、保持原欢迎语**：C9 的反面是「空态变成错误页」，
       这里明确不把失败暴露成错误提示。
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getAgentSuggestions } from '../../../services/agent-work-api'

const emit = defineEmits<{
  /** 用户点击了一条建议问题（内容作为用户消息发送）。 */
  pick: [text: string]
}>()

/** 建议问题；为空时不渲染任何东西（含加载失败）。 */
const suggestions = ref<string[]>([])

onMounted(() => void load())

/**
 * 加载建议问题（失败静默：保持欢迎语，不把空态变成错误页）。
 * @returns 加载完成后兑现的 Promise。
 * @throws 不抛出异常。
 */
async function load(): Promise<void> {
  try {
    const list = await getAgentSuggestions()
    // 服务端可能返回空数组（工作区不可读等退化为通用示例由服务端负责）；
    // 这里只挡非法形状，避免渲染空按钮。
    suggestions.value = Array.isArray(list)
      ? list.filter((item) => typeof item === 'string' && item.length > 0)
      : []
  } catch {
    suggestions.value = []
  }
}
</script>

<template>
  <div v-if="suggestions.length > 0" class="suggestions">
    <button
      v-for="text in suggestions"
      :key="text"
      type="button"
      class="chip"
      @click="emit('pick', text)"
    >
      {{ text }}
    </button>
  </div>
</template>

<style scoped>
.suggestions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
  max-width: 460px;
}

.chip {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-surface);
  color: var(--color-ink-body);
  font-size: 12.5px;
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-out);
}

.chip:hover {
  background: var(--color-well);
}
</style>
