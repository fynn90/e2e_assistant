<!--
  Skill 开发图片预览子路由（v13）：在文件树中打开图片文件时的展示面板。

  为什么需要独立面板：文本编辑器路径（`/file?path=`）会在二进制扩展名、
  NUL 字节与 UTF-8 解码三处拒绝图片，因此图片必须走专用字节路由
  （`/image?path=`）并在此以图形方式呈现。

  与报告面板（v11）的差异：报告是自包含 HTML，走「取文本 → Blob → iframe」；
  图片直接由 `<img src>` 消费字节地址，省去 blob 中转（浏览器自带的缓存、
  懒加载与解码更高效，也不必手工 revoke 地址）。

  注意：模板必须保持单一稳定根节点，否则 transition + keep-alive 切换面板时
  会因子树锚点失效而崩溃（与其余 Route 面板同一约束）。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NAlert, NButton } from 'naive-ui'
import ImageViewer from '../../../common/image/ImageViewer.vue'
import { buildSkillImageUrl } from '../../../services/skill-api'
import { parseSkillDevelopmentWorkspaceTarget } from '../../../router/skill-development-navigation'

defineOptions({ name: 'SkillDevelopmentImageRoute' })

const route = useRoute()

/** 当前 Skill ID（由路由参数解析）。 */
const skillId = computed(() =>
  typeof route.params.skillId === 'string' ? route.params.skillId : '',
)

/**
 * 待预览图片的相对路径。
 *
 * 从路由解析而非 workspace context：与报告面板一致，面板输入完全由 URL 决定，
 * 这样刷新页面、直接粘贴地址、浏览器前进后退都能得到同一结果。
 */
const relativePath = ref('')

watch(
  () => parseSkillDevelopmentWorkspaceTarget(route),
  (target) => {
    relativePath.value = target?.panel === 'image' ? target.relativePath : ''
  },
  { immediate: true },
)

/**
 * 重载令牌：让地址带上变化的时间戳，从而绕过浏览器缓存重新请求。
 *
 * 用于图片在磁盘上被重新生成（如重新捕获基线）后，用户主动刷新查看。
 */
const reloadToken = ref(0)

/** 图片字节地址（含重载令牌）。 */
const imageUrl = computed(() => {
  if (!skillId.value || !relativePath.value) return ''
  const base = buildSkillImageUrl(skillId.value, relativePath.value)
  return reloadToken.value === 0 ? base : `${base}&_t=${reloadToken.value}`
})

/**
 * 重新加载图片：更新重载令牌以触发浏览器重新请求。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function reloadImage(): void {
  reloadToken.value = Date.now()
}
</script>

<template>
  <div class="image-route">
    <n-alert
      v-if="!relativePath"
      type="warning"
      title="未指定图片"
      class="image-route-alert"
    >
      请从左侧文件树中选择一张图片打开。
    </n-alert>

    <template v-else>
      <div class="image-route-head">
        <span class="image-path">{{ relativePath }}</span>
        <n-button size="tiny" @click="reloadImage">重新加载</n-button>
      </div>
      <!-- key 绑定路径：切换图片时整体重建，避免上一张的缩放档位与加载态残留 -->
      <image-viewer
        :key="relativePath"
        class="image-route-viewer"
        :src="imageUrl"
        :alt="relativePath"
      />
    </template>
  </div>
</template>

<style scoped>
.image-route {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.image-route-alert {
  margin: var(--space-lg);
}
.image-route-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  min-height: 32px;
  padding: 0 var(--space-card);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.image-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-ink-muted);
  font-size: 12px;
}
/* 查看器需要可收缩的弹性容器，否则在 flex 列布局中会撑破头部 */
.image-route-viewer {
  flex: 1;
  min-height: 0;
}
</style>
