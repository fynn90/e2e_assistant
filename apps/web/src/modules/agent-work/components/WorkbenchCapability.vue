<!--
  能力卡（v17，PRD H2/H3）：能做的事 + 明确不做的事（含替代路径）。

  内容**不由前端编造**：`domains` / `notSupported` 全部来自服务端的能力清单
  （与 Agent 的提示词同源），因此卡片对平台能力的承诺与事实一致。
  两条都不为空是产品要求（U4：能力外请求必须给替代路径），此处如实渲染。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { readCapabilityPayload } from '../workbench-view-payloads'

const props = defineProps<{
  /** 能力卡载荷（原始 `Record`，本组件内一次窄化）。 */
  payload: Record<string, unknown>
}>()

const data = computed(() => readCapabilityPayload(props.payload))
</script>

<template>
  <div class="capability">
    <div class="section">
      <span class="section-title">我能做的事</span>
      <ul class="domain-list">
        <li v-for="domain in data.domains" :key="domain.key" class="domain">
          <span class="domain-label">{{ domain.label }}</span>
          <ul class="example-list">
            <li v-for="example in domain.examples" :key="example">
              {{ example }}
            </li>
          </ul>
        </li>
      </ul>
    </div>

    <div class="section">
      <span class="section-title">我做不到的事（以及替代做法）</span>
      <ul class="not-supported-list">
        <li
          v-for="item in data.notSupported"
          :key="item.label"
          class="not-supported"
        >
          <span class="ns-label">{{ item.label }}</span>
          <span class="ns-alt">替代做法：{{ item.alternative }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.capability {
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
}

.section-title {
  color: var(--color-ink-deep);
  font-size: 12px;
  font-weight: 600;
}

.domain-list,
.example-list,
.not-supported-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.domain-list,
.not-supported-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.domain {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.domain-label {
  color: var(--color-ink-body);
  font-size: 12.5px;
  font-weight: 600;
}

.example-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 14px;
}

.example-list li {
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
}

.not-supported {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ns-label {
  color: var(--color-ink-body);
  font-size: 12.5px;
}

.ns-alt {
  color: var(--color-ink-muted);
  font-size: 11.5px;
  line-height: 1.5;
}
</style>
