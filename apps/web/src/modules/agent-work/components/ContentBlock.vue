<!-- 内容输出块：按 contentType 分发渲染器（markdown / code / uml / text）。 -->
<script setup lang="ts">
import { computed } from 'vue'
import MarkdownPreview from '../../../common/markdown/MarkdownPreview.vue'
import ReadOnlyCodeBlock from '../../../common/code/ReadOnlyCodeBlock.vue'
import type { IContentTimelineItem } from '../timeline'

const props = defineProps<{
  /** 内容输出块时间线项。 */
  item: IContentTimelineItem
}>()

/** 代码 / UML 源的展示语言标签。 */
const languageLabel = computed(
  () => props.item.language ?? props.item.contentType,
)

/*
  模板的承重约束：**除根元素外不得写任何注释**。

  注释在模板中同样算根节点，会让组件变成多根（fragment）；Vue 对多根组件
  **不做属性透传**，父级传入的 `class` 会被静默丢弃，scoped 样式随之失效。
  本文件曾因此踩坑。反过来，根元素上的 `streaming` 类是流式光标的挂载点，
  一旦透传被破坏，光标也会一起失效。注释一律写在 script 中。
*/
</script>

<template>
  <div
    class="content-block"
    :class="{ streaming: item.status === 'streaming' }"
  >
    <!--
      markdown：安全渲染（消毒）后的富文本。
      `syntax-highlight` 只在此消费方开启——Agent 输出的 markdown 常裹着脚本
      与 JSON，围栏代码块需要语法高亮；文档预览等场景维持默认无高亮。
    -->
    <MarkdownPreview
      v-if="item.contentType === 'markdown'"
      :content="item.text"
      syntax-highlight
    />

    <!-- code / uml：等宽源码展示（uml 图形渲染为 P1 增强，先保证源码可见） -->
    <div
      v-else-if="item.contentType === 'code' || item.contentType === 'uml'"
      class="code-wrap"
    >
      <div class="code-header">{{ languageLabel }}</div>
      <ReadOnlyCodeBlock :code="item.text" :language="item.language" />
    </div>

    <!-- text / html（html 沙箱渲染为 P2 预留，先按纯文本展示） -->
    <p v-else class="plain-text">{{ item.text }}</p>
  </div>
</template>

<style scoped>
.content-block {
  font-size: 14px;
  line-height: 1.75;
  color: var(--color-ink-deep);
  word-break: break-word;
}
.code-wrap {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
}
.code-header {
  padding: 6px 12px;
  background: var(--color-well);
  font-size: 12px;
  font-weight: 500;
  color: var(--color-ink-muted);
  border-bottom: 1px solid var(--color-border);
}
.plain-text {
  margin: 0;
  white-space: pre-wrap;
}

/*
  流式光标：内容未结束时闪烁的方块，告诉用户「后面还会继续追加」。

  **必须是承载文本的最内层元素上的伪元素，不能是容器末尾的兄弟节点。**
  三种分支的根（markdown 的 `<article>`、code 的 `<pre>`、text 的 `<p>`）都是
  块级元素，块级元素独占一行；行内光标作为它们的兄弟会被挤到下一行、单独成行，
  看起来像一个跑偏的空输入框。挂在文本元素末尾才能紧跟最后一个字。

  三种分支各自落到最内层，不能统一用容器的 `> :last-child`：
  - markdown：富文本由 `<MarkdownPreview>` 渲染成一段 HTML，光标要落到
    **它内部的**最后一个块级子元素（`<p>` / `<li>` / `<h2>` …）里，落在
    `<article>` 上仍会被它内部的块级子元素挤到下一行；
  - code / uml：落在 `<code>` 里，`<pre>` 的空白与换行原样保留；
  - text / html：段落本身就是文本容器。

  markdown 与 code 两处走 `:deep()`：它们的根/内层元素由子组件
  （`MarkdownPreview`、`ReadOnlyCodeBlock`）渲染，带的是子组件的作用域标记。
  高亮引入的 `<span>` 是行内元素，光标落在 `<code>` 上仍紧跟最后一个字符。
*/
.content-block.streaming :deep(.markdown-preview > :last-child)::after,
.content-block.streaming :deep(.readonly-code > code)::after,
.content-block.streaming .plain-text::after {
  content: '▍';
  margin-left: 1px;
  color: var(--color-action);
  animation: blink 1s steps(2) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
