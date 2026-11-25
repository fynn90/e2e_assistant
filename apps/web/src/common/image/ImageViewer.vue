<!--
  图片查看组件（v13）：按字节地址加载并展示一张图片，支持缩放与尺寸信息。

  职责边界：只负责「拿到一个 url → 展示图片 → 处理加载失败」，
  不关心字节从哪来（Skill 文件、探查截图、报告附件皆可复用）。
  调用方负责按需创建与释放 url（`URL.createObjectURL` 的 blob 地址需在卸载时 revoke）。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NSpin } from 'naive-ui'

const props = defineProps<{
  /** 图片的可访问地址；blob 地址或同源相对路径均可。 */
  src: string
  /** 图片替代文本（无障碍与加载失败时的说明）。 */
  alt?: string
}>()

/** 缩放档位下限：适应容器（按 `object-fit: contain` 缩放，可能小于或大于原始像素）。 */
const MIN_ZOOM = 1
/** 缩放档位上限：4 倍，足够看清截图细节而不至于失控。 */
const MAX_ZOOM = 4

const zoom = ref(MIN_ZOOM)

/** 加载状态：loading → ready（成功）或 failed（请求/解码失败）。 */
const loadState = ref<'loading' | 'ready' | 'failed'>('loading')

/** 图片原始像素尺寸；由浏览器解码后回填，无需服务端提供。 */
const naturalSize = ref<{ width: number; height: number } | null>(null)

// 更换地址时重置：缩放回到适应容器、清空尺寸并重新进入加载态。
// 不重置会让上一张图的缩放档位与尺寸信息错误地沿用到新图。
watch(
  () => props.src,
  () => {
    zoom.value = MIN_ZOOM
    naturalSize.value = null
    loadState.value = props.src ? 'loading' : 'failed'
  },
  { immediate: true },
)

const zoomPercent = computed(() => Math.round(zoom.value * 100))
const canZoomIn = computed(() => zoom.value < MAX_ZOOM)
const canZoomOut = computed(() => zoom.value > MIN_ZOOM)

/** 图片尺寸文本（原始像素）。 */
const dimensionText = computed(() =>
  naturalSize.value
    ? `${naturalSize.value.width} × ${naturalSize.value.height}`
    : '',
)

/**
 * 图片解码成功后记录原始尺寸。
 *
 * @param event 图片元素的 load 事件。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleLoad(event: Event): void {
  const image = event.target as HTMLImageElement | null
  if (image) {
    naturalSize.value = {
      width: image.naturalWidth,
      height: image.naturalHeight,
    }
  }
  loadState.value = 'ready'
}

/**
 * 放大一档。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function zoomIn(): void {
  if (canZoomIn.value) zoom.value = Math.min(MAX_ZOOM, zoom.value + 1)
}

/**
 * 缩小一档。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function zoomOut(): void {
  if (canZoomOut.value) zoom.value = Math.max(MIN_ZOOM, zoom.value - 1)
}

/**
 * 恢复为适应容器。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function resetZoom(): void {
  zoom.value = MIN_ZOOM
}
</script>

<template>
  <div class="image-viewer">
    <!-- 工具栏：缩放控制与图片信息。单图也有意义，因此常驻展示 -->
    <div class="viewer-toolbar">
      <div class="zoom-controls">
        <button
          type="button"
          :disabled="!canZoomOut"
          title="缩小"
          @click="zoomOut"
        >
          −
        </button>
        <span class="zoom-text">{{ zoomPercent }}%</span>
        <button
          type="button"
          :disabled="!canZoomIn"
          title="放大"
          @click="zoomIn"
        >
          +
        </button>
        <button
          type="button"
          :disabled="zoom === MIN_ZOOM"
          title="适应窗口"
          @click="resetZoom"
        >
          适应
        </button>
      </div>
      <div class="image-meta">
        <span v-if="dimensionText">{{ dimensionText }}</span>
      </div>
    </div>

    <div class="viewer-stage">
      <n-spin
        v-if="loadState === 'loading'"
        size="medium"
        class="viewer-loading"
      />

      <div v-else-if="loadState === 'failed'" class="viewer-failed">
        <p class="failed-title">无法显示这张图片</p>
        <p class="failed-hint">
          文件可能不是有效的图片格式，或已被移动、删除。
        </p>
      </div>

      <img
        v-show="loadState !== 'failed'"
        class="viewer-image"
        :class="{ 'is-zoomed': zoom > MIN_ZOOM }"
        :src="src"
        :alt="alt ?? '图片预览'"
        :style="zoom > MIN_ZOOM ? { width: `${zoomPercent}%` } : undefined"
        @load="handleLoad"
        @error="loadState = 'failed'"
      />
    </div>
  </div>
</template>

<style scoped>
.image-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--color-surface);
}
.viewer-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  min-height: 36px;
  padding: 0 var(--space-card);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.zoom-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.zoom-controls button {
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
  color: var(--color-ink-body);
  font-size: 12px;
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-out);
}
.zoom-controls button:hover:not(:disabled) {
  background: var(--color-surface-hover, #f1f5f9);
}
.zoom-controls button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.zoom-text {
  min-width: 40px;
  text-align: center;
  color: var(--color-ink-muted);
  font-size: 12px;
}
.image-meta {
  display: inline-flex;
  gap: 10px;
  color: var(--color-ink-muted);
  font-size: 12px;
}
/* 展示区可滚动：放大后图片超出视口时靠滚动查看，而不是把容器撑破 */
.viewer-stage {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: auto;
  padding: 20px;
  background: repeating-conic-gradient(#f8fafc 0% 25%, #f1f5f9 0% 50%) 50% /
    20px 20px;
}
.viewer-loading {
  align-self: center;
}
.viewer-failed {
  text-align: center;
  color: var(--color-ink-muted);
}
.failed-title {
  margin: 0 0 6px;
  color: var(--color-ink-deep);
  font-size: 14px;
}
.failed-hint {
  margin: 0;
  font-size: 12.5px;
}
.viewer-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 2px 12px rgb(15 23 42 / 8%);
}
/* 放大后解除尺寸约束，交由父容器滚动查看 */
.viewer-image.is-zoomed {
  max-width: none;
  max-height: none;
}
</style>
