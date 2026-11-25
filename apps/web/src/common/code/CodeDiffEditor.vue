<!--
  Monaco 差异编辑器：原始侧只读，候选侧可按需编辑并回传内容。

  渲染模式由调用方通过 `mode` 显式声明（`inline` / `sideBySide`），**不做宽度自适应**：

  - `inline`（默认）：原始侧与修改侧共用一列行号，适合产物卡片这类窄容器；
  - `sideBySide`：左右分栏，适合弹窗这类宽容器。

  之所以交由调用方声明而非按宽度自动判断，见 `mode` 的文档注释。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** 差异视图的渲染模式。 */
export type TDiffEditorMode = 'inline' | 'sideBySide'

const props = withDefaults(
  defineProps<{
    original: string
    modified: string
    language?: string
    /**
     * 渲染模式，默认 `inline`（内联 + 紧凑）。
     *
     * **为什么不按容器宽度自动选择**：
     *
     * 1. Monaco 的 `renderSideBySide` 只是「倾向」而非硬指令。其默认值
     *    `useInlineViewWhenSpaceIsLimited: true` + `renderSideBySideInlineBreakpoint: 900`
     *    会在**编辑器自身宽度 ≤ 900px** 时静默改用内联视图。
     * 2. 产物卡片的编辑器可用宽度上限约 828px（侧边栏内容区 `max-width: 860px`
     *    减去卡片正文左右各 16px 内边距），恒小于 900px，因此那里传
     *    `renderSideBySide: true` **从未真正生效**。
     * 3. 该隐式降级路径只把原始侧宽度压到 `max(5, decorationsLeft)`，**未同步
     *    收窄行号条元素**：行号条实际需 48px 却只分到 38px，向右溢出 10px 盖到
     *    修改侧，表现为「两列行号」且修改侧首字符被遮挡。
     * 4. `compactMode` 会置 `inlineViewHideOriginalLineNumbers`，使内联视图只保留
     *    修改侧一列行号，正是内联视图应有的紧凑形态；删除行仍以删除线 + 删除图标
     *    呈现，差异对比能力不受影响。
     *
     * 另：原实现依据 `window.innerWidth > 760` 判断。窗口宽度与容器实际宽度脱节，
     * 该判断在 1440px 窗口下恒为真，与真实布局无关，故一并移除。
     */
    mode?: TDiffEditorMode
    editable?: boolean
  }>(),
  {
    language: 'typescript',
    mode: 'inline',
    editable: false,
  },
)

/**
 * 由渲染模式解析出 Monaco 的构造选项。
 *
 * 并排模式显式关闭 `useInlineViewWhenSpaceIsLimited`：否则容器一旦窄于 900px
 * 仍会被静默降级回内联（即上述问题 3 的触发路径），使调用方的声明形同虚设。
 *
 * 内联模式额外关闭差异编辑器独有的两处外围部件，使视觉与普通 `CodeEditor` 一致：
 *
 * - `renderGutterMenu`：左侧 35px 的 hunk 工具栏（悬停出现「回退代码块」按钮）。
 *   Monaco 只要菜单有可用项就**恒定预留**这 35px（源码 `gutterFeature.js` 中
 *   `width = hasActions ? 35 : 0`），与是否真的存在差异无关；且它只在可编辑时占位，
 *   因此同一个卡片在只读与可编辑下宽度还会跳变。产物卡片正文上限约 828px，
 *   35px 占比可观，而「回退代码块」在卡片里可由编辑器自带的撤销替代。
 * - `renderOverviewRuler`：右侧 30px 的差异概览标尺（含灰色视口滑块）。
 *   Monaco 会把它从修改侧宽度里直接扣除（`modifiedWidth = fullWidth - ... - overviewRulerPartWidth`），
 *   是实打实的占位；普通 `CodeEditor` 的概览标尺绘制在滚动条区域内，不额外占宽。
 *
 * 并排模式（宽弹窗中的版本对比）保留这两处部件：容器足够宽，且「回退」与
 * 概览标尺正是审阅差异时需要的辅助。
 *
 * @param mode 调用方声明的渲染模式。
 * @returns 供 `createDiffEditor` 使用的渲染相关选项。
 * @throws 不抛出异常。
 */
function resolveRenderOptions(mode: TDiffEditorMode) {
  if (mode === 'sideBySide') {
    return { renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false }
  }
  return {
    renderSideBySide: false,
    compactMode: true,
    renderGutterMenu: false,
    renderOverviewRuler: false,
  }
}
const emit = defineEmits<{ 'update:modified': [value: string] }>()
const container = ref<HTMLElement | null>(null)
/**
 * 编辑器的加载状态。
 *
 * **为什么必须有它**：Monaco 是体积很大的异步 chunk（生产构建约 4.2MB）。
 * 在此之前本组件既不显示加载中、也不处理加载失败——chunk 还在下载或直接失败时，
 * 容器只剩一个**空框**，用户看到的就是「脚本没显示出来」。
 *
 * 两种状态都要显式呈现：
 *   - `loading`：给出「正在加载代码编辑器…」，避免被误判为缺陷；
 *   - `failed`：给出原因与兜底（脚本正文本身在卡片上仍可读），不静默留白。
 */
const loadState = ref<'loading' | 'ready' | 'failed'>('loading')
const loadErrorMessage = ref('')
let editor: import('monaco-editor').editor.IStandaloneDiffEditor | null = null
let originalModel: import('monaco-editor').editor.ITextModel | null = null
let modifiedModel: import('monaco-editor').editor.ITextModel | null = null
let changeSubscription: import('monaco-editor').IDisposable | null = null
let resizeObserver: ResizeObserver | null = null
let applyingExternalValue = false
/** 组件是否已卸载：异步加载完成后据此避免对已销毁实例继续操作。 */
let unmounted = false

/**
 * 按容器**当前**尺寸重排编辑器；容器不可见（尺寸为 0）时跳过。
 *
 * **为什么必须跳过尺寸为 0 的情况**：本组件的生命周期横跨侧边栏的收起与展开，
 * 而抽屉的 `display-directive="show"` 用 `v-show`（`display: none`）隐藏，
 * 组件**不会卸载**，因此隐藏瞬间容器尺寸变为 `0x0`，ResizeObserver 随之触发。
 * 此时若照常重排，Monaco 会按 0 尺寸计算并把结果以**内联样式**写回自己的根节点
 * （`diffEditorWidget.js` 中依据实测高度设置 `elements.root.style.height`），
 * 实测高度被塌缩为 `5px` 且**不会随重新显示自行恢复**——重新展开后编辑器只剩
 * 一行高度，看起来就是「内容没了」。
 *
 * **为什么必须显式传尺寸，而不是调用无参 `editor.layout()`**：
 *
 * 差异编辑器的根节点 `.monaco-diff-editor` 是它**自己的测量基准**
 * （`_rootSizeObserver` 观察的就是 `elements.root`）。一旦 5px 被写进该节点的
 * 内联样式，无参 `layout()` 会沿着 `_rootSizeObserver.observe(undefined)` 回到
 * **这个已被写死的节点**上再量一次，恒得 5px——自我引用，永远救不回来。
 * 因此这里必须把**容器**实测到的尺寸显式传给 `layout(dimension)`，
 * 让 Monaco 以真实尺寸重建布局并覆盖那段内联样式。
 *
 * 这条路径正是「非 Skill 开发页打开工作台」时踩中的：那种情况下卡片在抽屉
 * **收起状态**下挂载，编辑器创建时容器尚为 `display:none`，于是直接落进
 * 上述 5px 状态；判据是**挂载时抽屉是否展开**，而非用户所在页面本身。
 *
 * 跳过 0 尺寸的布局是安全的：重新显示时 ResizeObserver 会再次触发（尺寸由 0 恢复为
 * 真实值属于尺寸变化），届时按真实尺寸重排即可。
 *
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function layoutEditor(): void {
  const element = container.value
  if (!element || !editor) return

  // 用 clientWidth / clientHeight 而非 getBoundingClientRect()：排除边框，
  // 且与 Monaco 自己的测量口径（`elementSizeObserver.js` 读的就是 clientWidth /
  // clientHeight）完全一致——显式传尺寸时才能得到与健康路径毫无差别的数值。
  const width = element.clientWidth
  const height = element.clientHeight
  // 宽度或高度任一为 0 都说明容器当前不可见；此时 layout 会污染 Monaco 的内联尺寸。
  if (width === 0 || height === 0) return

  editor.layout({ width, height })
}

onMounted(async () => {
  let monaco: typeof import('monaco-editor')
  try {
    monaco = await import('./monaco').then((module) => module.loadMonaco())
  } catch (error) {
    // 加载失败不能静默：容器会永远空着，用户只会认为「脚本没显示出来」。
    if (unmounted) return
    loadState.value = 'failed'
    loadErrorMessage.value = error instanceof Error ? error.message : '未知原因'
    return
  }

  // 异步期间组件可能已被卸载（例如用户切走了页面）。
  if (unmounted || !container.value) return

  originalModel = monaco.editor.createModel(props.original, props.language)
  modifiedModel = monaco.editor.createModel(props.modified, props.language)
  editor = monaco.editor.createDiffEditor(container.value, {
    readOnly: !props.editable,
    originalEditable: false,
    ...resolveRenderOptions(props.mode),
    minimap: { enabled: false },
    automaticLayout: false,
  })
  editor.setModel({ original: originalModel, modified: modifiedModel })
  changeSubscription = modifiedModel.onDidChangeContent(() => {
    if (!applyingExternalValue && props.editable && modifiedModel) {
      emit('update:modified', modifiedModel.getValue())
    }
  })
  resizeObserver = new ResizeObserver(layoutEditor)
  resizeObserver.observe(container.value)
  loadState.value = 'ready'
  // 首帧按真实尺寸排一次：ResizeObserver 的首次回调不保证在 setModel 之后到达。
  layoutEditor()
})

watch(
  () => props.original,
  (value) => {
    if (originalModel?.getValue() !== value) originalModel?.setValue(value)
  },
)
watch(
  () => props.modified,
  (value) => {
    if (modifiedModel?.getValue() === value) return
    applyingExternalValue = true
    modifiedModel?.setValue(value)
    applyingExternalValue = false
  },
)
watch(
  () => props.editable,
  (editable) => {
    editor?.updateOptions({ readOnly: !editable, originalEditable: false })
  },
)

onBeforeUnmount(() => {
  // 先置位：Monaco 的异步加载可能晚于卸载返回，那些回调需要据此提前退出。
  unmounted = true
  resizeObserver?.disconnect()
  changeSubscription?.dispose()
  editor?.dispose()
  originalModel?.dispose()
  modifiedModel?.dispose()
})
</script>

<template>
  <div class="diff-editor-wrap">
    <!--
      容器始终保留：Monaco 需要它来做尺寸测量，且 ready 后不能重建 DOM。

      加载中与加载失败时用一个覆盖层给出说明——**底下的容器尺寸不变**，
      因此加载完成的那一刻不需要重新布局，也不会因为覆盖层而抖动。
    -->
    <div ref="container" class="diff-editor" />
    <div v-if="loadState !== 'ready'" class="diff-editor__overlay">
      <p v-if="loadState === 'loading'" class="diff-editor__hint">
        正在加载代码编辑器…
      </p>
      <template v-else>
        <p class="diff-editor__hint diff-editor__hint--error">
          代码编辑器加载失败（{{ loadErrorMessage }}）。
        </p>
        <p class="diff-editor__hint">
          脚本内容仍可在上方卡片中查看；可尝试刷新页面重试。
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 定位上下文：让加载 / 失败覆盖层精确盖住编辑器容器。 */
.diff-editor-wrap {
  position: relative;
}

.diff-editor {
  width: 100%;
  height: 52vh;
  min-height: 320px;
  border: 1px solid #334155;
}

/*
  覆盖层不可拦截指针：加载完成后它会立刻消失，但即便在失败态也不该挡住
  卡片上的其他操作（脚本正文本身在卡片里仍可读）。
*/
.diff-editor__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  text-align: center;
  pointer-events: none;
  background: var(--color-well);
}

.diff-editor__hint {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 13px;
}

.diff-editor__hint--error {
  color: var(--color-ink-deep);
}
@media (max-width: 760px) {
  .diff-editor {
    height: 58vh;
    min-height: 280px;
  }
}
</style>
