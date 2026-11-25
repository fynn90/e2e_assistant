import { access, lstat, readdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import type {
  ISkillDirectoryTreeNode,
  ISkillFileTreeNode,
} from '@authine-e2e-agent/types'
import {
  KNOWN_BINARY_EXTENSIONS,
  KNOWN_TEXT_EXTENSIONS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TREE_DEPTH,
  MAX_SKILL_TREE_NODES,
  SKILL_MANIFEST_FILE_NAME,
  TEMP_DIRECTORY_NAME,
  USER_WORKSPACE_DIRECTORY_NAME,
} from './constants'
import { resolveSkill } from './detail'
import { ensureEnvFile } from './env-file'
import { isFileSystemPermissionError, SkillManagerError } from './errors'
import type { ISkillStorageOptions } from './storage'
import {
  ensureUserWorkSpace,
  type TUserWorkspaceStatus,
} from './user-workspace'

// temp 是 Agent 工作期间的临时工作区（候选脚本、探查截图等中间内容），
// 不属于正式 Skill 产物，因此不在文件树中展示（v7 PRD 4.4 / AC-05）；
// 目录本身由 temp-workspace 在任务终态负责清理，探查截图随之消失、无需单独隐藏。
const IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  TEMP_DIRECTORY_NAME,
])

export async function listSkillFiles(
  options: ISkillStorageOptions,
  skillId: string,
): Promise<ISkillFileTreeNode[]> {
  const resolvedSkill = await resolveSkill(options, skillId)
  // v10：读取文件树时保障 env.json 存在（PRD 4.1 存量补建）。
  // 与 getSkillDetail 的补建双入口互为幂等兜底：Web 首屏并行请求详情与文件树，
  // 任一方先到都能完成补建，保证「打开 Skill 后文件树中立即可见 env.json」。
  // 补建失败内部降级、不抛出，不影响文件树返回。
  await ensureEnvFile(options, skillId)
  // v14（W8）：读取文件树时幂等补建 userWorkSpace（存量 Skill）。
  // silent 模式：补建失败不抛出，状态用于节点标注与占位兜底（W20）。
  const workspaceStatus = await ensureUserWorkSpace(options, skillId, 'silent')
  const state = { nodeCount: 0 }

  try {
    const nodes = await scanDirectory({
      skillRoot: resolvedSkill.skillRoot,
      directoryPath: resolvedSkill.skillRoot,
      relativeDirectoryPath: '',
      depth: 0,
      state,
    })
    return annotateWorkspaceNodes(nodes, workspaceStatus)
  } catch (error) {
    if (error instanceof SkillManagerError) {
      throw error
    }

    if (isFileSystemPermissionError(error)) {
      throw new SkillManagerError(
        'SKILL_PERMISSION_DENIED',
        '没有权限读取 Skill 目录。',
        error,
      )
    }

    throw error
  }
}

/**
 * 对扫描结果做 userWorkSpace 节点标注与占位兜底（v14 W20-W22）。
 *
 * 三种情形：
 *   - 扫描到该节点（目录或被同名文件占用的文件节点）→ 加 `protection`；
 *   - 节点存在且补建状态为 ready-degraded → 附 `notice` 说明不可写原因；
 *   - 扫描结果中没有该节点（补建失败的只读/权限场景）→ 注入合成目录节点
 *     （空 children + protection + notice），保证「空状态也有明确节点或占位提示」。
 * 合成节点仅在「扫描无该节点」时注入，真实节点出现即消失（无双源闪烁）。
 *
 * @param nodes - 扫描得到的节点列表。
 * @param status - ensureUserWorkSpace 的探测/补建状态。
 * @returns 标注后的节点列表。
 * @throws 不抛出异常。
 */
function annotateWorkspaceNodes(
  nodes: ISkillFileTreeNode[],
  status: TUserWorkspaceStatus,
): ISkillFileTreeNode[] {
  const notice = status.state === 'ready' ? undefined : status.issue.message
  const existing = nodes.find(
    (node) =>
      node.relativePath.toLowerCase() ===
      USER_WORKSPACE_DIRECTORY_NAME.toLowerCase(),
  )

  if (existing) {
    // protection/notice 是「受保护根」语义，与节点 kind 无关：
    //   - 正常目录节点 → 标记后前端隐藏删除按钮、渲染锁定图标（W21）；
    //   - 被同名文件占用的文件节点（W10 边缘场景）→ 同样标记，否则前端会
    //     为其渲染删除按钮（点击必被服务端拒，属 UX 不一致，缺陷 B）。
    // 两个分支的节点类型都声明了 protection/notice，赋值对二者对称生效。
    existing.protection = 'user-workspace-root'
    if (notice) existing.notice = notice
    return nodes
  }

  // 扫描无该节点（补建失败的只读/权限场景）：注入合成占位目录节点，
  // 按目录优先 + 名称序插回排序位置（与 scanDirectory 的排序口径一致）。
  const synthetic: ISkillDirectoryTreeNode = {
    kind: 'directory',
    name: USER_WORKSPACE_DIRECTORY_NAME,
    relativePath: USER_WORKSPACE_DIRECTORY_NAME,
    children: [],
    protection: 'user-workspace-root',
    ...(notice ? { notice } : {}),
  }

  const insertIndex = nodes.findIndex((node) => {
    if (node.kind === 'file') return true
    return node.name.toLowerCase() > USER_WORKSPACE_DIRECTORY_NAME.toLowerCase()
  })

  if (insertIndex === -1) {
    return [...nodes, synthetic]
  }
  nodes.splice(insertIndex, 0, synthetic)
  return nodes
}

interface IScanDirectoryOptions {
  skillRoot: string
  directoryPath: string
  relativeDirectoryPath: string
  depth: number
  state: { nodeCount: number }
}

async function scanDirectory(
  options: IScanDirectoryOptions,
): Promise<ISkillFileTreeNode[]> {
  if (options.depth > MAX_SKILL_TREE_DEPTH) {
    throw new SkillManagerError(
      'TREE_TOO_LARGE',
      'Skill 文件树超过最大目录深度。',
    )
  }

  const directoryEntries = await readdir(options.directoryPath, {
    withFileTypes: true,
  })
  const visibleEntries = directoryEntries.filter(
    (entry) => !shouldIgnoreEntry(entry.name),
  )
  const sortedEntries = visibleEntries.sort(compareDirectoryEntries)
  const nodes: ISkillFileTreeNode[] = []

  for (const entry of sortedEntries) {
    const absoluteEntryPath = path.join(options.directoryPath, entry.name)
    const entryStat = await lstat(absoluteEntryPath)

    if (
      entryStat.isSymbolicLink() ||
      entry.name.includes('\\') ||
      entry.name.includes(':')
    ) {
      continue
    }

    options.state.nodeCount += 1

    if (options.state.nodeCount > MAX_SKILL_TREE_NODES) {
      throw new SkillManagerError(
        'TREE_TOO_LARGE',
        'Skill 文件树节点数量超过限制。',
      )
    }

    const relativePath = options.relativeDirectoryPath
      ? `${options.relativeDirectoryPath}/${entry.name}`
      : entry.name

    if (entryStat.isDirectory()) {
      nodes.push({
        kind: 'directory',
        name: entry.name,
        relativePath,
        children: await scanDirectory({
          ...options,
          directoryPath: absoluteEntryPath,
          relativeDirectoryPath: relativePath,
          depth: options.depth + 1,
        }),
      })
      continue
    }

    if (!entryStat.isFile()) {
      continue
    }

    const extension = path.extname(entry.name).toLowerCase()
    const tooLarge = entryStat.size > MAX_SKILL_FILE_BYTES
    const hardLinked = entryStat.nlink > 1
    const knownBinary = KNOWN_BINARY_EXTENSIONS.has(extension)
    let writable = true

    try {
      await access(absoluteEntryPath, fsConstants.W_OK)
    } catch {
      writable = false
    }

    const isManifest =
      entry.name.toLocaleLowerCase('en-US') === SKILL_MANIFEST_FILE_NAME
    const disabledReason = tooLarge
      ? 'too_large'
      : hardLinked
        ? 'hard_link'
        : knownBinary
          ? 'unsupported'
          : undefined
    const openability = disabledReason
      ? 'known_unsupported'
      : KNOWN_TEXT_EXTENSIONS.has(extension) || isManifest
        ? 'known_text'
        : 'unchecked'

    nodes.push({
      kind: 'file',
      name: entry.name,
      relativePath,
      size: entryStat.size,
      openability,
      readOnly: isManifest || hardLinked || !writable,
      disabledReason,
    })
  }

  return nodes
}

function shouldIgnoreEntry(name: string): boolean {
  return (
    IGNORED_NAMES.has(name) ||
    name.startsWith('.') ||
    name.endsWith('.lock') ||
    name.includes('.authine-tmp-')
  )
}

function compareDirectoryEntries(
  leftEntry: { name: string; isDirectory(): boolean },
  rightEntry: { name: string; isDirectory(): boolean },
): number {
  if (leftEntry.isDirectory() !== rightEntry.isDirectory()) {
    return leftEntry.isDirectory() ? -1 : 1
  }

  if (leftEntry.name === rightEntry.name) {
    return 0
  }

  return leftEntry.name < rightEntry.name ? -1 : 1
}
