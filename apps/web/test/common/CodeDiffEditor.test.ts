/**
 * 差异编辑器布局的回归护栏（v13 缺陷：非 Skill 开发页打开工作台时脚本框只剩一条缝）。
 *
 * 缺陷成因：抽屉以 `v-show`（`display: none`）隐藏时组件不卸载，卡片会在隐藏容器里
 * 挂载编辑器。Monaco 差异编辑器把量得的高度以**内联样式**写回自己的根节点，而
 * 容器不可见时量得 0、被钳成 5px —— 重新展开后该节点自身即是测量基准（自引用），
 * 恒得 5px，内容被裁成一条缝且**不会自愈**。
 *
 * 因此这里钉住两条行为：
 *   1. 重排必须把**容器**实测尺寸**显式**传给 `layout(dimension)`，
 *      而不是调无参 `layout()`（后者会回到被写死的根节点自量）；
 *   2. 容器不可见（尺寸为 0）时必须跳过，避免把 0 尺寸污染进 Monaco。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CodeDiffEditor from '../../src/common/code/CodeDiffEditor.vue'

/** 每次 `layout()` 收到的参数（undefined 即「无参自量」，正是缺陷形态）。 */
const layoutCalls: Array<{ width: number; height: number } | undefined> = []
/** 组件注册的 ResizeObserver 回调：手动触发以模拟容器尺寸变化。 */
let resizeCallback: (() => void) | null = null

/** 最小可用的 model 替身：只需满足组件的读写与变更订阅。 */
function createModelStub(initial: string) {
  let value = initial
  return {
    getValue: () => value,
    setValue: (next: string) => {
      value = next
    },
    onDidChangeContent: () => ({ dispose: () => undefined }),
    dispose: () => undefined,
  }
}

vi.mock('../../src/common/code/monaco', () => ({
  loadMonaco: async () => ({
    editor: {
      createModel: (value: string) => createModelStub(value),
      createDiffEditor: () => ({
        layout: (dimension?: { width: number; height: number }) => {
          layoutCalls.push(dimension)
        },
        setModel: () => undefined,
        updateOptions: () => undefined,
        dispose: () => undefined,
      }),
    },
  }),
}))

/** 覆写容器的实测尺寸（happy-dom 下 clientWidth / clientHeight 恒为 0）。 */
function setContainerSize(
  element: HTMLElement,
  width: number,
  height: number,
): void {
  Object.defineProperty(element, 'clientWidth', {
    value: width,
    configurable: true,
  })
  Object.defineProperty(element, 'clientHeight', {
    value: height,
    configurable: true,
  })
}

/**
 * 挂载组件并等待 Monaco 异步加载完成（onMounted 内 `await import`）。
 * @returns 挂载结果与编辑器容器元素。
 * @throws 不抛出异常。
 */
async function mountEditor() {
  const wrapper = mount(CodeDiffEditor, {
    props: { original: 'const a = 1\n', modified: 'const a = 2\n' },
  })
  await flushPromises()
  await flushPromises()

  const container = wrapper.find('.diff-editor').element as HTMLElement
  return { wrapper, container }
}

describe('CodeDiffEditor 布局（v13 空白框缺陷回归）', () => {
  beforeEach(() => {
    layoutCalls.length = 0
    resizeCallback = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resizeCallback = callback
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
  })

  it('重排时把容器实测尺寸显式传给 layout（不得无参自量）', async () => {
    const { wrapper, container } = await mountEditor()
    layoutCalls.length = 0

    // 模拟「重新展开」：容器恢复真实尺寸，ResizeObserver 触发重排。
    setContainerSize(container, 818, 318)
    resizeCallback?.()

    expect(layoutCalls).toEqual([{ width: 818, height: 318 }])
    wrapper.unmount()
  })

  it('容器不可见（尺寸为 0）时跳过重排，避免把 0 尺寸写回根节点', async () => {
    const { wrapper, container } = await mountEditor()
    layoutCalls.length = 0

    setContainerSize(container, 0, 0)
    resizeCallback?.()

    expect(layoutCalls).toEqual([])
    wrapper.unmount()
  })

  it('高度为 0 而宽度非 0 时同样跳过（任一边为 0 即不可见）', async () => {
    const { wrapper, container } = await mountEditor()
    layoutCalls.length = 0

    setContainerSize(container, 818, 0)
    resizeCallback?.()

    expect(layoutCalls).toEqual([])
    wrapper.unmount()
  })
})
