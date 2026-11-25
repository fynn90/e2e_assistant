<!--
  用例详情卡（v17，PRD Q4/Q5）。

  两条与产品口径直接相关的取舍：
    1. **env 只列 key**（Q4 + D7）：值结构性禁止出现在卡片里（Agent 也读不到），
       因此这里只渲染 key 清单，缺失的高亮标注；
    2. **文档原文默认折叠**（Q5）：整篇贴进对话篇幅长、可读性差，用户明确
       要求看时才展开。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { useRouter } from 'vue-router'
import { readSkillDetailPayload } from '../workbench-view-payloads'
import { createSkillDevelopmentDefaultLocation } from '../../../router/skill-development-navigation'

const props = defineProps<{
  /** 详情卡载荷（原始 `Record`，本组件内一次窄化）。 */
  payload: Record<string, unknown>
}>()

const router = useRouter()
const data = computed(() => readSkillDetailPayload(props.payload))

/** 文档原文是否展开（Q5：默认收起）。 */
const documentExpanded = ref(false)

/**
 * 在 Skill 开发页打开该用例（Q4 的「在开发页打开」入口；C2 允许的唯一跳转之一）。
 * @returns 无返回值。
 * @throws 不抛出异常（路由失败由 Vue Router 处理）。
 */
function openInDevelopmentPage(): void {
  if (!data.value.skillId) return
  void router.push(createSkillDevelopmentDefaultLocation(data.value.skillId))
}

/**
 * 判断某个 env key 是否缺失。
 * @param key - 环境变量名。
 * @returns 在 missingEnvKeys 中时返回 true。
 * @throws 不抛出异常。
 */
function isMissing(key: string): boolean {
  return data.value.missingEnvKeys.includes(key)
}
</script>

<template>
  <div class="skill-detail">
    <div class="section">
      <span class="name">{{ data.title || '未命名用例' }}</span>
      <p v-if="data.description" class="desc">{{ data.description }}</p>
      <div class="tag-row">
        <n-tag
          size="tiny"
          :type="data.hasSkillDocument ? 'success' : 'warning'"
          :bordered="false"
        >
          {{ data.hasSkillDocument ? '已有文档' : '缺文档' }}
        </n-tag>
        <n-tag
          size="tiny"
          :type="data.hasPlaywrightScript ? 'success' : 'warning'"
          :bordered="false"
        >
          {{ data.hasPlaywrightScript ? '已有脚本' : '缺脚本' }}
        </n-tag>
        <n-tag
          v-for="tag in data.tags ?? []"
          :key="tag"
          size="tiny"
          :bordered="false"
        >
          {{ tag }}
        </n-tag>
      </div>
      <p v-if="data.baseUrl" class="meta">目标地址：{{ data.baseUrl }}</p>
    </div>

    <div v-if="data.preconditions.length > 0" class="section">
      <span class="section-title">前置条件</span>
      <ul class="plain-list">
        <li v-for="item in data.preconditions" :key="item.id">
          {{ item.description }}
        </li>
      </ul>
    </div>

    <div class="section">
      <span class="section-title">步骤（{{ data.steps.length }} 步）</span>
      <table class="step-table">
        <thead>
          <tr>
            <th class="col-order">序号</th>
            <th>描述</th>
            <th>操作</th>
            <th>预期</th>
            <th class="col-state">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="step in data.steps"
            :key="step.id"
            :class="{ disabled: !step.enabled }"
          >
            <td class="col-order">{{ step.order }}</td>
            <td>{{ step.description }}</td>
            <td>{{ step.action }}</td>
            <td>{{ step.expectedResult }}</td>
            <td class="col-state">{{ step.enabled ? '启用' : '停用' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- env 只列 key（Q4/D7）：值永不进入卡片，缺失的高亮 -->
    <div class="section">
      <span class="section-title">环境变量（只列名称）</span>
      <p v-if="data.envKeys.length === 0" class="meta">
        该用例没有引用环境变量。
      </p>
      <div v-else class="env-row">
        <n-tag
          v-for="key in data.envKeys"
          :key="key"
          size="small"
          :type="isMissing(key) ? 'error' : 'default'"
          :bordered="false"
        >
          {{ key }}{{ isMissing(key) ? '（缺失）' : '' }}
        </n-tag>
      </div>
      <p v-if="data.missingEnvKeys.length > 0" class="meta warn">
        缺失的值需要在环境变量补齐卡片里由你填写（值不会进入对话与日志）。
      </p>
    </div>

    <!-- 文档原文：默认收起（Q5） -->
    <div v-if="data.documentContent" class="section">
      <n-button
        size="tiny"
        quaternary
        @click="documentExpanded = !documentExpanded"
      >
        {{ documentExpanded ? '收起文档原文' : '查看文档原文' }}
      </n-button>
      <pre v-if="documentExpanded" class="document">{{
        data.documentContent
      }}</pre>
    </div>

    <div class="actions">
      <n-button
        size="small"
        type="primary"
        secondary
        :disabled="!data.skillId"
        @click="openInDevelopmentPage"
      >
        在开发页打开
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.skill-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
  min-width: 0;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.section-title {
  color: var(--color-ink-deep);
  font-size: 12px;
  font-weight: 600;
}

.name {
  color: var(--color-ink-deep);
  font-size: 13.5px;
  font-weight: 600;
}

.desc {
  margin: 0;
  color: var(--color-ink-body);
  font-size: 12.5px;
  line-height: 1.6;
}

.tag-row,
.env-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.meta {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 12px;
}

.meta.warn {
  color: #b45309;
}

.plain-list {
  margin: 0;
  padding-left: 18px;
  color: var(--color-ink-body);
  font-size: 12.5px;
  line-height: 1.6;
}

/* 步骤表：卡内横向滚动，避免宽表把时间线撑破 */
.step-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.step-table th,
.step-table td {
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  text-align: left;
  vertical-align: top;
}

.step-table th {
  color: var(--color-ink-deep);
  background: var(--color-well);
  font-weight: 600;
}

.step-table td {
  color: var(--color-ink-body);
}

.step-table tr.disabled td {
  color: var(--color-ink-muted);
}

.col-order {
  width: 48px;
}

.col-state {
  width: 56px;
}

.document {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-well);
  color: var(--color-ink-body);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
</style>
