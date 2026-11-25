<script setup lang="ts">
import { NCard, NSpace, NSpin } from 'naive-ui'
</script>

<template>
  <n-card :bordered="false" size="large">
    <n-space vertical align="center" size="large">
      <n-spin size="large" />
      <div class="loading-copy">
        <h1 class="hero-title">正在加载 Authine E2E Agent Platform</h1>
        <p class="hero-description">
          系统正在检查当前项目是否已经完成初始化配置。
        </p>
      </div>
    </n-space>
  </n-card>
</template>

<style scoped>
.loading-copy {
  text-align: center;
}

.hero-title {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 700;
}

.hero-description {
  margin: 0;
  color: #4b5563;
  line-height: 1.7;
}
</style>
