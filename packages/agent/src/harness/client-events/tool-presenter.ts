/**
 * 工具展示映射器：把后端工具名与参数翻译为客户端可直接展示的类别与人话描述。
 *
 * 本模块是「后端工具实现 → 用户可懂描述」的唯一映射处：新增工具只需在
 * PRESENTER_RULES 登记一条规则，前端零改动。同时负责从文件类与命令类工具
 * 的参数中提取 file_change / command 事件所需的结构化信息。
 */

import type {
  TAgentFileChangeOperation,
  TAgentToolAction,
  TAgentToolCategory,
} from '@authine-e2e-agent/types'

/**
 * 工具的客户端展示信息。
 */
export interface IToolPresentation {
  /** 工具类别：客户端按类别选**配色/样式**（粗粒度分组）。 */
  category: TAgentToolCategory
  /** 工具动作：客户端按动作选**图标**（细粒度动作身份）。 */
  action: TAgentToolAction
  /** 一句话动作描述，直接展示。 */
  title: string
  /** 补充信息，如 URL、文件路径、搜索关键词。 */
  subtitle?: string
}

/**
 * 从工具参数中提取的文件变更信息。
 */
export interface IFileChangeInfo {
  /** 变更操作。 */
  operation: TAgentFileChangeOperation
  /** 工作区内相对路径。 */
  path: string
  /** rename 时的新路径（当前无工具产生，预留）。 */
  newPath?: string
}

/** 工具参数的安全读取结构（参数在翻译层一律视为 unknown 逐字段收窄）。 */
type TToolArgs = Record<string, unknown>

/** 展示规则：match 命中后按 describe 生成展示信息。 */
interface IPresenterRule {
  /** 判断该规则是否适用于指定工具。 */
  match(toolName: string): boolean
  /** 由工具名与参数生成展示信息。 */
  describe(toolName: string, args: TToolArgs): IToolPresentation
  /** 从参数提取文件变更信息；非文件变更类工具返回 undefined。 */
  fileChange?(
    args: TToolArgs,
    pathExistedBefore: boolean,
  ): IFileChangeInfo | undefined
}

/** 取参数字符串字段；非字符串返回 undefined。 */
function stringArg(args: TToolArgs, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 路径类参数的常见字段名，按优先级取值。 */
function pathArg(args: TToolArgs): string | undefined {
  return (
    stringArg(args, 'path') ??
    stringArg(args, 'file') ??
    stringArg(args, 'filePath')
  )
}

/**
 * 内置工具展示规则表。
 *
 * 当前生效工具：load_skill、bash、read、write、edit（pi-agent-core 内置）；
 * browser_* / grep / find / ls 为规划中的工具，规则先行登记，工具落地即生效。
 */
const PRESENTER_RULES: IPresenterRule[] = [
  {
    match: (name) => name === 'load_skill',
    describe: (_name, args) => ({
      category: 'skill',
      action: 'skill',
      title: '加载技能',
      subtitle: stringArg(args, 'name'),
    }),
  },
  {
    match: (name) => name === 'read',
    describe: (_name, args) => ({
      category: 'file',
      action: 'read',
      title: '读取文件',
      subtitle: pathArg(args),
    }),
  },
  {
    match: (name) => name === 'write',
    describe: (_name, args) => ({
      category: 'file',
      action: 'write',
      title: '写入文件',
      subtitle: pathArg(args),
    }),
    // write 覆盖已存在文件视为更新，否则为新建。
    fileChange: (args, pathExistedBefore) => {
      const path = pathArg(args)
      return path
        ? { operation: pathExistedBefore ? 'update' : 'create', path }
        : undefined
    },
  },
  {
    match: (name) => name === 'edit',
    describe: (_name, args) => ({
      category: 'file',
      action: 'edit',
      title: '更新文件',
      subtitle: pathArg(args),
    }),
    fileChange: (args) => {
      const path = pathArg(args)
      return path ? { operation: 'update', path } : undefined
    },
  },
  {
    match: (name) => name === 'grep',
    describe: (_name, args) => ({
      category: 'search',
      action: 'grep',
      title: '搜索内容',
      subtitle: stringArg(args, 'pattern'),
    }),
  },
  {
    match: (name) => name === 'find' || name === 'ls',
    describe: () => ({
      category: 'search',
      action: 'find',
      title: '查找文件',
    }),
  },
  {
    match: (name) => name === 'execute_test',
    describe: () => ({
      category: 'other',
      action: 'test',
      title: '执行测试用例',
    }),
  },
  // —— v16 检索工具：/agent 定位目标用例的两步（先列候选，再读文档确认） ——
  {
    match: (name) => name === 'list_skills',
    describe: () => ({
      category: 'search',
      action: 'find',
      title: '检索测试用例',
    }),
  },
  {
    match: (name) => name === 'read_skill_document',
    describe: (_name, args) => ({
      category: 'skill',
      action: 'skill',
      title: '读取用例文档',
      subtitle: stringArg(args, 'skillId'),
    }),
  },
  {
    match: (name) => name.startsWith('browser_'),
    describe: (name, args) => {
      const browserAction = browserActionOf(name)
      return {
        category: 'browser',
        action: browserAction.action,
        title: browserAction.title,
        subtitle: stringArg(args, 'url') ?? stringArg(args, 'selector'),
      }
    },
  },
]

/**
 * 浏览器动作表：**动作与标题同源**。
 *
 * 两者此前分散在两处（标题在 `browserActionTitle` 的映射表里、动作由 category
 * 粗粒度代替），导致 v7 / v12-pre 新增 8 个 browser_* 工具后标题各自区分、
 * 图标却全部塌缩成同一个地球。合并为一表后，新增浏览器动作只需在此加一行，
 * 结构上不可能再出现「标题区分了、图标没跟上」。
 */
const BROWSER_ACTIONS: Record<
  string,
  { action: TAgentToolAction; title: string }
> = {
  navigate: { action: 'navigate', title: '打开网页' },
  snapshot: { action: 'snapshot', title: '读取页面内容' },
  query: { action: 'query', title: '查询页面元素' },
  click: { action: 'click', title: '点击页面元素' },
  select: { action: 'select', title: '选择下拉项' },
  fill: { action: 'fill', title: '填入输入框' },
  waitFor: { action: 'wait', title: '等待页面状态' },
  screenshot: { action: 'screenshot', title: '页面截图' },
  capture_baseline: { action: 'baseline', title: '捕获视觉基线' },
}

/**
 * 浏览器工具名 → 动作与标题。
 *
 * @param toolName - 浏览器工具机器名（browser_ 前缀）。
 * @returns 已登记动作的 `{ action, title }`；未登记动作回退为
 *          `other` 动作 + 「浏览器操作：<动作名>」标题。
 * @throws 不抛出异常。
 */
function browserActionOf(toolName: string): {
  action: TAgentToolAction
  title: string
} {
  const action = toolName.replace(/^browser_/, '')
  return (
    BROWSER_ACTIONS[action] ?? {
      action: 'other',
      title: `浏览器操作：${action}`,
    }
  )
}

/**
 * 生成工具的客户端展示信息。
 *
 * @param toolName - 工具机器名。
 * @param args - 工具参数（unknown，逐字段收窄读取）。
 * @param toolLabel - 工具自带人类可读标签（未收录规则的兜底标题）。
 * @returns 展示类别、标题与可选补充信息。
 */
export function presentTool(
  toolName: string,
  args: unknown,
  toolLabel?: string,
): IToolPresentation {
  const safeArgs: TToolArgs =
    args !== null && typeof args === 'object' ? (args as TToolArgs) : {}
  const rule = PRESENTER_RULES.find((candidate) => candidate.match(toolName))
  if (rule) {
    return rule.describe(toolName, safeArgs)
  }
  return {
    category: 'other',
    action: 'other',
    title: toolLabel ?? toolName,
  }
}

/**
 * 判断工具是否为命令执行类（翻译为 command 事件而非 tool 事件）。
 *
 * @param toolName - 工具机器名。
 * @returns bash 类工具返回 true。
 */
export function isCommandTool(toolName: string): boolean {
  return toolName === 'bash'
}

/**
 * 提取命令执行工具的命令文本与工作目录。
 *
 * @param args - 工具参数。
 * @returns 命令文本与可选执行目录。
 */
export function extractCommand(args: unknown): {
  command: string
  cwd?: string
} {
  const safeArgs: TToolArgs =
    args !== null && typeof args === 'object' ? (args as TToolArgs) : {}
  return {
    command: stringArg(safeArgs, 'command') ?? '',
    cwd: stringArg(safeArgs, 'cwd'),
  }
}

/**
 * 从文件类工具参数提取文件变更信息。
 *
 * @param toolName - 工具机器名。
 * @param args - 工具参数。
 * @param pathExistedBefore - 目标路径在工具执行前是否已存在（write 区分新建/更新）。
 * @returns 文件变更信息；非文件变更类工具返回 undefined。
 */
export function extractFileChange(
  toolName: string,
  args: unknown,
  pathExistedBefore: boolean,
): IFileChangeInfo | undefined {
  const rule = PRESENTER_RULES.find((candidate) => candidate.match(toolName))
  const safeArgs: TToolArgs =
    args !== null && typeof args === 'object' ? (args as TToolArgs) : {}
  return rule?.fileChange?.(safeArgs, pathExistedBefore)
}
