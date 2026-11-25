<script setup lang="ts">
import { NSpin } from 'naive-ui'
</script>

<template>
  <div class="loading-shell">
    <n-spin size="large" />
    <p>正在加载 Skill 开发空间…</p>
  </div>
</template>

<style scoped>
.loading-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  color: #64748b;
  background: #f8fafc;
}
</style>
