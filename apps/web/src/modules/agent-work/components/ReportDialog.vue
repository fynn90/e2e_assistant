<!--
  报告弹窗（v16，PRD RPT-3/RPT-4/RPT-5）：在 /agent 页内以模态框渲染测试报告。

  取数与渲染沿用 v11 报告视图的方案（`SkillDevelopmentReportRoute.vue`）：
  先取报告 HTML 文本，再通过 iframe 的 srcdoc 渲染——**不把接口地址直接给 iframe**，
  这样才能稳定识别「报告文件不存在」（RPT-5，404）等错误信封，
  避免在 iframe 内渲染 JSON 错误页（那看起来像一份空白报告）。
  iframe 改用 srcdoc 是为了继承页面 CSP；blob: 帧地址会被默认 frame-src 拦截。

  报告原文件仍在 SKILL 目录的 `test_report/<runId>/` 下（RPT-3），
  本弹窗不另存副本；「在新标签页打开」也用同一个 blob 地址（RPT-4）。
-->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { NAlert, NButton, NModal, NSpin } from 'naive-ui'
import { ApiClientError } from '../../../services/http-client'

const props = defineProps<{
  /** 是否展示弹窗。 */
  show: boolean
  /** 目标 Skill ID。 */
  skillId: string
  /** 目标 Skill 标题（弹窗标题）。 */
  skillTitle: string
  /** 运行时间戳（报告目录名）。 */
  runId: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()

/** 报告加载状态：loading / ready / missing / error。 */
const loadState = ref<'idle' | 'loading' | 'ready' | 'missing' | 'error'>(
  'idle',
)
const errorMessage = ref('')
/** 报告 HTML 原文（供 iframe 的 srcdoc 渲染）。 */
const reportHtml = ref('')
/** 报告 HTML 的 blob 地址（供「新标签页打开」复用）。 */
const reportUrl = ref('')

watch(
  () => [props.show, props.skillId, props.runId] as const,
  ([show]) => {
    if (!show) {
      // 关闭即释放 blob：报告可能很大，留着会长期占用内存。
      releaseReportUrl()
      loadState.value = 'idle'
      return
    }
    if (props.skillId && props.runId) {
      void loadReport()
    }
  },
  { immediate: true },
)

/**
 * 拉取报告 HTML 并转为 blob 地址供 iframe 渲染。
 *
 * @returns 加载完成后兑现。
 * @throws 不抛出异常；失败转换为 missing / error 状态（RPT-5：不得静默失败）。
 */
async function loadReport(): Promise<void> {
  loadState.value = 'loading'
  releaseReportUrl()
  errorMessage.value = ''
  reportHtml.value = ''

  try {
    const response = await fetch(
      `/api/skills/${encodeURIComponent(props.skillId)}/test-reports/${encodeURIComponent(props.runId)}/report.html`,
      { credentials: 'same-origin' },
    )

    // RPT-5：报告被手工删除时服务端返回 404，弹窗必须明确提示而不是渲染空白。
    if (response.status === 404) {
      loadState.value = 'missing'
      return
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        { message?: string } | undefined
      errorMessage.value = payload?.message ?? '报告加载失败，请稍后重试。'
      loadState.value = 'error'
      return
    }

    const html = await response.text()
    reportHtml.value = html
    reportUrl.value = URL.createObjectURL(
      new Blob([html], { type: 'text/html; charset=utf-8' }),
    )
    loadState.value = 'ready'
  } catch (error) {
    errorMessage.value =
      error instanceof ApiClientError
        ? error.message
        : '报告加载失败，请确认本地服务已启动。'
    loadState.value = 'error'
  }
}

/** 释放上一次的报告 blob 地址，避免内存泄漏。 */
function releaseReportUrl(): void {
  if (reportUrl.value) {
    URL.revokeObjectURL(reportUrl.value)
    reportUrl.value = ''
  }
  reportHtml.value = ''
}

/**
 * 在新标签页打开报告（RPT-4）。
 *
 * 复用已生成的 blob 地址：新标签页在**当前页面上下文**中打开，
 * blob URL 在同一 origin 内有效，不需要重新请求一遍报告。
 *
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function openInNewTab(): void {
  if (reportUrl.value) {
    window.open(reportUrl.value, '_blank', 'noopener')
  }
}

/**
 * 关闭弹窗（RPT-4：关闭后执行卡片与摘要保持原状）。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function close(): void {
  emit('update:show', false)
}
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="true"
    @update:show="(value) => emit('update:show', value)"
  >
    <div class="report-dialog" role="dialog" aria-modal="true">
      <header class="dialog-head">
        <div class="head-text">
          <span class="dialog-title">测试报告</span>
          <span class="dialog-subtitle"
            >{{ props.skillTitle }} · {{ props.runId }}</span
          >
        </div>
        <div class="head-actions">
          <n-button
            v-if="loadState === 'ready'"
            size="small"
            quaternary
            @click="openInNewTab"
          >
            在新标签页打开
          </n-button>
          <n-button size="small" @click="close">关闭</n-button>
        </div>
      </header>

      <div class="dialog-body">
        <n-spin
          v-if="loadState === 'loading' || loadState === 'idle'"
          class="dialog-state"
          size="medium"
        >
          <template #description>正在加载测试报告…</template>
        </n-spin>

        <!-- RPT-5：报告不存在时明确提示，不渲染空白 -->
        <n-alert
          v-else-if="loadState === 'missing'"
          type="warning"
          title="报告文件不存在"
          class="dialog-state"
        >
          报告文件不存在（可能已在文件系统中被删除）；本次执行的统计摘要仍可在卡片中查看。
        </n-alert>

        <n-alert
          v-else-if="loadState === 'error'"
          type="error"
          title="报告加载失败"
          class="dialog-state"
        >
          {{ errorMessage }}
        </n-alert>

        <!-- 报告为平台生成的自包含静态 HTML（零脚本），iframe 承载安全 -->
        <iframe
          v-else-if="reportHtml"
          :srcdoc="reportHtml"
          class="report-frame"
          :title="`测试报告 ${props.runId}`"
          referrerpolicy="no-referrer"
        />
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.report-dialog {
  display: flex;
  flex-direction: column;
  width: min(1100px, calc(100vw - 48px));
  height: min(820px, calc(100vh - 80px));
  background: var(--color-surface);
  border-radius: var(--radius-panel);
  overflow: hidden;
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  flex: none;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dialog-title {
  color: var(--color-ink-deep);
  font-size: 15px;
  font-weight: 600;
}

.dialog-subtitle {
  color: var(--color-ink-muted);
  font-size: 12px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-shrink: 0;
}

.dialog-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #f5f6f8;
}

.dialog-state {
  margin: var(--space-lg);
}

.report-frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: none;
  background: #f5f6f8;
}
</style>
