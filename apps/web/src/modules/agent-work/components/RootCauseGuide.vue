<!--
  原因与下一步指引（v16）：执行卡片与产物卡片共用的一小块展示。

  为什么抽成组件而不是各写一份：执行失败、生成失败、产物缺缺口三种场景
  要展示的都是「一句结论 + 若干条可操作建议」，措辞与结构的重复度高；
  抽成组件后各卡片只负责给出数据，不重复排版。
-->
<script setup lang="ts">
import { NAlert } from 'naive-ui'

defineProps<{
  /** 一句话结论（失败原因 / 缺口说明）。 */
  message: string
  /** 建议动作（逐条展示，可为空）。 */
  suggestions?: readonly string[]
}>()
</script>

<template>
  <n-alert type="warning" :show-icon="false" class="root-cause-guide">
    <p class="guide-message">{{ message }}</p>
    <ul v-if="suggestions && suggestions.length > 0" class="guide-list">
      <li v-for="(suggestion, index) in suggestions" :key="index">
        {{ suggestion }}
      </li>
    </ul>
  </n-alert>
</template>

<style scoped>
.root-cause-guide {
  margin: 0;
}

.guide-message {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
}

.guide-list {
  margin: 6px 0 0;
  padding-inline-start: 18px;
  font-size: 12px;
  line-height: 1.6;
}
</style>
