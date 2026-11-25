/**
 * Authine E2E Agent 配置工厂：服务于**单个 e2e SKILL 内部**的会话
 * （SKILL.md 生成、脚本生成、Skill Chat）。
 *
 * 本模块负责组合 E2E 系统提示词、系统技能和绑定到调用方工作区的工具集合，
 * 以便为每个 Agent 会话创建独立且可执行的配置。
 *
 * 与工作台的分工（v16）：本 Agent 的生存环境是「目录已被选定、要产出该用例的
 * 文档与脚本」；面向整个工作区、需要先定位再执行的对话由
 * `workbench-agent.ts` 承担，两者按 `AgentOperateType` 分派（见 factory.ts）。
 * 本模块**不含**任何工作台判断。
 */

import {
  formatSkillsForSystemPrompt,
  type AgentTool,
} from '@earendil-works/pi-agent-core'
import prompt from '../prompt'
import { resourceLoader } from '../resourceLoader'
import {
  createBrowserClickTool,
  createBrowserNavigateTool,
  createBrowserQueryTool,
  createBrowserScreenshotTool,
  createBrowserCaptureBaselineTool,
  createBrowserFillTool,
  createBrowserSelectTool,
  createBrowserListFramesTool,
  createBrowserSnapshotTool,
  createBrowserWaitForTool,
  createLoadSkillTool,
  createTodoWriteTool,
  createWorkspaceExecutionTools,
} from '../tools'
import { createSessionAskTools } from '../tools/ask-user-question'
import { browserSessionRegistry } from '../tools/browser/browser-session-registry'
import { SKILL_ENV_FILE_NAME } from '@charlie_deng/e2e-assistant-types'
import type { IAgentBaseConfig } from './types'

// 加载系统技能并格式化为模型可见的技能区块，避免在每次创建配置时重复处理静态资源。
// `test_script_execution` 不在此列：它服务于「执行整个工作区里的某个用例」，
// 那是工作台 Agent 的场景（见 workbench-agent.ts）。
const skillsBlock = formatSkillsForSystemPrompt([
  resourceLoader.getSkill('e2e_test_case'),
  resourceLoader.getSkill('test_case_Skill_document'),
  resourceLoader.getSkill('playwright_script_generation'),
])

/** 系统提示词各区块之间使用的空行分隔符，确保模型可清晰识别区块边界。 */
const PROMPT_SECTION_SEPARATOR = '\n\n'

/**
 * 系统 Skill 的按需加载约定。
 *
 * 标题和正文以独立区块声明，便于后续单独扩充或调整约定内容。
 */
const skillLoadingConvention = [
  '## Skill 加载约定',
  '当任务匹配上方列出的系统 Skill 时，调用 `load_skill` 并传入对应的 Skill 名称，先加载完整指令再执行任务。Skill 列表中的 location 是打包资源的虚拟定位信息，不保证对应文件存在于当前工作区；不要使用 `read` 工具直接读取该 location。',
].join(PROMPT_SECTION_SEPARATOR)

/**
 * 系统提示词的静态区块，按模型读取所需的语义顺序排列。
 *
 * 新增或调整静态提示词时，只需维护对应区块及其在此列表中的位置。
 */
const systemPromptSections = [
  prompt['authineE2E-agent'] as string,
  skillsBlock,
  skillLoadingConvention,
] as const

// 静态区块组合后不随会话变化，可在模块初始化时复用。
const systemPrompt = systemPromptSections.join(PROMPT_SECTION_SEPARATOR)

/**
 * 创建绑定到指定工作区的 Authine E2E Agent 配置。
 *
 * @param workspaceCwd - 当前 Agent 会话的工作目录，作为文件操作和 Shell 命令的默认解析根目录。
 * @param dateTime - 当前 Agent 会话的时间戳，用于在系统提示词中注入时间上下文。
 * @param sessionId - 当前会话 ID；用于查询该会话是否被授予浏览器访问权限（v7 页面核对）。
 * @param extraTools - 额外追加的工具（v11：Skill Chat 场景注入 execute_test 等）；
 *   缺省不追加。
 * @param shellPath - bash 可执行文件绝对路径（CLI 启动时探测注入）；缺省由
 *   NodeExecutionEnv 按平台默认规则探测。
 * @returns 包含系统提示词、load_skill、bash/read/write/edit 工具的 Agent 基础配置；
 * 仅当该会话已登记浏览器宿主时，额外包含 browser_navigate/snapshot/query 与
 * browser_click/select/waitFor/screenshot 工具。
 * @throws {Error} 当 workspaceCwd 为空，或工具在后续执行时发生文件系统、命令执行、
 * 参数校验、资源解析、资源不存在或取消异常时，会抛出相应异常。
 */
export function createAuthineE2EAgentConfig (
  workspaceCwd: string,
  dateTime: string,
  sessionId?: string,
  extraTools?: AgentTool<any>[],
  shellPath?: string,
): IAgentBaseConfig {
  // 根据当前会话工作区创建独立工具上下文，避免跨会话复用 cwd；
  // 同时把工作区路径注入系统提示词，确保 Agent 的读写都限定在正确目录内。
  // env.json 在全场景下禁读（v11 A3），由 blockedReadPaths 结构性拦截。
  return {
    systemPrompt: systemPrompt
      .replace('{workspace}', workspaceCwd)
      .replace('{dateTime}', dateTime),
    tools: [
      createLoadSkillTool(),
      // 多步骤任务清单（v12-pre）：不读写文件、不访问页面，故对所有场景开放，
      // 让用户在任何任务里都能看到 Agent 的步骤计划与进度。
      createTodoWriteTool(),
      ...createWorkspaceExecutionTools(workspaceCwd, {
        blockedReadPaths: [SKILL_ENV_FILE_NAME],
        ...(shellPath ? { shellPath } : {}),
      }),
      // 浏览器工具按会话授权注入（PRD 4.2 / 15.2）：
      // 只有「生成 Playwright 脚本」任务会登记宿主，普通 Chat 与 SKILL.md 生成
      // 不会拿到浏览器工具，避免 Agent 在无授权场景访问目标页面。
      ...createSessionBrowserTools(sessionId),
      // v14：AskUserQuestion 发问工具按会话授权注入（与浏览器宿主同构的注册表接缝）。
      // 只有登记了 ask host 的生成会话才获得提问能力；未授权场景返回空数组。
      ...createSessionAskTools(sessionId),
      ...(extraTools ?? []),
    ],
  }
}

/**
 * 按会话 ID 解析浏览器工具集合。
 *
 * @param sessionId - 当前会话 ID；未提供或未登记宿主时返回空数组。
 * @returns 已授权会话对应的浏览器工具；未授权时返回空数组。
 * @throws 不抛出异常。
 */
function createSessionBrowserTools (
  sessionId: string | undefined,
): AgentTool<any>[] {
  if (!sessionId) {
    return []
  }

  const host = browserSessionRegistry.get(sessionId)
  return host
    ? [
      createBrowserNavigateTool(host),
      createBrowserListFramesTool(host),
      createBrowserSnapshotTool(host),
      createBrowserQueryTool(host),
      // v12-pre：交互与视觉核对能力。点击/选择用于触发「交互后才出现」的元素，
      // waitFor 等待其出现，screenshot 用于确认视觉呈现（模型需具备 vision 能力）。
      createBrowserClickTool(host),
      createBrowserSelectTool(host),
      // v20：填入能力。与 select 相邻，因为两者是同一层「先输入再提交」的交互；
      // 敏感数据以 ${ENV:KEY} 引用填入，真值由宿主在填入前解析（凭据代理）。
      createBrowserFillTool(host),
      createBrowserWaitForTool(host),
      createBrowserScreenshotTool(host),
      // v12：视觉基线捕获。产出「新旧 DOM 对比」的基准图片（落盘到 baselines/），
      // 供执行期脚本用 toMatchSnapshot 比对。这是浏览器工具唯一的枚举点。
      createBrowserCaptureBaselineTool(host),
    ]
    : []
}
