<!-- 提示条：警告（黄色）与错误（红色）的内联展示。 -->
<script setup lang="ts">
import IconFont from '../../../common/icon/IconFont.vue'
import { noticeLevelIcon } from '../icons'
import type { INoticeTimelineItem } from '../timeline'

defineProps<{
  /** 提示块时间线项。 */
  item: INoticeTimelineItem
}>()
</script>

<template>
  <div class="notice-item" :class="item.level">
    <IconFont
      class="notice-icon"
      :name="noticeLevelIcon(item.level)"
      :size="14"
    />
    <span class="notice-message">{{ item.message }}</span>
  </div>
</template>

<style scoped>
.notice-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
}
.notice-item.warning {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}
.notice-item.error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
}
/* 不声明 color：继承 .notice-item.warning / .error 的文字色，观感随级别自动区分；
   行高与 .notice-item 对齐，使图标与首行文字基线一致 */
.notice-icon {
  flex-shrink: 0;
  line-height: 1.6;
}
</style>
