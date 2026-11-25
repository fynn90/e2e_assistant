<!-- Monaco 代码编辑器：内置工具栏（可隐藏）、模型管理与保存快捷键。 -->
<script setup lang="ts">
import {
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from 'vue'
import CodeToolbar from './CodeToolbar.vue'
import type { ICodeEditorProps } from './types'

const props = defineProps<ICodeEditorProps>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  save: []
}>()

const editorContainer = ref<HTMLElement | null>(null)
let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null
let model: import('monaco-editor').editor.ITextModel | null = null
let contentSubscription: import('monaco-editor').IDisposable | null = null
let resizeObserver: ResizeObserver | null = null
let applyingExternalValue = false
let active = true
let unmounted = false

/**
 * 编辑器加载状态（与 `CodeDiffEditor` 同款处理）。
 *
 * Monaco 是体积很大的异步 chunk；若不呈现状态，加载中与加载失败都会表现为
 * 一个空容器，用户只会当作「文件打不开」。
 */
const loadState = ref<'loading' | 'ready' | 'failed'>('loading')
const loadErrorMessage = ref('')

onMounted(async () => {
  let monaco: typeof import('monaco-editor')
  try {
    monaco = await import('./monaco').then((module) => module.loadMonaco())
  } catch (error) {
    // 与 CodeDiffEditor 同理：Monaco 是体积很大的异步 chunk，加载失败时
    // 不能静默留一个空容器——那看起来就是「文件打开失败 / 内容没了」。
    if (unmounted) return
    loadState.value = 'failed'
    loadErrorMessage.value = error instanceof Error ? error.message : '未知原因'
    return
  }

  if (unmounted || !editorContainer.value) return

  model = monaco.editor.createModel(
    props.modelValue,
    props.language,
    monaco.Uri.from({ scheme: 'authine-skill', path: `/${props.filePath}` }),
  )
  editor = monaco.editor.create(editorContainer.value, {
    model,
    automaticLayout: false,
    readOnly: props.readOnly,
    minimap: { enabled: false },
    fontSize: 14,
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    wordWrap: 'off',
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (!props.readOnly) emit('save')
  })
  contentSubscription = model.onDidChangeContent(() => {
    if (!applyingExternalValue)
      emit('update:modelValue', model?.getValue() ?? '')
  })
  resizeObserver = new ResizeObserver(layoutEditor)
  observeEditorContainer()
  loadState.value = 'ready'
})

/**
 * 按容器**当前**尺寸重排编辑器；容器不可见（尺寸为 0）时跳过。
 *
 * 与 `CodeDiffEditor` 同因同治：容器隐藏时（如侧边栏收起，`v-show` 使尺寸变为
 * `0x0`）若照常 `layout()`，Monaco 会把 0 尺寸的计算结果以**内联样式**写回自身
 * 根节点，高度被塌缩且不会自行恢复。跳过 0 尺寸是安全的——重新显示属于尺寸变化，
 * ResizeObserver 会再次触发。
 *
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function layoutEditor(): void {
  if (!active || !editor) return

  const element = editorContainer.value
  if (!element) return

  const { width, height } = element.getBoundingClientRect()
  // 宽度或高度任一为 0 均说明容器当前不可见。
  if (width === 0 || height === 0) return

  editor.layout()
}

onActivated(async () => {
  active = true
  await nextTick()
  observeEditorContainer()
  // 经布局守卫调用：keep-alive 恢复时容器可能尚未完成布局，此时不能重排。
  layoutEditor()
})

onDeactivated(() => {
  active = false
  resizeObserver?.disconnect()
})

/**
 * 让尺寸观察器监听当前 Monaco 容器。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function observeEditorContainer(): void {
  if (active && resizeObserver && editorContainer.value) {
    resizeObserver.observe(editorContainer.value)
  }
}

watch(
  () => props.modelValue,
  (value) => {
    if (!model || model.getValue() === value) return
    applyingExternalValue = true
    model.setValue(value)
    applyingExternalValue = false
  },
)

watch(
  () => props.readOnly,
  (readOnly) => editor?.updateOptions({ readOnly }),
)

watch(
  () => props.language,
  async (language) => {
    if (!model) return
    const monaco = await import('./monaco').then((module) =>
      module.loadMonaco(),
    )
    monaco.editor.setModelLanguage(model, language)
  },
)

onBeforeUnmount(() => {
  unmounted = true
  active = false
  resizeObserver?.disconnect()
  contentSubscription?.dispose()
  editor?.dispose()
  model?.dispose()
})

/**
 * 滚动到指定行并聚焦到指定列（供外部校验反馈区定位错误，v10 PRD 5.3）。
 * @param line - 1 起始的行号。
 * @param column - 1 起始的列号；缺省定位到行首。
 * @returns 无返回值。
 * @throws 不抛出异常；编辑器尚未挂载时忽略本次调用。
 */
function revealPosition(line: number, column = 1): void {
  if (!editor) return
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column })
  editor.focus()
}

defineExpose({ revealPosition })
</script>

<template>
  <section class="code-editor-shell">
    <code-toolbar
      v-if="!props.hideToolbar"
      :file-path="props.filePath"
      :read-only="props.readOnly"
      :saving="props.saving"
      :dirty="props.dirty"
      :save-state="props.saveState"
      @save="emit('save')"
    />
    <div class="editor-body">
      <div ref="editorContainer" class="editor-container" />
      <div v-if="loadState !== 'ready'" class="editor-overlay">
        <p v-if="loadState === 'loading'" class="editor-hint">
          正在加载代码编辑器…
        </p>
        <template v-else>
          <p class="editor-hint editor-hint--error">
            代码编辑器加载失败（{{ loadErrorMessage }}）。
          </p>
          <p class="editor-hint">可尝试刷新页面重试。</p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.code-editor-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #0b1120;
}
/* 编辑区：为加载 / 失败覆盖层提供定位上下文。 */
.editor-body {
  position: relative;
  flex: 1;
  min-height: 0;
}
.editor-container {
  width: 100%;
  height: 100%;
}

/*
  覆盖层不拦截指针：失败态下工具栏（保存等）仍应可用，
  且加载完成后覆盖层立即消失。
*/
.editor-overlay {
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
  background: #0b1120;
}

.editor-hint {
  margin: 0;
  color: #94a3b8;
  font-size: 13px;
}

.editor-hint--error {
  color: #e2e8f0;
}
</style>
