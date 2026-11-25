/**
 * 提供 E2E 流程中通过目录选择弹窗设定项目目录的复用步骤。
 */
import type { Page } from '@playwright/test'

/**
 * 通过目录选择弹窗选择已存在的项目目录。
 *
 * 流程：打开弹窗 → 在地址栏跳转到父目录 → 点击目标子目录 → 确认选择。
 *
 * @param page Playwright 页面对象。
 * @param options 目标目录绝对路径与父目录绝对路径。
 * @returns 选择流程完成后无返回值。
 * @throws 当弹窗元素缺失或点击目标不可用时由 Playwright 抛出异常。
 */
export async function selectProjectDirectory(
  page: Page,
  options: { parentDirectory: string; directoryName: string },
): Promise<void> {
  await page.getByRole('button', { name: '选择目录' }).click()
  await page.getByLabel('目录路径').fill(options.parentDirectory)
  await page.getByRole('button', { name: '跳转' }).click()
  await page
    .getByRole('button', { name: options.directoryName, exact: true })
    .click()
  await page.getByRole('button', { name: '选择此目录' }).click()
}

/**
 * 通过目录选择弹窗的「新建文件夹」创建并选择项目目录。
 *
 * 适用于目标目录尚不存在的场景，覆盖「选择器不再支持手填不存在路径」后的等价能力。
 *
 * @param page Playwright 页面对象。
 * @param options 父目录绝对路径与待创建目录名称。
 * @returns 创建并选择流程完成后无返回值。
 * @throws 当弹窗元素缺失或创建失败时由 Playwright 抛出异常。
 */
export async function createAndSelectProjectDirectory(
  page: Page,
  options: { parentDirectory: string; directoryName: string },
): Promise<void> {
  await page.getByRole('button', { name: '选择目录' }).click()
  await page.getByLabel('目录路径').fill(options.parentDirectory)
  await page.getByRole('button', { name: '跳转' }).click()
  await page.getByRole('button', { name: '新建文件夹' }).click()
  await page.getByPlaceholder('新文件夹名称').fill(options.directoryName)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: '选择此目录' }).click()
}
