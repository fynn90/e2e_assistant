/**
 * 生成任务的工具守卫工厂：约束 Agent 只能"读工作区 + 写唯一目标文件"。
 *
 * 平台的 SKILL.md 生成与 Playwright 脚本生成两条路径共用同一份系统提示词，
 * 因此它们的工具约束也应当同源：本模块抽出两者共有的白名单逻辑，
 * 各生成器只需声明自己的守卫 id 与额外放行的工具前缀（如浏览器工具），
 * 避免同一套规则在两个文件里各写一遍而逐渐分叉（DRY / 开闭原则）。
 *
 * 白名单约定：
 *   - `load_skill`：加载生成规则，两条路径都需要；
 *   - 额外前缀工具（由调用方声明）：如 Playwright 生成路径的 `browser_*` 页面核对工具；
 *   - `read`：只读工作区内文件，不产生副作用；
 *   - `bash`：v11 放开（技术方案 D11），但命令文本命中危险清单时拒绝执行（不终止本轮）；
 *   - `write`：只允许写入调用方指定的唯一目标文件；写错位置**拒绝但不终止本轮**
 *     （v15），提示中带上正确路径让 Agent 自行重写；
 *   - 其余工具一律阻断，并终止本轮（越权工具通常意味着 Agent 偏离了生成任务）。
 *
 * 注意：阻断原因（reason）会作为工具结果进入模型上下文，因此文案中
 * 不得点名任何内部工具名——那是 agent 包自己的实现细节，不属于应用层知识。
 */

import { resolve } from 'node:path'
import {
  isDangerousBashCommand,
  type IToolGuard,
} from '@authine-e2e-agent/agent'
import {
  BLOCKED_READ_FILE_NAMES,
  isPathInsideWorkspace,
  isPathWithFileNameIn,
} from '../../shared/path-guard'

/**
 * 生成任务守卫的构造选项。
 *
 * 两条生成路径的差异只有三处：守卫 id、是否额外放行浏览器工具、以及提示文案，
 * 因此这些由调用方传入，其余判定逻辑在本模块内统一实现。
 */
export interface IGenerationWriteGuardOptions {
  /** 守卫标识，用于区分不同生成任务的守卫实例。 */
  id: string
  /** Agent 工作区根目录：`read` 只允许读取该目录及其子目录内的文件。 */
  workspace: string
  /** 本次生成唯一允许写入的目标文件（绝对路径）。 */
  targetFile: string
  /**
   * 除公共白名单外额外放行的工具名前缀。
   *
   * Playwright 脚本生成路径传 `['browser_']`（页面核对工具不写文件，需放行）；
   * SKILL.md 生成路径传空数组，使其拿不到任何浏览器能力。
   */
  extraAllowedPrefixes?: readonly string[]
  /** 越权工具被阻断时的提示文案。 */
  blockedToolReason: string
}

/**
 * 创建生成任务的工具守卫。
 *
 * @param options - 守卫标识、工作区、唯一写入目标与两条阻断文案。
 * @returns 工具调用前守卫：放行读操作与目标写入，阻断其余工具调用。
 * @throws 不抛出异常；不符合白名单的调用以阻断结果返回，由调用方（Agent 循环）处理。
 */
export function createGenerationWriteGuard(
  options: IGenerationWriteGuardOptions,
): IToolGuard {
  const workspace = resolve(options.workspace)
  const normalizedTarget = resolve(options.targetFile)
  const extraAllowedPrefixes = options.extraAllowedPrefixes ?? []

  return {
    id: options.id,
    async beforeCall(toolCall) {
      const args = asRecord(toolCall.args)

      // load_skill 是一切生成任务的公共前置：Agent 需要先加载对应 Skill 的完整规则。
      if (toolCall.name === 'load_skill') return undefined

      // todo_write 只维护内存中的步骤清单，不读写文件、不访问页面，
      // 对生成任务的边界没有任何影响；但它是多步骤流程可见性的基础能力，
      // 因此两条生成路径都放行（否则会被下面的兜底判定终止本轮）。
      if (toolCall.name === 'todo_write') return undefined

      // v14：ask_user_question 是阻塞式提问（不读写文件、不访问页面），
      // 与 todo_write 同类；放行让 Agent 在缺少关键测试决策（如视觉基准信息）时
      // 能向用户发问。未登记 ask host 的会话拿不到该工具，这里只是守卫白名单。
      if (toolCall.name === 'ask_user_question') return undefined

      // 额外放行的工具（如浏览器核对）由调用方声明，本模块不假设其具体名称。
      if (
        extraAllowedPrefixes.some((prefix) => toolCall.name.startsWith(prefix))
      ) {
        return undefined
      }

      // read 只读且无副作用：允许 Agent 查看用例、文档与相关文件，
      // 但必须限制在工作区内，避免其读取 Skill 目录之外的内容；
      // 工作区内的值级敏感文件（env.json）同样被拒绝读取（v10 PRD 4.3）。
      if (toolCall.name === 'read') {
        if (!isPathInsideWorkspace(workspace, args?.path)) {
          // 越界读不终止本轮：让 Agent 自行改用工作区内路径继续完成任务。
          return { block: true, reason: '只允许读取工作区内的文件。' }
        }

        if (
          isPathWithFileNameIn(workspace, args?.path, BLOCKED_READ_FILE_NAMES)
        ) {
          // 命中值级敏感文件同样不终止本轮：与越界读同策略，
          // 让 Agent 改用用例数据中的 ${ENV:KEY} 引用继续任务。
          return {
            block: true,
            reason:
              'env.json 保存敏感数据真实值，生成任务不允许读取；请仅依据用例数据中的 ${ENV:KEY} 引用工作。',
          }
        }

        return undefined
      }

      // bash 放开（v11 D11）：可用，但命中危险清单的命令拒绝执行；
      // 与 Chat 侧 bash-guard 同源判定，拒绝不终止本轮，Agent 可调整方式重试。
      if (toolCall.name === 'bash') {
        const command =
          typeof args?.command === 'string' ? args.command : undefined

        if (isDangerousBashCommand(command ?? '', workspace)) {
          return {
            block: true,
            reason:
              '命令命中危险清单，已拒绝执行；请改用更安全的方式完成任务，不要尝试规避清单。',
          }
        }

        return undefined
      }

      if (toolCall.name !== 'write') {
        return {
          block: true,
          terminate: true,
          reason: options.blockedToolReason,
        }
      }

      if (!isTargetFile(workspace, args?.path, normalizedTarget)) {
        // v15：写错位置**不再终止整轮**，与上面的越界读、危险 bash 对齐。
        //
        // 终止的代价太高：一次路径笔误会连同已完成的页面核对、已生成的脚本内容
        // 一起作废；而写错路径是完全可自修复的——把正确路径告诉 Agent，它重写一次即可。
        // 越界写仍然拒绝（v14 W11 写入边界不变），只是拒绝方式从「终止」改为「提示重试」。
        return {
          block: true,
          reason: buildWriteRedirectReason(
            args?.path,
            workspace,
            normalizedTarget,
          ),
        }
      }

      return undefined
    },
  }
}

/**
 * 构造写入被拒时的提示文案，引导 Agent 用正确路径重写。
 *
 * 文案会作为工具结果进入模型上下文，因此**不得点名任何内部工具名**（与
 * {@link IGenerationWriteGuardOptions.blockedWriteReason} 同一约束），
 * 但**必须给出正确的绝对路径**——不给出目标，Agent 只能反复猜测。
 *
 * 两种情况分开措辞：越界写的修复动作是「换到工作区内」，写错位置的修复动作是
 * 「改成本次指定的那一个文件」，笼统共用一句会让模型抓不到该改什么。
 *
 * @param requestedPath - 模型给出的写入路径；非字符串视为不合法。
 * @param workspace - 已解析的工作区根目录。
 * @param target - 本次唯一允许写入的目标文件绝对路径。
 * @returns 面向模型的拒绝原因与修复指令。
 * @throws 不抛出异常。
 */
function buildWriteRedirectReason(
  requestedPath: unknown,
  workspace: string,
  target: string,
): string {
  const isOutsideWorkspace =
    typeof requestedPath !== 'string' ||
    !isPathInsideWorkspace(workspace, requestedPath)

  const head = isOutsideWorkspace
    ? '不允许写入工作区之外的位置：本次任务只允许写入下面这一个文件。'
    : '本次任务只允许写入下面这一个文件，写入位置不正确。'

  return `${head}请把完整内容重新写入该文件的绝对路径：${target}`
}

/**
 * 判断写入路径是否为本次生成指定的唯一目标文件。
 *
 * @param workspace - 已解析的工作区根目录（相对路径据此解析）。
 * @param requestedPath - 模型给出的写入路径。
 * @param normalizedTarget - 已解析的目标文件绝对路径。
 * @returns 请求路径解析后与目标文件一致时返回 true。
 * @throws 不抛出异常。
 */
function isTargetFile(
  workspace: string,
  requestedPath: unknown,
  normalizedTarget: string,
): boolean {
  return (
    typeof requestedPath === 'string' &&
    resolve(workspace, requestedPath) === normalizedTarget
  )
}

/** 将未知参数安全转换为键值对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
