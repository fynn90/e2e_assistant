<!--
  执行任务卡片的过程区（v16，PRD RUN-6）。

  数据来源：执行 store（`stores/execution.ts`）——它与 Skill 开发页侧边栏
  用的是**同一份执行状态与同一条执行总线**（R2：日志与脱敏逐条等同），
  因此这里不重新实现事件消费，只把 store 中该执行的状态渲染出来。

  实时呈现分区（对齐 v11 执行区块）：状态条 + 日志流 + 步骤进度 + 结果行。
  结束后由父卡片展示统计摘要与报告入口；此处保留末态内容供回看。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { useExecutionStore } from '../../../stores/execution'

const props = defineProps<{
  /** 目标 Skill ID（store 的取数键）。 */
  skillId: string
  /** 执行 ID（校验 store 中的记录是否就是本次任务）。 */
  executionId: string
  /** 任务是否已结束（结束后不再自动滚底）。 */
  finished: boolean
}>()

const executionStore = useExecutionStore()

// 接管这次执行：执行由**服务端**发起，前端只拿到 executionId，
// 需要主动拉快照并订阅执行总线，才有逐条日志与步骤进度可展示
// （RUN-6/RUN-9：过程实时可见、刷新后恢复）。
// 重挂载（切换会话再回来）时同样走这条路径，因此过程能恢复。
watch(
  () => [props.skillId, props.executionId] as const,
  ([skillId, executionId]) => {
    if (skillId && executionId) {
      void executionStore.adopt(skillId, executionId)
    }
  },
  { immediate: true },
)

/** 本次任务对应的执行记录；不存在（历史会话且服务已重启）时为 undefined。 */
const record = computed(() => {
  const current = executionStore.records[props.skillId]
  if (!current) return undefined
  // 记录可能已被同一 Skill 的**下一次**执行覆盖：执行 ID 不符时按无记录处理，
  // 避免把另一次执行的过程显示在本卡片里（历史卡片尤其容易踩到）。
  if (
    current.executionId &&
    props.executionId &&
    current.executionId !== props.executionId
  ) {
    return undefined
  }
  return current
})

/** 日志尾部（与执行区块同一截断口径：最近 N 行）。 */
const LOG_TAIL_LINES = 200

const logTail = computed(() => {
  const lines = record.value?.logs ?? []
  return lines.length > LOG_TAIL_LINES
    ? lines.slice(lines.length - LOG_TAIL_LINES)
    : lines
})

/** 停止请求进行中（避免重复点击）。 */
const stopping = ref(false)

/**
 * 停止执行（RUN-7）。
 *
 * 终止动作走服务端（终止子进程与浏览器窗口），因此这里只发请求；
 * 终态由执行总线的事件回来，卡片随之切到「已中断」。
 *
 * @returns 请求完成后兑现。
 * @throws 不抛出异常——失败静默（终态事件仍会到达）。
 */
async function handleStop(): Promise<void> {
  if (stopping.value) return
  stopping.value = true
  try {
    await executionStore.stop(props.skillId)
  } finally {
    stopping.value = false
  }
}
</script>

<template>
  <div class="execution-body">
    <p v-if="!record" class="placeholder">
      执行过程记录不可用（可能因本地服务重启而丢失）；结果请以对话流中的摘要为准。
    </p>

    <template v-else>
      <!-- 停止执行（RUN-7）：点后终止运行与浏览器窗口，按「已中断」处理 -->
      <div v-if="!props.finished" class="stop-row">
        <span class="stop-hint">
          执行在本地服务侧进行，可继续对话或切换页面，过程不中断。
        </span>
        <n-button
          size="tiny"
          type="warning"
          secondary
          :loading="stopping"
          @click="handleStop"
        >
          停止执行
        </n-button>
      </div>

      <!-- 日志流：只展示尾部（RUN-9：不要求逐字回放已滚过的日志） -->
      <div class="log-stream" aria-label="执行日志">
        <p v-for="(line, index) in logTail" :key="index" class="log-line">
          {{ line }}
        </p>
        <p v-if="logTail.length === 0" class="log-placeholder">
          等待执行输出…
        </p>
      </div>

      <!-- 步骤进度（stepId → 用例步骤描述映射） -->
      <div v-if="record.steps.length > 0" class="step-progress">
        <p class="section-title">步骤进度</p>
        <ul class="step-list">
          <li v-for="step in record.steps" :key="step.stepId">
            <span
              class="step-mark"
              :class="{ ok: step.ok === true, bad: step.ok === false }"
            >
              {{ step.ok === true ? '✓' : step.ok === false ? '✗' : '…' }}
            </span>
            <span class="step-name">{{ step.stepId }}</span>
          </li>
        </ul>
      </div>

      <!-- 每条测试结果（结束即出现，先于报告） -->
      <ul v-if="record.tests.length > 0" class="test-list">
        <li v-for="test in record.tests" :key="test.title">
          <n-tag
            size="tiny"
            round
            :type="
              test.status === 'passed'
                ? 'success'
                : test.status === 'interrupted'
                  ? 'warning'
                  : test.status === 'skipped'
                    ? 'default'
                    : 'error'
            "
          >
            {{
              test.status === 'passed'
                ? '通过'
                : test.status === 'failed'
                  ? '失败'
                  : test.status === 'timedOut'
                    ? '超时'
                    : test.status === 'interrupted'
                      ? '中断'
                      : '跳过'
            }}
          </n-tag>
          <span class="test-title">{{ test.title }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.execution-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  min-height: 0;
}

.placeholder {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 12.5px;
  line-height: 1.6;
}

.stop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.stop-hint {
  color: var(--color-ink-muted);
  font-size: 12px;
  min-width: 0;
}

.log-stream {
  min-height: 96px;
  max-height: 240px;
  overflow-y: auto;
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-well);
}

.log-line {
  margin: 0 0 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-ink-body);
  word-break: break-all;
  white-space: pre-wrap;
}

.log-placeholder {
  margin: 0;
  font-size: 12px;
  color: var(--color-ink-muted);
}

.section-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink-deep);
}

.step-list,
.test-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-list li,
.test-list li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.step-mark {
  flex: 0 0 auto;
  color: var(--color-ink-muted);
}

.step-mark.ok {
  color: #15803d;
}

.step-mark.bad {
  color: #b91c1c;
  font-weight: 600;
}

.step-name,
.test-title {
  color: var(--color-ink-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
