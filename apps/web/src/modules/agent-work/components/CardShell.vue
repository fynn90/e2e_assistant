<!--
  卡片通用外壳（PRD 6.1 / 6.2）：提供「卡片头 / 正文 / 分割线 / 操作区」的统一布局与视觉规格。

  各卡片不自带样式，全部复用本外壳，保证三类卡片（SKILL.md / 脚本 / 终止）视觉一致。

  ┌─────────────────────────────────────────────────┐
  │ 卡片头：产物名 + 状态徽标 + 保存状态徽标   [slot] │ ← 固定
  ├─────────────────────────────────────────────────┤
  │ 正文                                       [slot] │ ← 可滚动
  ├─────────────────────────────────────────────────┤ ← 1px 分割线
  │                              操作区         [slot] │ ← 固定，右对齐，小号
  └─────────────────────────────────────────────────┘
-->
<script setup lang="ts">
defineProps<{
  /** 产物名（`SKILL.md` / `test.spec.ts`）。 */
  fileName: string
}>()
</script>

<template>
  <article class="card-shell">
    <header class="card-shell__head">
      <div class="card-shell__title-group">
        <span class="card-shell__file-name">{{ fileName }}</span>
        <slot name="badges" />
      </div>
      <div class="card-shell__head-extra">
        <slot name="head-extra" />
      </div>
    </header>

    <div class="card-shell__body">
      <slot />
    </div>

    <!-- 操作区：按钮右对齐、小号（size="small"）；分割线贯穿卡片内部全宽（PRD 6.2） -->
    <footer class="card-shell__actions">
      <slot name="actions" />
    </footer>
  </article>
</template>

<style scoped>
.card-shell {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
}

.card-shell__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  flex: none;
  padding: 14px 16px;
}

.card-shell__title-group {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
}

.card-shell__file-name {
  color: var(--color-ink-deep);
  font-size: 14px;
  font-weight: 600;
}

.card-shell__head-extra {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-shrink: 0;
}

.card-shell__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  color: var(--color-ink-body);
  font-size: 13px;
  line-height: 1.6;
}

.card-shell__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
  flex: none;
  padding: 10px 16px;
  border-top: 1px solid var(--color-border);
}

/* 正文内的次要信息（版本元信息等） */
.card-shell__body :deep(.card-meta) {
  color: var(--color-ink-muted);
  font-size: 12px;
}

/* 正文内的标签组 */
.card-shell__body :deep(.card-tag-group) {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  margin: 8px 0;
}

/* 正文内的紧凑列表 */
.card-shell__body :deep(.card-list) {
  margin: 6px 0;
  padding-left: 20px;
}

/* 正文内的区块标题 */
.card-shell__body :deep(.card-section-title) {
  display: block;
  margin-bottom: 6px;
  color: var(--color-ink-deep);
  font-size: 12px;
  font-weight: 600;
}

/* 正文中嵌入的代码编辑器：固定高度，避免撑破卡片 */
.card-shell__body :deep(.code-editor-shell) {
  flex: none;
  height: 320px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
}
</style>
