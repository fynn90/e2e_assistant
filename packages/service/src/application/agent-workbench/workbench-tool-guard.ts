/**
 * Agent 工作台的工具守卫（v16，v17 扩工作台工具矩阵）：落实 PRD SEC-1 的文件权限矩阵。
 *
 * 与生成任务的守卫（`createGenerationWriteGuard`）**不复用**（v16 §9.6 决策 D1）：
 * 两者的语义不同——生成守卫是「读工作区 + 只写唯一目标文件」的一次性任务边界，
 * 工作台守卫是「长期会话的常驻权限边界」，允许写工作区内的多个文件
 * （`userWorkSpace/**`、`SKILL.md`、`test.spec.ts`），并额外拦截
 * `manifest.json` / `e2e_schema.json` / `skill.list.json` 的写入。
 *
 * 共用的部分（路径归一判定、敏感文件名清单）抽在
 * `application/shared/path-guard.ts`，避免两处各写一遍而分叉。
 *
 * 判定表（PRD §7.1）：
 * | 工具 | 判定 |
 * | --- | --- |
 * | `load_skill` / `todo_write` / `ask_user_question` | 放行（无文件副作用） |
 * | 工作台能力工具（检索 / 视图 / 体检 / 提案 / 执行） | 放行（不直接接收文件路径，边界由宿主校验） |
 * | `read` | 路径须在工作区内，且 basename ≠ `env.json` |
 * | `write` / `edit` | 路径须在工作区内；basename 不得命中平台维护文件 |
 * | `bash` | 命中危险清单或受保护文件的写模式 → 拒绝（不终止本轮，尽力而为） |
 * | 其余 | 阻断并终止本轮（越权工具意味着偏离任务） |
 *
 * 阻断文案会作为工具结果进入模型上下文，因此**不得点名任何内部工具名**。
 */

import {
  isDangerousBashCommand,
  type IToolGuard,
} from '@fynn90-e2e_assistant/agent'
import {
  BLOCKED_READ_FILE_NAMES,
  PROTECTED_WRITE_FILE_NAMES,
  isPathInsideWorkspace,
  isPathWithFileNameIn,
} from '../../shared/path-guard'

/**
 * 不直接接收工作区路径、由平台宿主校验边界的工具：直接放行。
 *
 * 判定依据是「工具本身有没有文件路径副作用」，而不是「工具是否属于工作台」——
 * 这些工具只把唯一 ID 或渲染选择交给宿主，由宿主在平台一侧解析目标并校验
 * 权限，因此守卫不需要也不应该再拦一次。
 *
 * 易漏项提示：工作台工具矩阵扩容时，只要工具落到下方兜底分支，就会连同本轮
 * 对话一起终止。本集合必须覆盖 `assembleWorkbenchCapability` 实际装配的全部
 * 工具；回归测试会直接取装配结果逐项调用守卫，漏一个就失败。
 */
const SIDE_EFFECT_FREE_TOOLS: ReadonlySet<string> = new Set([
  // 通用能力（由 workbench-agent 装配）。
  'load_skill',
  'todo_write',
  'ask_user_question',
  // v16 检索、动作与执行：目标由宿主按唯一 ID 解析（PRD ID-3/ID-4）。
  'list_skills',
  'read_skill_document',
  'propose_action',
  'execute_test',
  // v17 问询、体检、视图、提案与连续执行：同样是宿主校验边界。
  'read_test_case',
  'read_run_history',
  'check_readiness',
  'render_view',
  'propose_case_change',
  'propose_case_repair',
  'propose_env_fill',
  'propose_report_cleanup',
  'propose_case_deletion',
  'execute_batch',
])

/** 工作台守卫的构造选项。 */
export interface IAgentWorkbenchGuardOptions {
  /** 守卫标识。 */
  id: string
  /** 工作区根目录：所有读写的边界。 */
  workspace: string
  /** 越权工具被阻断时的提示文案。 */
  blockedToolReason: string
}

/**
 * 创建 Agent 工作台的工具守卫。
 *
 * @param options - 守卫标识、工作区与越权提示文案。
 * @returns 工具调用前守卫：按 PRD SEC-1 的权限矩阵逐类判定。
 * @throws 不抛出异常；不符合边界的调用以阻断结果返回，由 Agent 循环处理。
 */
export function createAgentWorkbenchGuard (
  options: IAgentWorkbenchGuardOptions,
): IToolGuard {
  const workspace = options.workspace

  return {
    id: options.id,
    async beforeCall (toolCall) {
      const args = asRecord(toolCall.args)

      // 无副作用的工具直接放行：它们不读写工作区文件，
      // 对 SEC-1 的边界没有任何影响。
      if (SIDE_EFFECT_FREE_TOOLS.has(toolCall.name)) {
        return undefined
      }

      if (toolCall.name === 'read') {
        return guardRead(workspace, args)
      }

      if (toolCall.name === 'write' || toolCall.name === 'edit') {
        return guardWrite(workspace, args)
      }

      if (toolCall.name === 'bash') {
        return guardBash(workspace, args)
      }

      // 其余工具：工作台会话不应使用（如浏览器工具未注入），
      // 出现即意味着偏离任务，阻断并终止本轮。
      return {
        block: true,
        terminate: true,
        reason: options.blockedToolReason,
      }
    },
  }
}

/**
 * 校验读操作：路径须在工作区内，且不得命中值级敏感文件。
 *
 * @param workspace - 工作区根目录。
 * @param args - 工具参数。
 * @returns 阻断结果；合法时返回 undefined（放行）。
 * @throws 不抛出异常。
 */
function guardRead (
  workspace: string,
  args: Record<string, unknown> | undefined,
): { block: true; reason: string } | undefined {
  if (!isPathInsideWorkspace(workspace, args?.path)) {
    // 越界读不终止本轮：让 Agent 自行改用工作区内路径继续完成任务。
    return {
      block: true,
      reason: '只能访问工作区内的文件，工作区之外的路径不可读写。',
    }
  }

  if (isPathWithFileNameIn(workspace, args?.path, BLOCKED_READ_FILE_NAMES)) {
    return {
      block: true,
      reason:
        'env.json 保存敏感数据真实值，任何场景下都不可读；请仅依据用例数据中的 ${ENV:KEY} 引用工作。',
    }
  }

  return undefined
}

/**
 * 校验写操作：路径须在工作区内，且不得命中平台维护的文件。
 *
 * @param workspace - 工作区根目录。
 * @param args - 工具参数。
 * @returns 阻断结果；合法时返回 undefined（放行）。
 * @throws 不抛出异常。
 */
function guardWrite (
  workspace: string,
  args: Record<string, unknown> | undefined,
): { block: true; reason: string } | undefined {
  const requestedPath = args?.path ?? args?.file_path

  if (!isPathInsideWorkspace(workspace, requestedPath)) {
    // 与越界读同策略：拒绝但不终止，Agent 把路径改到工作区内即可自修复。
    return {
      block: true,
      reason: '只能写入工作区内的文件，工作区之外的路径不可读写。',
    }
  }

  if (
    isPathWithFileNameIn(workspace, requestedPath, PROTECTED_WRITE_FILE_NAMES)
  ) {
    return {
      block: true,
      reason:
        '该文件由平台维护（保存用例身份与结构化数据），不允许直接修改；如需改动请走对应的平台功能。',
    }
  }

  return undefined
}

/**
 * 校验 bash 命令：危险清单 + 受保护文件的访问模式。
 *
 * 强度如实说明（PRD R12 / §6.2.1）：bash 是**命令文本的静态判定**，
 * `cd` 变换目录、变量拼接、编码混淆存在理论绕过面，因此这里的边界是
 * **尽力而为**；对 `read` / `write` / `edit` 的判定才是结构性强制。
 * 判定实现见 agent 包的 `bash-guard`（生成守卫与本守卫共用同一清单）。
 *
 * @param workspace - 工作区根目录：命令里的工作区内绝对路径放行，工作区外拒绝。
 * @param args - 工具参数。
 * @returns 阻断结果；合法时返回 undefined（放行）。
 * @throws 不抛出异常。
 */
function guardBash (
  workspace: string,
  args: Record<string, unknown> | undefined,
): { block: true; reason: string } | undefined {
  const command = typeof args?.command === 'string' ? args.command : undefined

  if (isDangerousBashCommand(command ?? '', workspace)) {
    return {
      block: true,
      reason:
        '命令命中受限清单（危险操作、敏感文件访问或平台维护文件的写入），已拒绝执行；请改用平台提供的功能或更安全的方式完成任务，不要尝试规避清单。',
    }
  }

  return undefined
}

/** 将未知参数安全转换为键值对象。 */
function asRecord (value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
