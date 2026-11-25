<!-- env.json 编辑页顶部的用途说明栏（v10 PRD 5.2）：纯静态文案，不感知保存状态。 -->
<script setup lang="ts">
defineOptions({ name: 'EnvFileBanner' })
</script>

<template>
  <aside class="env-banner" aria-label="env.json 用途说明">
    <p class="env-banner-title">
      env.json 用于保存本 Skill 的敏感数据（如登录密码、Token、验证码、免登录
      cookie 等）的真实值。
    </p>
    <ul>
      <li>
        这里的值<strong>不会被大模型读取</strong>，只在脚本执行时作为环境变量注入脚本；
      </li>
      <li>在结构化用例编辑页中通过「添加敏感数据」引用这里定义的 key；</li>
      <li>
        key 使用大写字母开头的名称，仅含大写字母、数字和下划线，如
        <code>E2E_PASSWORD</code>。
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.env-banner {
  flex: none;
  /* 底部 10px：与下方编辑器保持固定间距（v10 页面规格） */
  margin: var(--space-sm) var(--space-card) 10px;
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--color-border);
  border-left: 3px solid #3b82f6;
  border-radius: var(--radius-brand);
  background: var(--color-surface);
  color: var(--color-ink-body);
  font-size: 12px;
}

.env-banner-title {
  margin: 0 0 var(--space-xs);
  color: var(--color-ink-deep);
  font-weight: 600;
}

.env-banner ul {
  margin: 0;
  padding-left: 18px;
}

.env-banner li {
  margin-top: 2px;
}

.env-banner code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--color-canvas);
  font-size: 11px;
}
</style>
