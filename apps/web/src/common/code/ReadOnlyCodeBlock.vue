<!--
  只读语法高亮代码块：Agent 时间线中代码 / UML 源码与 Markdown 围栏代码的展示组件。

  定位：**展示型**代码块，与 `CodeEditor`（Monaco 编辑器）互不替代——
  时间线里一段代码不值得拉起约 4MB 的编辑器 chunk，且编辑器天然可编辑，
  与「只读展示」的语义不符。这里输出静态 HTML，用户无法编辑或选中修改。

  内容经 `highlightCode` 处理：仅含转义文本与 hljs 的 span，可安全 `v-html`。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { highlightCode } from './highlight'

const props = defineProps<{
  /** 源码原文。 */
  code: string
  /** 语言名或别名（如 typescript / ts / json）；缺省或未注册时无色展示。 */
  language?: string
}>()

/** 高亮后的 HTML：源码变化时自动重算（流式追加会频繁触发，`highlightCode` 开销可控）。 */
const highlightedHtml = computed(() =>
  highlightCode(props.code, props.language),
)
</script>

<template>
  <pre class="readonly-code"><code v-html="highlightedHtml" /></pre>
</template>

<style scoped>
/*
  底色与内边距在此定义，token 颜色由 hljs-theme.css 提供（该主题刻意不写容器样式）。
  配色对齐工程既有代码块（ContentBlock 原 .code-body、CodeEditor 外壳）。
*/
.readonly-code {
  margin: 0;
  padding: 12px;
  background: #0b1120;
  color: #e2e8f0;
  font-size: 12.5px;
  line-height: 1.6;
  overflow-x: auto;
}
.readonly-code code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre;
}
</style>
