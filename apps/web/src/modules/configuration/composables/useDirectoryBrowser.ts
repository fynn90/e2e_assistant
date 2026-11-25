/**
 * 提供目录选择器的导航状态机：加载目录、进入子目录、返回上一级、新建文件夹。
 */
import { ref, type Ref } from 'vue'
import type { IDirectoryListing } from '@charlie_deng/e2e-assistant-types'
import { ApiClientError } from '../../../services/http-client'
import {
  createDirectory,
  fetchBrowseRoots,
  fetchDirectoryListing,
} from '../services/directory-api'

/**
 * 目录选择器的导航状态与操作集合。
 */
export interface IUseDirectoryBrowserResult {
  /** 当前目录的浏览结果；尚未加载完成时为 null。 */
  currentListing: Ref<IDirectoryListing | null>
  /** 是否正在加载目录内容。 */
  loading: Ref<boolean>
  /** 加载失败时的用户可读错误信息。 */
  errorMessage: Ref<string>
  /** 加载失败时的稳定错误码，用于区分目录不存在与其他失败。 */
  errorCode: Ref<string>
  /** 可用的浏览起始位置（Windows 为盘符，其他平台为家目录）。 */
  browseRoots: Ref<string[]>
  /** 打开选择器并定位到初始目录。 */
  open: (initialPath?: string) => Promise<void>
  /** 跳转到指定目录。 */
  navigateTo: (directoryPath: string) => Promise<void>
  /** 返回上一级目录。 */
  navigateUp: () => Promise<void>
  /** 重新加载当前目录。 */
  refresh: () => Promise<void>
  /** 在当前目录下新建文件夹。 */
  createFolder: (name: string) => Promise<boolean>
}

/**
 * 创建目录选择器导航状态机。
 * @returns 目录导航状态与操作集合。
 * @throws 不抛出异常，请求失败会写入 errorMessage。
 */
export function useDirectoryBrowser (): IUseDirectoryBrowserResult {
  const currentListing = ref<IDirectoryListing | null>(null)
  const loading = ref(false)
  const errorMessage = ref('')
  const errorCode = ref('')
  const browseRoots = ref<string[]>([])

  /**
   * 打开选择器并定位到初始目录。
   *
   * 初始目录不存在时自动降级到浏览起始位置并提示原因，
   * 避免用户为了修正一个失效路径而打开的弹窗直接停留在错误态。
   *
   * @param initialPath 期望打开的初始目录路径。
   * @returns 加载流程完成后无返回值。
   * @throws 不抛出异常。
   */
  async function open (initialPath?: string): Promise<void> {
    errorMessage.value = ''
    errorCode.value = ''

    await loadBrowseRoots()
    const fallbackPath = browseRoots.value[0]
    const targetPath = initialPath?.trim() || fallbackPath

    if (!targetPath) {
      errorMessage.value = '无法确定可浏览的起始目录。'
      return
    }

    const loaded = await loadDirectory(targetPath)

    if (loaded || !fallbackPath || targetPath === fallbackPath) {
      return
    }

    // 初始路径失效时降级到起始位置，并保留提示说明为何没有停在原路径。
    const previousError = errorMessage.value
    const fallbackLoaded = await loadDirectory(fallbackPath)

    if (fallbackLoaded) {
      errorMessage.value = `${previousError} 已切换到可访问的起始目录。`
    }
  }

  /**
   * 跳转到指定目录。
   * @param directoryPath 目标目录绝对路径。
   * @returns 加载流程完成后无返回值。
   * @throws 不抛出异常，失败原因写入 errorMessage。
   */
  async function navigateTo (directoryPath: string): Promise<void> {
    errorMessage.value = ''
    errorCode.value = ''
    await loadDirectory(directoryPath)
  }

  /**
   * 返回上一级目录。
   * @returns 加载流程完成后无返回值。
   * @throws 不抛出异常，已是根目录时不做任何操作。
   */
  async function navigateUp (): Promise<void> {
    const parentPath = currentListing.value?.parentPath

    if (!parentPath) {
      return
    }

    await navigateTo(parentPath)
  }

  /**
   * 重新加载当前目录。
   * @returns 加载流程完成后无返回值。
   * @throws 不抛出异常，失败原因写入 errorMessage。
   */
  async function refresh (): Promise<void> {
    const currentPath = currentListing.value?.currentPath

    if (!currentPath) {
      return
    }

    await navigateTo(currentPath)
  }

  /**
   * 在当前目录下新建文件夹，并跳转到新建结果。
   * @param name 新建目录名称。
   * @returns 新建并跳转成功时返回 true，否则返回 false。
   * @throws 不抛出异常，失败原因写入 errorMessage。
   */
  async function createFolder (name: string): Promise<boolean> {
    const currentPath = currentListing.value?.currentPath

    if (!currentPath) {
      return false
    }

    errorMessage.value = ''
    errorCode.value = ''

    try {
      const response = await createDirectory({ parentPath: currentPath, name })
      await loadDirectory(response.data.absolutePath)
      return true
    } catch (error) {
      errorMessage.value = toDirectoryErrorMessage(
        error,
        '新建文件夹失败，请稍后重试。',
      )
      errorCode.value = toDirectoryErrorCode(error)
      return false
    }
  }

  /**
   * 加载浏览起始位置集合。
   * @returns 加载流程完成后无返回值。
   * @throws 不抛出异常，失败时保留空集合由调用方兜底。
   */
  async function loadBrowseRoots (): Promise<void> {
    if (browseRoots.value.length > 0) {
      return
    }

    try {
      const response = await fetchBrowseRoots()
      browseRoots.value = response.data.roots
    } catch {
      // 起始位置仅用于快捷入口与兜底，加载失败不阻断用户输入路径浏览。
      browseRoots.value = []
    }
  }

  /**
   * 加载指定目录并更新当前浏览结果。
   * @param directoryPath 目标目录绝对路径。
   * @returns 加载成功时返回 true，失败时返回 false。
   * @throws 不抛出异常，失败原因写入 errorMessage。
   */
  async function loadDirectory (directoryPath: string): Promise<boolean> {
    loading.value = true

    try {
      const response = await fetchDirectoryListing({ path: directoryPath })
      currentListing.value = response.data
      return true
    } catch (error) {
      currentListing.value = null
      errorMessage.value = toDirectoryErrorMessage(
        error,
        '加载目录失败，请稍后重试。',
      )
      errorCode.value = toDirectoryErrorCode(error)
      return false
    } finally {
      loading.value = false
    }
  }

  return {
    currentListing,
    loading,
    errorMessage,
    errorCode,
    browseRoots,
    open,
    navigateTo,
    navigateUp,
    refresh,
    createFolder,
  }
}

/**
 * 将未知异常转换为目录选择器可展示的错误文案。
 * @param error 待转换的未知异常。
 * @param fallback 无法识别异常时使用的兜底文案。
 * @returns 用户可读的错误文案。
 * @throws 不抛出异常。
 */
function toDirectoryErrorMessage (error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

/**
 * 从异常中提取稳定错误码。
 * @param error 待解析的未知异常。
 * @returns 错误码文本；无法识别时返回空字符串。
 * @throws 不抛出异常。
 */
function toDirectoryErrorCode (error: unknown): string {
  return error instanceof ApiClientError ? (error.code ?? '') : ''
}
