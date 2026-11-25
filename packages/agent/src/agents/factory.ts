/**
 * Agent 配置工厂：按操作类型把会话分派到对应的 Agent 配置。
 *
 * v16 起有两个 Agent，各自的生存环境不同（见 `types.ts` 的 `AgentOperateType`）：
 *   - `chat`      → `authineE2E-agent`：单个 e2e SKILL 内部（生成、Skill Chat）；
 *   - `workbench` → `workbench-agent`：`/agent` 工作台，面向整个工作区。
 *
 * 「按类型分派」正是工厂的职责：调用方（任务运行器）只声明「这是哪类会话」，
 * 不需要知道该类型由哪个模块实现、要装哪些工具。新增第三个 Agent 时，
 * 只在这里加一条分支——而不是在某个 Agent 内部加 `if`。
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createAuthineE2EAgentConfig } from './authineE2E-agent'
import { createWorkbenchAgentConfig } from './workbench-agent'
import type {
  AgentOperateType,
  IAgentBaseConfig,
  IWorkbenchAgentAssembly,
} from './types'

/**
 * 根据操作类型和工作区创建 Agent 配置。
 *
 * @param operateType - 会话的操作类型：'chat'（SKILL 内）或 'workbench'（工作台）。
 * @param workSpace - 当前 Agent 会话的工作目录。
 * @param sessionId - 当前会话 ID；用于按会话授权注入浏览器/发问工具。
 * @param extraTools - 额外追加的工具（v11：Skill Chat 场景注入 execute_test 等）。
 * @param shellPath - bash 可执行文件绝对路径（CLI 启动时探测注入）；缺省自行探测。
 * @param workbench - 工作台会话的能力装配；`operateType` 为 'workbench' 时必填。
 * @returns 包含系统提示词和工具列表的 Agent 基础配置。
 * @throws {Error} 当操作类型不支持、工作台装配缺失或工作目录为空时抛出。
 */
export function AgentFactory(
  operateType: AgentOperateType,
  workSpace: string,
  sessionId?: string,
  extraTools?: AgentTool<any>[],
  shellPath?: string,
  workbench?: IWorkbenchAgentAssembly,
): IAgentBaseConfig {
  switch (operateType) {
    case 'workbench': {
      // 装配缺失是编排缺陷（工作台会话必须有检索/执行/动作工具与规则提示词），
      // 在创建期就暴露，而不是让模型在一个没有工具的会话里空转。
      if (!workbench) {
        throw new Error('工作台会话缺少能力装配（capability）。')
      }
      return createWorkbenchAgentConfig(
        workSpace,
        new Date().toISOString(),
        sessionId,
        {
          systemPromptSection: workbench.systemPromptSection,
          tools: workbench.tools,
        },
        shellPath,
      )
    }

    case 'chat':
    default:
      return createAuthineE2EAgentConfig(
        workSpace,
        new Date().toISOString(),
        sessionId,
        extraTools,
        shellPath,
      )
  }
}

export default AgentFactory
