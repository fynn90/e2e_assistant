import {
  resolvePreviewImageMimeType,
  type ISkillFileTreeNode,
} from '@authine-e2e-agent/types'
import type { TreeOption } from 'naive-ui'

export interface ISkillTreeOption extends TreeOption {
  key: string
  label: string
  node: ISkillFileTreeNode
  children?: ISkillTreeOption[]
  disabled?: boolean
}

/**
 * 提取文件名的小写扩展名（含前导点）。
 *
 * 不引入 `node:path`：浏览器端没有该模块，且此处只需处理文件树节点的
 * 单段文件名（不含目录），无需完整路径语义。无扩展名或点开头（如 `.gitignore`）
 * 一律返回空串，交由调用方按「无扩展名」处理。
 *
 * @param fileName 文件名（不含目录）。
 * @returns 形如 `.png` 的小写扩展名；不存在时返回空串。
 * @throws 不抛出异常。
 */
function extractExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

/**
 * 判断文件树节点是否为可直接预览的图片（v13）。
 *
 * 复用与服务端同一份扩展名清单（`PREVIEWABLE_IMAGE_MIME_TYPES`），
 * 避免前后端各自维护一份「什么算图片」而逐渐分叉。
 *
 * @param node 文件树节点。
 * @returns 是文件且扩展名为可预览图片格式时返回 true。
 * @throws 不抛出异常。
 */
export function isPreviewableImageNode(node: ISkillFileTreeNode): boolean {
  return (
    node.kind === 'file' &&
    resolvePreviewImageMimeType(extractExtension(node.name)) !== undefined
  )
}

/** 判断相对路径是否为报告视图入口文件（`test_report/<runId>/report.html`）。 */
function isReportHtmlPath(relativePath: string): boolean {
  return (
    relativePath.startsWith('test_report/') &&
    relativePath.endsWith('/report.html')
  )
}

/** 报告运行时间戳目录名规则，与 skill-manager 的 runId 白名单一致。 */
const REPORT_RUN_ID_PATTERN = /^\d{8}-\d{6}$/

/**
 * 从报告文件的相对路径中解析运行时间戳。
 *
 * @param relativePath - 形如 `test_report/<runId>/report.html` 的相对路径。
 * @returns 合法的 runId；格式不符时返回 undefined。
 * @throws 不抛出异常。
 */
function parseReportRunId(relativePath: string): string | undefined {
  const runId = relativePath.split('/')[1] ?? ''
  return REPORT_RUN_ID_PATTERN.test(runId) ? runId : undefined
}

/**
 * 文件树点击后应打开的目标类型。
 *
 * 调用方据此导航；把「点击后去哪」这一决策抽成纯函数，是为了让**优先级**
 * 可被单测覆盖——该优先级曾因图片分流被放在 `test_report/` 分支之后，
 * 导致报告附件（`attachment-*.png`）被拦成「请在报告中查看」而打不开。
 */
export type TSkillFileOpenTarget =
  /** 可预览图片：进入图片预览面板（任意目录，含 test_report/ 下的附件）。 */
  | { type: 'image'; relativePath: string }
  /** 报告入口：进入报告视图。 */
  | { type: 'report'; runId: string }
  /** 结构化 E2E 用例：进入用例面板。 */
  | { type: 'e2e-test-case' }
  /** 普通文件：进入代码面板。 */
  | { type: 'code'; relativePath: string }
  /** 不支持预览，且需要给出提示的节点（目前仅报告目录下的非图片附件）。 */
  | { type: 'notice'; message: string }

/**
 * 解析文件树节点点击后的打开目标。
 *
 * **优先级（顺序即语义，改动需同步测试）**：
 *   1. **可预览图片**——必须最先判定。报告附件也落在 `test_report/` 下，
 *      若排在报告分支之后会被拦成「请在报告中查看」，图片永远打不开。
 *   2. 报告入口 `report.html`——送至报告视图（`.html` 不是图片，不受第 1 条影响）。
 *   3. 报告目录下的其余不支持节点——提示改去报告中查看（如压缩包附件）。
 *   4. `e2e_schema.json`——送至结构化用例面板。
 *   5. 其余——送至代码面板。
 *
 * @param node - 被点击的文件树节点。
 * @returns 打开目标；节点不是文件时返回 undefined。
 * @throws 不抛出异常。
 */
export function resolveSkillFileOpenTarget(
  node: ISkillFileTreeNode,
): TSkillFileOpenTarget | undefined {
  if (node.kind !== 'file') return undefined

  // 1. 图片优先，任意目录（含 test_report/）都走图片预览。
  if (isPreviewableImageNode(node)) {
    return { type: 'image', relativePath: node.relativePath }
  }

  if (node.relativePath.startsWith('test_report/')) {
    // 2. 报告入口 → 报告视图。
    if (isReportHtmlPath(node.relativePath)) {
      const runId = parseReportRunId(node.relativePath)
      return runId ? { type: 'report', runId } : undefined
    }

    // 3. 其余附件（压缩包等）→ 只给提示，不设独立预览。
    if (node.openability === 'known_unsupported') {
      return { type: 'notice', message: '附件请在报告中查看' }
    }
  }

  // 4. 结构化用例。
  if (node.relativePath === 'e2e_schema.json') {
    return { type: 'e2e-test-case' }
  }

  // 5. 其余文本文件 → 代码面板。
  return { type: 'code', relativePath: node.relativePath }
}

/**
 * 「当前打开的文件已从磁盘消失」时的处理决策。
 *
 * 抽出为纯函数以便单测——这段逻辑有两个易错点：
 *   1. **未保存内容必须保留**（PRD v4 §8.2）：不论是否静默，都转只读缓冲区供复制；
 *   2. **用户主动删除时不该再提示**「文件已不存在」：调用方刚告知过删除成功，
 *      再报一次是误报（该提示本是给外部删除用的）。
 */
export type TMissingOpenFileAction =
  /** 文件有未保存修改：转只读缓冲区，内容保留供用户复制。 */
  | { type: 'preserve-orphan' }
  /** 文件无未保存修改，且非用户主动删除：清空并提示「文件已不存在」。 */
  | { type: 'clear-and-notice' }
  /** 文件无未保存修改，且是用户主动删除：静默清空，导航交由调用方接续。 */
  | { type: 'clear-silently' }

/**
 * 决定「当前打开的文件已不存在」时该怎么做。
 *
 * @param options.hasUnsavedChanges - 当前打开文件是否有未保存修改。
 * @param options.userInitiated - 是否由用户主动删除触发（静默模式）。
 * @returns 处理动作。
 * @throws 不抛出异常。
 */
export function resolveMissingOpenFileAction(options: {
  hasUnsavedChanges: boolean
  userInitiated: boolean
}): TMissingOpenFileAction {
  // 未保存内容优先于一切：先保住用户的内容，再谈提示与否。
  if (options.hasUnsavedChanges) {
    return { type: 'preserve-orphan' }
  }

  return options.userInitiated
    ? { type: 'clear-silently' }
    : { type: 'clear-and-notice' }
}

/**
 * 把文件树节点转换为 naive-ui 树选项。
 *
 * 二进制文件通常禁用（文本编辑器打不开），但两类例外保留可点击：
 *   - v11：`test_report/` 下的附件——点击时由 openFile 提示「附件请在报告中查看」，
 *     保留可点击才能给出提示；
 *   - v13：**可预览的图片**——点击时进入图片预览面板。此前图片在树中是
 *     灰掉的死节点（用户看得见却点不开），这是本次放开的针对性问题。
 *
 * @param nodes 当前层级文件树节点。
 * @returns 树组件选项。
 * @throws 不抛出异常。
 */
export function toTreeOptions(nodes: ISkillFileTreeNode[]): ISkillTreeOption[] {
  return nodes.map((node) => ({
    key: node.relativePath,
    label: node.name,
    node,
    disabled:
      node.kind === 'file' &&
      node.openability === 'known_unsupported' &&
      !node.relativePath.startsWith('test_report/') &&
      !isPreviewableImageNode(node),
    children:
      node.kind === 'directory' ? toTreeOptions(node.children) : undefined,
  }))
}
