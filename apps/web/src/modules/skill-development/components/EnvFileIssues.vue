<!-- env.json 编辑页的校验反馈区（v10 PRD 5.3）：blocked 态的专属呈现，展示「行:列 + 原因」并可点击定位。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { IEnvFileIssue } from '@charlie_deng/e2e-assistant-types'

const props = defineProps<{
  issues: IEnvFileIssue[]
}>()
const emit = defineEmits<{
  locate: [issue: IEnvFileIssue]
}>()

/** 每条问题的定位前缀：可定位时展示「第 N 行第 M 列」，否则回退到 key 名。 */
const locatedIssues = computed(() =>
  props.issues.map((issue) => ({
    issue,
    location:
      issue.line !== undefined
        ? `第 ${issue.line} 行${issue.column !== undefined ? `第 ${issue.column} 列` : ''}`
        : issue.key !== undefined
          ? `key "${issue.key}"`
          : '',
  })),
)

/**
 * 响应条目点击：通知父级把编辑器光标定位到错误位置。
 * @param issue 被点击的问题。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleClick(issue: IEnvFileIssue): void {
  if (issue.line !== undefined) {
    emit('locate', issue)
  }
}
</script>

<template>
  <div class="env-issues" role="alert" aria-label="env.json 校验反馈">
    <p class="env-issues-title">保存被阻止，请修正以下问题后重试：</p>
    <ul>
      <li
        v-for="{ issue, location } in locatedIssues"
        :key="`${issue.code}-${issue.key ?? ''}-${issue.line ?? ''}-${issue.message}`"
      >
        <button
          type="button"
          :disabled="issue.line === undefined"
          @click="handleClick(issue)"
        >
          <span v-if="location" class="issue-location">{{ location }}：</span
          >{{ issue.message }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.env-issues {
  flex: none;
  /* 底部 6px：与页面底部保持固定间距（v10 页面规格） */
  margin: var(--space-sm) var(--space-card) 6px;
  padding: var(--space-sm) var(--space-md);
  border: 1px solid #fecaca;
  border-radius: var(--radius-brand);
  background: #fef2f2;
  color: #b91c1c;
  font-size: 12px;
}

.env-issues-title {
  margin: 0 0 var(--space-xs);
  font-weight: 600;
}

.env-issues ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.env-issues li {
  margin-top: 2px;
}

.env-issues button {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: inherit;
  text-align: start;
  cursor: pointer;
}

.env-issues button:disabled {
  cursor: default;
}

.env-issues button:not(:disabled):hover {
  text-decoration: underline;
}

.issue-location {
  color: #7f1d1d;
  font-weight: 600;
}
</style>
