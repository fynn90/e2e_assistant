/**
 * 管理 Skill 文件树的桌面宽度、响应式抽屉和键盘焦点恢复。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  useTemplateRef,
} from 'vue'

const EXPLORER_WIDTH_KEY = 'authine.skill-explorer-width'
const MOBILE_QUERY = '(max-width: 760px)'
const MIN_EXPLORER_WIDTH = 220
const DEFAULT_EXPLORER_WIDTH = 280

/**
 * 创建 Skill 文件树的响应式布局状态和交互动作。
 * @returns 桌面宽度、移动抽屉状态、触发按钮引用和交互方法。
 * @throws 访问被禁用的 localStorage 时可能由浏览器抛出异常。
 */
export function useSkillExplorerLayout() {
  const mobileMedia = window.matchMedia(MOBILE_QUERY)
  const isMobile = shallowRef(mobileMedia.matches)
  const viewportWidth = shallowRef(window.innerWidth)
  const explorerWidth = shallowRef(loadExplorerWidth())
  const maximumExplorerWidth = computed(() =>
    Math.round(Math.max(MIN_EXPLORER_WIDTH, viewportWidth.value * 0.45)),
  )
  const mobileDrawerVisible = shallowRef(false)
  const mobileExplorerTriggerRef = useTemplateRef<HTMLButtonElement>(
    'mobileExplorerTrigger',
  )
  let resizing = false
  let shouldRestoreDrawerFocus = false

  onMounted(() => {
    mobileMedia.addEventListener('change', syncMobileMode)
    window.addEventListener('resize', syncViewportWidth)
  })
  onBeforeUnmount(() => {
    mobileMedia.removeEventListener('change', syncMobileMode)
    window.removeEventListener('resize', syncViewportWidth)
    stopResize()
  })

  /**
   * 同步当前视口宽度，并保持桌面文件树宽度在可用范围内。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function syncViewportWidth(): void {
    viewportWidth.value = window.innerWidth
    if (!isMobile.value)
      explorerWidth.value = clampExplorerWidth(explorerWidth.value)
  }

  /**
   * 同步断点状态，并关闭不再适用于当前布局的移动抽屉。
   * @param event 媒体查询变化事件。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function syncMobileMode(event: MediaQueryListEvent): void {
    isMobile.value = event.matches
    syncViewportWidth()
    stopResize()
    shouldRestoreDrawerFocus = false
    mobileDrawerVisible.value = false

    if (!event.matches) {
      explorerWidth.value = loadExplorerWidth()
    }
  }

  /**
   * 打开移动文件树抽屉。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function openMobileDrawer(): void {
    shouldRestoreDrawerFocus = false
    mobileDrawerVisible.value = true
  }

  /**
   * 接收遮罩、关闭按钮或 Escape 触发的抽屉可见性变化。
   * @param visible 目标可见状态。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function updateMobileDrawerVisibility(visible: boolean): void {
    if (!visible && mobileDrawerVisible.value) {
      shouldRestoreDrawerFocus = true
    }
    mobileDrawerVisible.value = visible
  }

  /**
   * 选择文件后关闭移动抽屉，并在离场完成后恢复触发按钮焦点。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function closeMobileDrawer(): void {
    if (!mobileDrawerVisible.value) return
    shouldRestoreDrawerFocus = true
    mobileDrawerVisible.value = false
  }

  /**
   * 在抽屉离场后将键盘焦点归还给文件树触发按钮。
   * @returns 聚焦完成后兑现的 Promise。
   * @throws 不抛出异常。
   */
  async function restoreMobileTriggerFocus(): Promise<void> {
    if (!shouldRestoreDrawerFocus || !isMobile.value) return
    shouldRestoreDrawerFocus = false
    await nextTick()
    mobileExplorerTriggerRef.value?.focus()
  }

  /**
   * 开始拖拽调整桌面文件树宽度。
   * @param event 指针按下事件。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function startResize(event: PointerEvent): void {
    if (isMobile.value) return
    resizing = true
    event.currentTarget instanceof HTMLElement &&
      event.currentTarget.setPointerCapture(event.pointerId)
    window.addEventListener('pointermove', resizeExplorer)
    window.addEventListener('pointerup', stopResize, { once: true })
    window.addEventListener('pointercancel', stopResize, { once: true })
    window.addEventListener('blur', stopResize, { once: true })
  }

  /**
   * 根据指针位置更新并持久化桌面文件树宽度。
   * @param event 指针移动事件。
   * @returns 无返回值。
   * @throws localStorage 不可用时由浏览器抛出异常。
   */
  function resizeExplorer(event: PointerEvent): void {
    if (!resizing) return
    explorerWidth.value = clampExplorerWidth(event.clientX)
    localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth.value))
  }

  /**
   * 使用方向键或 Home/End 调整桌面文件树宽度。
   * @param event 分隔条键盘事件。
   * @returns 无返回值。
   * @throws localStorage 不可用时由浏览器抛出异常。
   */
  function resizeWithKeyboard(event: KeyboardEvent): void {
    let nextWidth: number | null = null

    switch (event.key) {
      case 'ArrowLeft':
        nextWidth = explorerWidth.value - 16
        break
      case 'ArrowRight':
        nextWidth = explorerWidth.value + 16
        break
      case 'Home':
        nextWidth = MIN_EXPLORER_WIDTH
        break
      case 'End':
        nextWidth = maximumExplorerWidth.value
        break
      default:
        return
    }

    event.preventDefault()
    explorerWidth.value = clampExplorerWidth(nextWidth)
    localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth.value))
  }

  /**
   * 停止文件树宽度拖拽并移除全局事件监听。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function stopResize(): void {
    resizing = false
    window.removeEventListener('pointermove', resizeExplorer)
    window.removeEventListener('pointerup', stopResize)
    window.removeEventListener('pointercancel', stopResize)
    window.removeEventListener('blur', stopResize)
  }

  return {
    isMobile,
    explorerWidth,
    maximumExplorerWidth,
    mobileDrawerVisible,
    mobileExplorerTriggerRef,
    openMobileDrawer,
    updateMobileDrawerVisibility,
    closeMobileDrawer,
    restoreMobileTriggerFocus,
    startResize,
    resizeWithKeyboard,
  }
}

/**
 * 读取并限制持久化的桌面文件树宽度。
 * @returns 可用于当前视口的文件树宽度。
 * @throws localStorage 不可用时由浏览器抛出异常。
 */
function loadExplorerWidth(): number {
  const storedValue = localStorage.getItem(EXPLORER_WIDTH_KEY)

  if (storedValue === null) {
    return clampExplorerWidth(DEFAULT_EXPLORER_WIDTH)
  }

  const storedWidth = Number(storedValue)
  return Number.isFinite(storedWidth)
    ? clampExplorerWidth(storedWidth)
    : clampExplorerWidth(DEFAULT_EXPLORER_WIDTH)
}

/**
 * 将文件树宽度限制在可用视口范围内。
 * @param width 候选宽度。
 * @returns 限制后的宽度。
 * @throws 不抛出异常。
 */
function clampExplorerWidth(width: number): number {
  const maximumWidth = Math.max(MIN_EXPLORER_WIDTH, window.innerWidth * 0.45)
  return Math.min(Math.max(width, MIN_EXPLORER_WIDTH), maximumWidth)
}
