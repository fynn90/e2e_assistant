/**
 * Agent 配置与操作类型定义。
 *
 * 本模块集中维护 Agent 创建和调度所需的通用类型，避免业务 Agent 与工具实现相互耦合。
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'

/**
 * Agent 支持的操作类型：决定本会话由哪个 Agent 配置承载（见 factory.ts）。
 *
 * `chat`      —— **单个 e2e SKILL 内部**的会话：SKILL.md 生成、脚本生成、
 *                Skill Chat。目录已选定，任务是产出该用例的文档与脚本。
 * `workbench` —— **`/agent` 工作台**：面向整个工作区的对话，用户尚未指明
 *                是哪个用例，任务是先定位（检索 + 唯一 ID 指代）再执行或生成。
 *
 * 两者的系统提示词与工具集**不同源**，因此必须在创建期就分开——
 * 这也让「某个能力只属于哪个场景」在类型层面可查，而不是散在运行时的分支里。
 */
export type AgentOperateType = 'chat' | 'workbench'

/**
 * 工作台会话的能力装配（由 CLI 组合根在创建会话前装配）。
 *
 * 与浏览器/发问那两个注册表接缝的差异：那两者是「基础设施层在会话创建过程中
 * 异步登记宿主」，消费侧要按 sessionId 去查；工作台能力在会话创建时**已经
 * 装配完毕**，直接随创建参数传入即可，少一层间接。
 */
export interface IWorkbenchAgentAssembly {
  /** 工作台规则区块（三态匹配、唯一 ID 指代、不得臆测、缺口推进）。 */
  systemPromptSection: string
  /** 工作台专有工具（list_skills / read_skill_document / propose_action / execute_test）。 */
  tools: AgentTool<any>[]
  /** 会话的工具守卫（PRD SEC-1 权限矩阵），由调用方装配到 plugins。 */
  toolGuard: import('../harness/interfaces').IToolGuard
}

/**
 * Agent 的基础运行配置。
 *
 * @property systemPrompt - 注入模型上下文的系统提示词。
 * @property tools - 当前 Agent 可调用的普通工具列表；工具必须实现 AgentTool 的四参数 execute 签名。
 */
export interface IAgentBaseConfig {
  systemPrompt: string
  tools: AgentTool<any>[]
}
