<!-- Markdown 安全预览组件：基于 markdown-it 渲染、DOMPurify 消毒，供各类文档预览场景复用。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { renderSafeMarkdown } from '../chat/markdown'
import { stripMarkdownFrontmatter } from './frontmatter'

const props = defineProps<{
  /** 待渲染的 markdown 源文本 */
  content: string
  /**
   * 是否对围栏代码块做语法高亮。
   *
   * 默认关闭：文档预览场景（SKILL.md 等）以正文排版为主，代码块偶发；
   * Agent 时间线的输出内容显式开启。
   */
  syntaxHighlight?: boolean
}>()

// 渲染并消毒后的 HTML：先剥离 YAML frontmatter，源文本变化时自动重新计算
const renderedHtml = computed(() =>
  renderSafeMarkdown(stripMarkdownFrontmatter(props.content), {
    syntaxHighlight: props.syntaxHighlight,
  }),
)
</script>

<template>
  <article class="markdown-preview" v-html="renderedHtml" />
</template>

<style scoped>
.markdown-preview {
  padding: 16px 20px;
  line-height: 1.72;
  overflow-wrap: anywhere;
}
.markdown-preview :deep(h1),
.markdown-preview :deep(h2),
.markdown-preview :deep(h3) {
  margin: 16px 0 8px;
}
.markdown-preview :deep(h1:first-child),
.markdown-preview :deep(h2:first-child),
.markdown-preview :deep(h3:first-child),
.markdown-preview :deep(p:first-child) {
  margin-top: 0;
}
.markdown-preview :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-preview :deep(a) {
  color: #2563eb;
  word-break: break-all;
}
.markdown-preview :deep(ul),
.markdown-preview :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}
.markdown-preview :deep(blockquote) {
  margin-inline: 0;
  padding-left: 12px;
  border-left: 3px solid #cbd5e1;
  color: #475569;
}
.markdown-preview :deep(hr) {
  border: 0;
  border-top: 1px solid #e2e8f0;
  margin: 16px 0;
}
.markdown-preview :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  background: #f1f5f9;
  overflow-wrap: anywhere;
}
.markdown-preview :deep(pre) {
  padding: 10px 12px;
  border-radius: 8px;
  background: #0b1120;
  color: #e2e8f0;
  overflow-x: auto;
}
.markdown-preview :deep(pre code) {
  padding: 0;
  background: transparent;
}
.markdown-preview :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.markdown-preview :deep(th),
.markdown-preview :deep(td) {
  padding: 7px 10px;
  border: 1px solid #e2e8f0;
  text-align: left;
}
</style>
