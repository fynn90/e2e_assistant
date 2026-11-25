<!-- Skill 开发报告视图子路由（v11，PRD V3/V7）：主内容区以网页形态渲染测试报告。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NAlert, NSpin } from 'naive-ui'
import { ApiClientError } from '../../../services/http-client'

defineOptions({ name: 'SkillDevelopmentReportRoute' })

const route = useRoute()

/** 当前 Skill ID 与运行时间戳（由路由参数解析）。 */
const skillId = computed(() =>
  typeof route.params.skillId === 'string' ? route.params.skillId : '',
)
const runId = computed(() =>
  typeof route.params.runId === 'string' ? route.params.runId : '',
)

/** 报告加载状态：loading / ready / missing / error。 */
const loadState = ref<'idle' | 'loading' | 'ready' | 'missing' | 'error'>(
  'idle',
)
const errorMessage = ref('')
/** 报告 HTML 原文（本地服务返回后交给 iframe 的 srcdoc 渲染）。 */
const reportHtml = ref('')

watch(
  [skillId, runId],
  async () => {
    if (!skillId.value || !runId.value) {
      loadState.value = 'idle'
      return
    }
    await loadReport()
  },
  { immediate: true },
)

/**
 * 拉取报告 HTML 并通过 iframe 的 srcdoc 渲染。
 *
 * 先取文本再进 iframe（而不是直接把 API 地址给 iframe）：
 * 这样可以稳定识别「报告文件不存在」（V7）等错误信封，
 * 避免在 iframe 内渲染 JSON 错误页。平台生成的报告是零脚本静态 HTML；
 * srcdoc 继承页面 CSP，可避免受 frame-src 管控的 blob: 地址被浏览器拦截。
 *
 * @returns 加载完成后兑现。
 * @throws 不抛出异常；失败转换为 missing / error 状态。
 */
async function loadReport(): Promise<void> {
  loadState.value = 'loading'
  errorMessage.value = ''
  reportHtml.value = ''

  try {
    const response = await fetch(
      `/api/skills/${skillId.value}/test-reports/${runId.value}/report.html`,
      { credentials: 'same-origin' },
    )

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
    loadState.value = 'ready'
  } catch (error) {
    errorMessage.value =
      error instanceof ApiClientError
        ? error.message
        : '报告加载失败，请确认本地服务已启动。'
    loadState.value = 'error'
  }
}
</script>

<template>
  <div class="report-view">
    <n-spin
      v-if="loadState === 'loading' || loadState === 'idle'"
      class="report-loading"
      size="medium"
    >
      <template #description>正在加载测试报告…</template>
    </n-spin>

    <n-alert
      v-else-if="loadState === 'missing'"
      type="warning"
      title="报告文件不存在"
      class="report-alert"
    >
      报告文件不存在（可能已被手动删除），请从文件树选择其他报告。
    </n-alert>

    <n-alert
      v-else-if="loadState === 'error'"
      type="error"
      title="报告加载失败"
      class="report-alert"
    >
      {{ errorMessage }}
    </n-alert>

    <!-- 报告为平台生成的自包含静态 HTML（零脚本），iframe 承载安全（技术方案 D10）。 -->
    <iframe
      v-else-if="reportHtml"
      :srcdoc="reportHtml"
      class="report-frame"
      :title="`测试报告 ${runId}`"
      referrerpolicy="no-referrer"
    />
  </div>
</template>

<style scoped>
.report-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
}

.report-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.report-alert {
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
