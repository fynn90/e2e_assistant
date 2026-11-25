<!--
  执行前体检卡（v17，PRD R3）。

  修复入口与「全部通过时的执行」都走**与清单卡行内按钮同一套机制**：宿主在
  渲染体检卡时预先登记动作记录，把 `fixActionId` / `executeActionId` 随卡片
  下发；本组件只负责按这些 ID 渲染按钮并向上抛出，由面板层调动作接口
  （v16 的执行入口一律经 `runAgentWorkbenchAction`，凭空拼 actionId 去调会
  得到「动作不存在」的报错——那正是 C9 禁止的「点了没反应」）。
  **没有 ID 就不渲染按钮**：环境变量缺失、目标地址缺失这类修复要走提案通道，
  不在动作枚举里，由 Agent 依体检结果自行发起。

  逐项未通过时**必须给一句话原因**（R3 ②），否则用户只知道「不通过」却不知道
  该怎么办。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import type { TAgentWorkbenchAction } from '@fynn90-e2e_assistant/types'
import { readReadinessPayload } from '../workbench-view-payloads'

const props = defineProps<{
  /** 体检卡载荷（原始 `Record`，本组件内一次窄化）。 */
  payload: Record<string, unknown>
  /** 正在处理的动作 ID（禁用按钮，避免重复点击）。 */
  pendingActionId?: string
}>()

const emit = defineEmits<{
  /** 用户点击修复入口或「执行」（由面板层调动作接口）。 */
  inlineAction: [actionId: string]
}>()

const data = computed(() => readReadinessPayload(props.payload))

/** 未通过的检查项数量（标题上如实说明）。 */
const failedCount = computed(
  () => data.value.checks.filter((check) => !check.ok).length,
)

/**
 * 修复动作的按钮文案（与清单卡的行内文案同源）。
 *
 * @param action - 动作身份。
 * @returns 中文按钮文案。
 * @throws 不抛出异常。
 */
function fixActionLabel(action: TAgentWorkbenchAction): string {
  switch (action) {
    case 'generate-skill-document':
      return '生成 SKILL.md'
    case 'generate-playwright-script':
      return '生成脚本'
    case 'update-playwright-script':
      return '更新脚本'
    case 'execute-test':
      return '执行'
    default:
      return '处理'
  }
}

/**
 * 按钮是否可点。
 *
 * 判据是「**当前有一张卡片在途**」而不是「这张卡片自己在途」：在途期间
 * 整张体检卡的按钮都应禁用（否则用户能连点两个不同的修复入口）。
 *
 * @returns 没有在途动作时返回 true。
 * @throws 不抛出异常。
 */
function clickable(): boolean {
  return props.pendingActionId === undefined
}
</script>

<template>
  <div class="readiness">
    <p class="head-line">
      用例「{{ data.skillTitle || '未命名用例' }}」的执行就绪检查
    </p>

    <ul class="check-list">
      <li v-for="check in data.checks" :key="check.code" class="check-row">
        <span class="mark" :class="check.ok ? 'ok' : 'bad'">
          {{ check.ok ? '✓' : '✗' }}
        </span>
        <div class="check-text">
          <span class="label">{{ check.label }}</span>
          <span v-if="!check.ok && check.message" class="reason">
            {{ check.message }}
          </span>
        </div>
        <!-- 修复入口（Q6/E3 同构）：只有宿主登记过动作才有 ID -->
        <NButton
          v-if="!check.ok && check.fixActionId && check.fixAction"
          size="tiny"
          type="primary"
          secondary
          class="fix-button"
          :disabled="!clickable()"
          @click="emit('inlineAction', check.fixActionId)"
        >
          {{ fixActionLabel(check.fixAction) }}
        </NButton>
      </li>
    </ul>

    <p v-if="data.checks.length === 0" class="foot-note">
      这次体检没有返回检查项，可稍后重试或直接在清单卡里发起执行。
    </p>

    <!-- 全部通过时给「执行」按钮，闭环到执行（R3 ③） -->
    <p v-else-if="data.ok" class="foot-note pass">
      <span>全部通过，可以执行。</span>
      <NButton
        v-if="data.executeActionId"
        size="small"
        type="primary"
        class="run-button"
        :disabled="!clickable()"
        @click="emit('inlineAction', data.executeActionId)"
      >
        执行
      </NButton>
    </p>
    <p v-else class="foot-note">
      有 {{ failedCount }} 项未通过；修好后可以让 Agent 重新体检或直接发起执行。
    </p>
  </div>
</template>

<style scoped>
.readiness {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.head-line {
  margin: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-ink-body);
  font-size: 12.5px;
}

.check-list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}

.check-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 16px;
}

.mark {
  flex: 0 0 auto;
  font-size: 12.5px;
  line-height: 1.6;
}

.mark.ok {
  color: #15803d;
}

.mark.bad {
  color: #b91c1c;
  font-weight: 600;
}

.check-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.label {
  color: var(--color-ink-body);
  font-size: 12.5px;
}

.reason {
  color: var(--color-ink-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.foot-note {
  margin: 0;
  padding: 8px 16px;
  border-top: 1px solid var(--color-border);
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
}

.foot-note.pass {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #15803d;
}

/* 修复入口按钮靠行尾（与检查项文案拉开，避免误读成文案的一部分）。 */
.fix-button {
  flex: 0 0 auto;
  margin-left: auto;
}
</style>
