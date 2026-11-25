// 目录选择器状态机测试：验证加载、导航、初始路径降级与新建文件夹行为。
import type { IDirectoryListing } from '@authine-e2e-agent/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../src/services/http-client'
import { useDirectoryBrowser } from '../../src/modules/configuration/composables/useDirectoryBrowser'

const fetchDirectoryListing = vi.hoisted(() => vi.fn())
const fetchBrowseRoots = vi.hoisted(() => vi.fn())
const createDirectory = vi.hoisted(() => vi.fn())

vi.mock('../../src/modules/configuration/services/directory-api', () => ({
  fetchDirectoryListing,
  fetchBrowseRoots,
  createDirectory,
}))

/**
 * 构造目录浏览响应数据。
 * @param currentPath 当前目录路径。
 * @param overrides 需要覆盖的字段。
 * @returns 完整的目录浏览响应数据。
 * @throws 不抛出异常。
 */
function buildListing(
  currentPath: string,
  overrides: Partial<IDirectoryListing> = {},
): IDirectoryListing {
  return {
    currentPath,
    parentPath: null,
    rootPath: '/',
    directories: [],
    truncated: false,
    currentEmpty: true,
    currentWritable: true,
    ...overrides,
  }
}

/**
 * 构造目录不存在的 API 异常。
 * @returns 携带 DIRECTORY_NOT_FOUND 错误码的客户端异常。
 * @throws 不抛出异常。
 */
function buildNotFoundError(): ApiClientError {
  return new ApiClientError({
    message: '目录不存在。',
    status: 404,
    code: 'DIRECTORY_NOT_FOUND',
  })
}

describe('useDirectoryBrowser', () => {
  beforeEach(() => {
    fetchDirectoryListing.mockReset()
    fetchBrowseRoots.mockReset()
    createDirectory.mockReset()
    fetchBrowseRoots.mockResolvedValue({
      success: true,
      data: { roots: ['/home/tester'] },
    })
  })

  it('loads the listing for the requested path', async () => {
    fetchDirectoryListing.mockResolvedValue({
      success: true,
      data: buildListing('/home/tester/workspace'),
    })

    const browser = useDirectoryBrowser()
    await browser.navigateTo('/home/tester/workspace')

    expect(fetchDirectoryListing).toHaveBeenCalledWith({
      path: '/home/tester/workspace',
    })
    expect(browser.currentListing.value?.currentPath).toBe(
      '/home/tester/workspace',
    )
    expect(browser.errorMessage.value).toBe('')
    expect(browser.loading.value).toBe(false)
  })

  it('exposes the failure message and code when loading fails', async () => {
    fetchDirectoryListing.mockRejectedValue(buildNotFoundError())

    const browser = useDirectoryBrowser()
    await browser.navigateTo('/missing')

    expect(browser.currentListing.value).toBeNull()
    expect(browser.errorMessage.value).toBe('目录不存在。')
    expect(browser.errorCode.value).toBe('DIRECTORY_NOT_FOUND')
    expect(browser.loading.value).toBe(false)
  })

  it('opens the selected path when it is available', async () => {
    fetchDirectoryListing.mockResolvedValue({
      success: true,
      data: buildListing('/home/tester/current'),
    })

    const browser = useDirectoryBrowser()
    await browser.open('/home/tester/current')

    expect(fetchDirectoryListing).toHaveBeenCalledTimes(1)
    expect(browser.currentListing.value?.currentPath).toBe(
      '/home/tester/current',
    )
  })

  it('falls back to the first browse root when the selected path is missing', async () => {
    fetchDirectoryListing
      .mockRejectedValueOnce(buildNotFoundError())
      .mockResolvedValueOnce({
        success: true,
        data: buildListing('/home/tester'),
      })

    const browser = useDirectoryBrowser()
    await browser.open('/deleted/workspace')

    expect(browser.currentListing.value?.currentPath).toBe('/home/tester')
    expect(browser.errorMessage.value).toContain('已切换到可访问的起始目录。')
  })

  it('opens the browse root when no initial path is provided', async () => {
    fetchDirectoryListing.mockResolvedValue({
      success: true,
      data: buildListing('/home/tester'),
    })

    const browser = useDirectoryBrowser()
    await browser.open()

    expect(fetchDirectoryListing).toHaveBeenCalledWith({ path: '/home/tester' })
  })

  it('navigates to the parent directory', async () => {
    fetchDirectoryListing.mockResolvedValueOnce({
      success: true,
      data: buildListing('/home/tester/workspace', {
        parentPath: '/home/tester',
      }),
    })

    const browser = useDirectoryBrowser()
    await browser.navigateTo('/home/tester/workspace')

    fetchDirectoryListing.mockResolvedValueOnce({
      success: true,
      data: buildListing('/home/tester'),
    })
    await browser.navigateUp()

    expect(browser.currentListing.value?.currentPath).toBe('/home/tester')
  })

  it('does not navigate up from a file system root', async () => {
    fetchDirectoryListing.mockResolvedValueOnce({
      success: true,
      data: buildListing('/', { parentPath: null }),
    })

    const browser = useDirectoryBrowser()
    await browser.navigateTo('/')
    await browser.navigateUp()

    expect(fetchDirectoryListing).toHaveBeenCalledTimes(1)
  })

  it('exposes the file system root for the current path', async () => {
    fetchDirectoryListing.mockResolvedValueOnce({
      success: true,
      data: buildListing('D:\\a\\b\\c', { rootPath: 'D:\\' }),
    })

    const browser = useDirectoryBrowser()
    await browser.navigateTo('D:\\a\\b\\c')

    expect(browser.currentListing.value?.rootPath).toBe('D:\\')
  })

  it('refreshes the current directory', async () => {
    fetchDirectoryListing.mockResolvedValue({
      success: true,
      data: buildListing('/home/tester'),
    })

    const browser = useDirectoryBrowser()
    await browser.navigateTo('/home/tester')
    await browser.refresh()

    expect(fetchDirectoryListing).toHaveBeenCalledTimes(2)
  })

  it('creates a folder and navigates into it', async () => {
    fetchDirectoryListing.mockResolvedValueOnce({
      success: true,
      data: buildListing('/home/tester'),
    })

    const browser = useDirectoryBrowser()
    await browser.navigateTo('/home/tester')

    createDirectory.mockResolvedValue({
      success: true,
      data: { absolutePath: '/home/tester/new-folder' },
    })
    fetchDirectoryListing.mockResolvedValueOnce({
      success: true,
      data: buildListing('/home/tester/new-folder'),
    })

    const created = await browser.createFolder('new-folder')

    expect(created).toBe(true)
    expect(createDirectory).toHaveBeenCalledWith({
      parentPath: '/home/tester',
      name: 'new-folder',
    })
    expect(browser.currentListing.value?.currentPath).toBe(
      '/home/tester/new-folder',
    )
  })

  it('reports a failure when creating a folder fails', async () => {
    fetchDirectoryListing.mockResolvedValueOnce({
      success: true,
      data: buildListing('/home/tester'),
    })

    const browser = useDirectoryBrowser()
    await browser.navigateTo('/home/tester')

    createDirectory.mockRejectedValue(
      new ApiClientError({
        message: '该目录已存在，请换一个名称。',
        status: 409,
        code: 'DIRECTORY_ALREADY_EXISTS',
      }),
    )

    const created = await browser.createFolder('duplicate')

    expect(created).toBe(false)
    expect(browser.errorMessage.value).toBe('该目录已存在，请换一个名称。')
    expect(browser.errorCode.value).toBe('DIRECTORY_ALREADY_EXISTS')
    expect(browser.currentListing.value?.currentPath).toBe('/home/tester')
  })

  it('does not create a folder without a current directory', async () => {
    const browser = useDirectoryBrowser()
    const created = await browser.createFolder('new-folder')

    expect(created).toBe(false)
    expect(createDirectory).not.toHaveBeenCalled()
  })
})
