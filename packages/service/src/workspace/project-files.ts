import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { IProjectFileItem } from '@fynn90-e2e_assistant/types'

interface IListProjectFilesOptions {
  rootDirectory: string
  maxDepth?: number
  maxItems?: number
}

/**
 * 读取项目目录下的文件结构，用于欢迎页展示当前项目内容。
 * @param options 文件读取参数。
 * @returns 扁平化后的文件列表。
 */
export async function listProjectFiles (
  options: IListProjectFilesOptions,
): Promise<IProjectFileItem[]> {
  const collectedFileItems: IProjectFileItem[] = []
  const maxDepth = options.maxDepth ?? 5
  const maxItems = options.maxItems ?? 200

  await walkDirectory({
    rootDirectory: options.rootDirectory,
    currentDirectory: options.rootDirectory,
    depth: 0,
    maxDepth,
    maxItems,
    collectedFileItems,
  })

  return collectedFileItems
}

interface IWalkDirectoryOptions {
  rootDirectory: string
  currentDirectory: string
  depth: number
  maxDepth: number
  maxItems: number
  collectedFileItems: IProjectFileItem[]
}

/**
 * 递归遍历目录，并在达到数量或深度上限时及时停止。
 * @param options 当前递归层级的遍历参数。
 * @returns 遍历完成后无返回值。
 */
async function walkDirectory (options: IWalkDirectoryOptions): Promise<void> {
  if (
    options.depth > options.maxDepth ||
    options.collectedFileItems.length >= options.maxItems
  ) {
    return
  }

  const directoryEntries = await readdir(options.currentDirectory, {
    withFileTypes: true,
  })
  const sortedEntries = directoryEntries
    .filter((directoryEntry) => directoryEntry.name !== '.DS_Store')
    .sort((leftEntry, rightEntry) =>
      leftEntry.name.localeCompare(rightEntry.name),
    )

  for (const directoryEntry of sortedEntries) {
    if (options.collectedFileItems.length >= options.maxItems) {
      break
    }

    const absoluteEntryPath = path.join(
      options.currentDirectory,
      directoryEntry.name,
    )
    const relativeEntryPath =
      path.relative(options.rootDirectory, absoluteEntryPath) || '.'
    const nextFileItem: IProjectFileItem = {
      relativePath: relativeEntryPath,
      name: directoryEntry.name,
      kind: directoryEntry.isDirectory() ? 'directory' : 'file',
      depth: options.depth,
    }

    options.collectedFileItems.push(nextFileItem)

    if (directoryEntry.isDirectory()) {
      await walkDirectory({
        ...options,
        currentDirectory: absoluteEntryPath,
        depth: options.depth + 1,
      })
    }
  }
}
