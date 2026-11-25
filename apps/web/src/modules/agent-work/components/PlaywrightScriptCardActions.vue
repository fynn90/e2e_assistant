<!--
  脚本卡片的操作区（v13）。

  v9 时这里是「只有【关闭】一个按钮」；v13 移除关闭按钮后改为空操作区。
  现新增 **「查看测试脚本」**：跳转到该 Skill 的开发页并打开 test.spec.ts。

  为什么需要它（v13 需求方补充）：脚本卡片内虽有 Monaco 差异编辑器，
  但它嵌在宽度受限的工作台里、且依赖较大的异步资源；而「完整地看/改这份脚本」
  本来就是 Skill 开发页代码编辑器的职责。给一个明确出口，用户不必自己去文件树里找。

  按钮形态：
    - **主按钮（primary）**：这是卡片唯一的动作，用主样式让它显眼；
    - 版本元信息（产出版本）以次要文字放在按钮**左侧**——用户核对「打开的是哪一版」
      时才需要它，不抢主按钮的注意力。
-->
<script setup lang="ts">
import { NButton } from 'naive-ui'

defineProps<{
  /** 脚本产出版本（可缺省：早期记录可能没有版本号）。 */
  version?: string
}>()

const emit = defineEmits<{
  /** 用户点击「查看测试脚本」。 */
  openScript: []
}>()
</script>

<template>
  <span v-if="version" class="script-version"
    >版本 {{ version.slice(0, 8) }}</span
  >
  <n-button size="small" type="primary" @click="emit('openScript')">
    查看测试脚本
  </n-button>
</template>

<style scoped>
.script-version {
  color: var(--color-ink-muted);
  font-size: 12px;
}
</style>
