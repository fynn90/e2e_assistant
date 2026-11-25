<!--
  `/agent` 会话终态提示的宿主（v17 PRD C7、技术方案 §7.3）。

  **为什么需要独立组件**：`App.vue` 渲染了 `n-notification-provider`，因此它
  自身不在该 provider 的子树里，`useNotification()` 在它的 `setup` 中取不到注入
  ——必须由 provider **之内**的子组件承担（与 v13 的 `WorkbenchNoticeHost`
  同一个理由）。

  **为什么必须常驻挂载**：用户离开 `/agent` 才需要这条提示，而离开正是页面组件
  被卸载的时刻。监听若挂在 `/agent` 页面或抽屉上，那时它已经不在了。

  与 `WorkbenchNoticeHost` 的分工：那个负责**工作台**任务的提示，本组件负责
  **`/agent` 会话**任务的提示；两条通道互不重复（C7 末句、v13 N-9），因此
  各自独立成组件，不合并——合并会让「哪些任务进哪条通道」的判定散在一处。
-->
<script setup lang="ts">
import { useAgentSessionWatch } from '../composables/useAgentSessionWatch'

// 全部逻辑收敛在 composable 里（应用级第二条提示通道）。
useAgentSessionWatch()
</script>

<template>
  <!-- 纯逻辑组件：不渲染任何自己的 DOM -->
</template>
