/**
 * 工作区执行工具工厂。
 *
 * 本模块基于 pi-agent-core 的公开工具工厂创建 bash、read、write、edit 工具，
 * 并将它们绑定到指定工作区，供当前项目使用普通 AgentTool[] 的 Agent 运行时调用。
 *
 * v11 扩展（技术方案 §5.4 / §6.3）：
 *   - `blockedReadPaths`：命中名单的文件（如 env.json）读取直接拒绝（A3 全场景禁读）；
 *   - bash 经 bash-guard 危险清单装饰：命中清单的命令拒绝执行但不终止会话（D11）；
 *   - `shellPath`：显式指定 bash 可执行文件路径（CLI 启动时探测注入），
 *     缺省时由 pi-agent-core 按平台默认规则探测。
 */

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentTool,
  type ExecutionToolContext,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isDangerousBashCommand } from '../guards/bash-guard'
import { bindExecutionTool } from './adapters/bind-execution-tool'

/** 工具集合的可选管控项。 */
export interface IWorkspaceExecutionToolsOptions {
  /**
   * 禁止读取的文件名（按路径解析后的 basename 小写比较，覆盖任意相对/绝对写法）。
   * 命中时 read 工具直接返回拒绝结果（不终止会话轮次）。
   */
  blockedReadPaths?: readonly string[]
  /** 是否对 bash 启用危险命令清单拦截；缺省启用（生成守卫侧由工具守卫另行放行白名单）。 */
  enforceBashGuard?: boolean
  /**
   * bash 可执行文件的绝对路径（如 Git Bash 的 bash.exe）。
   * 缺省时由 NodeExecutionEnv 按平台默认规则探测（Windows 上依赖
   * Git Bash 安装位置或 PATH，探测不到会导致 bash 工具不可用）。
   */
  shellPath?: string
}

/**
 * 创建绑定到指定工作目录的 pi-agent-core 内置执行工具集合。
 *
 * @param workspaceCwd - Agent 的工作目录；工具的相对文件路径和 Shell 命令默认以此目录解析。
 * @param options - 可选的读取拦截名单、bash 管控开关与 bash 可执行文件路径。
 * @returns 可直接放入 IAgentBaseConfig.tools 的 bash、read、write、edit 工具数组。
 * @throws {Error} 当工作目录为空，或后续工具执行出现参数校验、文件系统、命令执行、
 * 超时或取消异常时，会抛出相应异常。
 *
 * @remarks workspaceCwd 只决定默认工作目录，并不构成安全沙箱。若请求来自不可信用户，
 * 调用方必须在运行环境、路径访问与命令执行层面额外实施隔离和授权。
 */
export function createWorkspaceExecutionTools(
  workspaceCwd: string,
  options: IWorkspaceExecutionToolsOptions = {},
): AgentTool<any>[] {
  if (workspaceCwd.trim().length === 0) {
    throw new Error('workspaceCwd 不能为空')
  }

  const blockedReadPaths = options.blockedReadPaths ?? []
  const enforceBashGuard = options.enforceBashGuard ?? true

  // 每个工具集合使用独立环境，确保会话间不会错误共享工作目录；
  // shellPath 显式指定 bash 路径，避免运行时探测失败导致 bash 工具不可用；
  // shellEnv 把 bash 自身与伴随工具目录前置进 PATH，确保非交互 bash
  // （-c 模式不加载 profile）在父进程 PATH 缺少 Unix 工具时仍能执行 ls/grep 等。
  const context: ExecutionToolContext = {
    env: new NodeExecutionEnv({
      cwd: workspaceCwd,
      shellPath: options.shellPath,
      shellEnv: buildShellEnv(options.shellPath),
    }),
  }

  // 统一适配内置 AgentHarnessTool，使其兼容项目的普通 AgentTool[] 配置。
  const tools = [
    bindExecutionTool(createBashTool(), context),
    bindExecutionTool(createReadTool(), context),
    bindExecutionTool(createWriteTool(), context),
    bindExecutionTool(createEditTool(), context),
  ]

  return tools.map((tool) => {
    // bash 危险清单：命中即拒绝执行，返回拒绝文本让 Agent 调整方式重试（不终止轮次）。
    // 传入 workspaceCwd：命令里出现**工作区内**的绝对路径属正常写法，不该被判为越界。
    if (tool.name === 'bash' && enforceBashGuard) {
      return decorateBashTool(tool, workspaceCwd)
    }

    // 读取拦截：值级敏感文件（env.json）在全场景下拒绝读取（A3）。
    if (tool.name === 'read' && blockedReadPaths.length > 0) {
      return decorateReadTool(tool, workspaceCwd, blockedReadPaths)
    }

    return tool
  })
}

/**
 * 为 bash 工具挂载危险命令清单判定。
 *
 * @param tool - 已绑定上下文的 bash 工具。
 * @param workspaceCwd - 工作目录：用于区分「工作区内的绝对路径」（放行）
 *   与「工作区外的绝对路径」（拒绝）。
 * @returns 带危险清单拦截的 bash 工具。
 * @throws 不抛出异常。
 */
function decorateBashTool(
  tool: AgentTool<any>,
  workspaceCwd: string,
): AgentTool<any> {
  const { execute, ...definition } = tool

  return {
    ...definition,
    async execute(toolCallId, parameters, signal, onUpdate) {
      const command = extractCommandText(parameters)

      if (isDangerousBashCommand(command ?? '', workspaceCwd)) {
        return {
          content: [
            {
              type: 'text',
              text: `命令命中危险清单，已拒绝执行：${command ?? '（无法解析命令文本）'}。请改用更安全的方式完成任务，不要尝试规避清单。`,
            },
          ],
        } as Awaited<ReturnType<typeof execute>>
      }

      return execute(toolCallId, parameters, signal, onUpdate)
    },
  }
}

/**
 * 为 read 工具挂载禁读名单判定（basename 大小写不敏感比较）。
 *
 * @param tool - 已绑定上下文的 read 工具。
 * @param workspaceCwd - 工作目录（相对路径据此解析）。
 * @param blockedReadPaths - 禁止读取的文件名列表。
 * @returns 带禁读拦截的 read 工具。
 * @throws 不抛出异常。
 */
function decorateReadTool(
  tool: AgentTool<any>,
  workspaceCwd: string,
  blockedReadPaths: readonly string[],
): AgentTool<any> {
  const { execute, ...definition } = tool
  const blocked = new Set(blockedReadPaths.map((name) => name.toLowerCase()))

  return {
    ...definition,
    async execute(toolCallId, parameters, signal, onUpdate) {
      const requestedPath = extractPathText(parameters)

      if (
        requestedPath &&
        isBlockedReadPath(workspaceCwd, requestedPath, blocked)
      ) {
        return {
          content: [
            {
              type: 'text',
              text: `${requestedPath} 保存敏感数据真实值，任何场景下都不允许读取；请仅依据用例数据中的 ${'${ENV:KEY}'} 引用工作。`,
            },
          ],
        } as Awaited<ReturnType<typeof execute>>
      }

      return execute(toolCallId, parameters, signal, onUpdate)
    },
  }
}

/** 从工具参数中提取命令文本（兼容 command / cmd 字段名）。 */
function extractCommandText(parameters: unknown): string | undefined {
  const record = asRecord(parameters)
  const command = record?.command ?? record?.cmd
  return typeof command === 'string' ? command : undefined
}

/** 从工具参数中提取路径文本（兼容 path / file_path / filePath 字段名）。 */
function extractPathText(parameters: unknown): string | undefined {
  const record = asRecord(parameters)
  const path = record?.path ?? record?.file_path ?? record?.filePath
  return typeof path === 'string' ? path : undefined
}

/**
 * 判定请求路径是否命中禁读名单：按路径解析后的文件名（小写）比较，
 * 覆盖 `env.json`、`ENV.JSON` 等变体与任意相对 / 绝对写法。
 */
function isBlockedReadPath(
  workspaceCwd: string,
  requestedPath: string,
  blocked: ReadonlySet<string>,
): boolean {
  try {
    const basename = path.basename(path.resolve(workspaceCwd, requestedPath))
    return blocked.has(basename.toLowerCase())
  } catch {
    // 解析失败按未命中处理：工具自身的路径校验仍会兜底。
    return false
  }
}

/** 将未知参数安全转换为键值对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 由 bash 可执行文件位置推导应前置进 PATH 的伴随工具目录。
 *
 * bash 自身所在目录含有 ls/grep/sed 等核心 Unix 工具；若位置符合
 * Git for Windows 布局（`<root>\usr\bin\bash.exe` 或 `<root>\bin\bash.exe`），
 * 额外补充 mingw64\bin、cmd、bin 等 Git 伴随目录，使命令行为与正常
 * Git Bash 会话一致。
 *
 * @param shellPath - bash 可执行文件绝对路径；正斜杠会归一为反斜杠。
 * @returns 应前置到 PATH 的目录数组（去重、保持优先级顺序）；无法推导
 *   Git 布局时仅含 bash 自身目录。
 * @throws 不抛出异常。
 */
export function deriveShellPathPrepend(shellPath: string): string[] {
  // 统一为反斜杠做形态判断；Windows 路径大小写不敏感，按小写匹配后缀。
  const normalizedPath = shellPath.replace(/\//g, '\\')
  const bashDir = path.dirname(normalizedPath)
  const additions = [bashDir]

  const lowerBashDir = bashDir.toLowerCase()
  const gitRoot = lowerBashDir.endsWith('\\usr\\bin')
    ? normalizedPath.slice(
        0,
        normalizedPath.length - '\\usr\\bin\\bash.exe'.length,
      )
    : lowerBashDir.endsWith('\\bin')
      ? normalizedPath.slice(
          0,
          normalizedPath.length - '\\bin\\bash.exe'.length,
        )
      : undefined

  if (gitRoot) {
    additions.push(
      path.join(gitRoot, 'mingw64', 'bin'),
      path.join(gitRoot, 'cmd'),
      path.join(gitRoot, 'bin'),
    )
  }

  // 去重（usr\bin 与 bin 形态推导出的 gitRoot\bin 会重复）。
  return [...new Set(additions)]
}

/**
 * 依据 bash 可执行文件位置构造 shell 附加环境变量。
 *
 * 把 bash 及其伴随工具目录前置到 PATH（仅保留真实存在的目录），使
 * 非交互 bash 继承的父进程 PATH 缺少 Unix 工具时命令依然可用。
 *
 * @param shellPath - bash 可执行文件绝对路径；未指定时返回 undefined
 *   （不修改环境，维持 NodeExecutionEnv 默认行为）。
 * @returns 含前置 PATH 的环境变量对象；无需修改时返回 undefined。
 * @throws 不抛出异常。
 */
function buildShellEnv(
  shellPath: string | undefined,
): Record<string, string> | undefined {
  if (!shellPath || shellPath.trim().length === 0) {
    return undefined
  }

  const existingPath = process.env.PATH ?? ''
  const lowerExistingPath = existingPath.toLowerCase()
  // 只保留真实存在的目录，且避免把已在 PATH 中的目录重复前置。
  const additions = deriveShellPathPrepend(shellPath).filter(
    (directory) =>
      existsSync(directory) &&
      !lowerExistingPath.includes(directory.toLowerCase()),
  )

  return {
    PATH: [...additions, existingPath]
      .filter((part) => part.length > 0)
      .join(path.delimiter),
  }
}
