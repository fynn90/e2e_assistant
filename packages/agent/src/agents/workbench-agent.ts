/**
 * Agent 工作台配置工厂（v16）：服务于 `/agent` 中与用户的对话。
 *
 * 为什么与 `authineE2E-agent` 分成两个 Agent，而不是在同一个工厂里按会话分支：
 *   两者的**职责与生存环境不同**——
 *   - `authineE2E-agent` 服务于**一个 e2e SKILL 内部**：目录已被选定，任务是
 *     「把这个用例的 SKILL.md / test.spec.ts 生成出来」。它的提示词假设
 *     「工作目录下所有子目录是用例」，工具集围绕读写单个 Skill 目录。
 *   - 本 Agent 服务于**整个工作区**：用户还没说清是哪个用例，任务是
 *     「先定位、再执行或生成」。它的提示词假设「工作区里有多个用例，要用 ID 指代」。
 *
 *   把两者塞进一个工厂、用 `workbench ? A : B` 分支，会让「SKILL 内」的提示词
 *   与工具集在运行时被悄悄改写，两个场景的边界随新增功能不断模糊——
 *   现在它们在类型层面就是两个配置来源（`AgentOperateType` 分派，见 factory.ts）。
 *
 * 装配方式：能力由调用方（CLI 组合根）经参数注入，本模块**不查询任何注册表**。
 * 这与 `authineE2E-agent` 的接缝不同——那边要按 sessionId 查浏览器/发问注册表，
 * 是因为那些宿主由基础设施层在会话创建过程中异步登记；而工作台能力在
 * 会话创建时已经装配完毕（见 CLI 的 `assembleWorkbenchCapability`），
 * 直接传进来即可，少一层间接。
 *
 * workbench-agent 应该可以支持 生成测试 脚本，支持调用测试脚本
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
import { getWorkbenchThresholdSection } from '../prompt/workbench-section'
import { renderCapabilityPromptSection } from '../prompt/sections/workbench-capabilities'
import type { IAgentBaseConfig } from './types'

/** 系统提示词各区块之间使用的空行分隔符。 */
const PROMPT_SECTION_SEPARATOR = '\n\n'

/**
 * 工作台模型可见的技能清单。
 *
 * **只登记 `test_script_execution`**（定位目标 → 发起执行 → 解读结果），
 * 其余三个技能都不给：
 *   - `e2e_test_case`、`test_case_Skill_document`、`playwright_script_generation`
 *     都是「把用例数据产出成文档/脚本」的指令，属于 SKILL 内的生成链路——
 *     在工作台上由平台编排的子会话承担（GEN-3/GEN-5）；
 *   - 若把它们交给工作台模型，模型会照着指令自己用 write/edit 产出产物，
 *     恰好绕过 GEN-5 要求的平台生成链路（白名单守卫、版本校验、诊断回传）。
 *
 * 工作台侧的生成诉求由动作卡片承接（ID-7）：模型只需如实说明缺口并给出入口，
 * 不需要知道「怎么写」。
 */
const workbenchSkillsBlock = formatSkillsForSystemPrompt([
  resourceLoader.getSkill('test_script_execution'),
])

/**
 * 技能加载约定（与 `authineE2E-agent` 同文，两处各自持有一份）。
 *
 * 刻意不抽成共享常量：这条约定描述的是「本 Agent 如何使用自己的技能清单」，
 * 两个 Agent 的清单不同、措辞将来也可能分化；抽共享会让一处改动影响另一处。
 */
const skillLoadingConvention = [
  '## Skill 加载约定',
  '当任务匹配上方列出的系统 Skill 时，调用 `load_skill` 并传入对应的 Skill 名称，先加载完整指令再执行任务。Skill 列表中的 location 是打包资源的虚拟定位信息，不保证对应文件存在于当前工作区；不要使用 `read` 工具直接读取该 location。',
].join(PROMPT_SECTION_SEPARATOR)

/** 工作台会话的能力装配（由调用方注入）。 */
export interface IWorkbenchAgentCapability {
  /**
   * 工作台规则区块（三态匹配、唯一 ID 指代、不得臆测、缺口推进）。
   *
   * 与工具同生共死：只给工具不给规则，模型会用它去猜目标；只给规则不给工具，
   * 模型只能编造执行。因此由同一个装配对象承载。
   */
  systemPromptSection: string
  /** 工作台专有工具（list_skills / read_skill_document / propose_action / execute_test）。 */
  tools: AgentTool<any>[]
}

/**
 * 创建绑定到指定工作区的 Agent 工作台配置。
 *
 * @param workspaceCwd - 工作区根目录：本 Agent 的全部读写与命令都以它为界。
 * @param dateTime - 当前时间戳，注入提示词的时间上下文。
 * @param sessionId - 当前会话 ID；用于按会话注入发问工具（v14）。
 * @param capability - 工作台能力装配（规则提示词 + 专有工具）。
 * @param shellPath - bash 可执行文件绝对路径；缺省由 NodeExecutionEnv 自行探测。
 * @returns 包含工作台提示词与工具集的 Agent 基础配置。
 * @throws {Error} 当 workspaceCwd 为空，或后续工具执行发生异常时抛出。
 */
export function createWorkbenchAgentConfig (
  workspaceCwd: string,
  dateTime: string,
  sessionId: string | undefined,
  capability: IWorkbenchAgentCapability,
  shellPath?: string,
): IAgentBaseConfig {
  // 拼接顺序（v17 §5.4）：主提示词 → **P 组门槛** → 能力清单 → 工作台规则
  // → 技能清单 → 加载约定。
  //
  // 门槛排在能力之前是有意的：先决定「信息够不够、能不能动手」，再谈「能做什么」。
  // 能力清单排在规则之前：它是事实底盘，规则里的动作都建立在它之上。
  const systemPrompt = [
    prompt['authineE2E-agent'] as string,
    getWorkbenchThresholdSection(),
    renderCapabilityPromptSection(),
    capability.systemPromptSection,
    workbenchSkillsBlock,
    skillLoadingConvention,
  ]
    .join(PROMPT_SECTION_SEPARATOR)
    .replace('{workspace}', workspaceCwd)
    .replace('{dateTime}', dateTime)

  return {
    systemPrompt,
    tools: [
      createLoadSkillTool(),
      // 多步骤任务清单：不读写文件、不访问页面，工作台的多步流程（检索 → 确认
      // → 执行）正是它的用武之地，用户可直观看到 Agent 的定位过程。
      createTodoWriteTool(),
      // 工作区文件能力：边界由工作台守卫（CLI 侧）逐次判定——
      // env.json 禁读、平台维护文件禁写、工作区外一律拒绝（PRD SEC-1）。
      ...createWorkspaceExecutionTools(workspaceCwd, {
        blockedReadPaths: [SKILL_ENV_FILE_NAME],
        ...(shellPath ? { shellPath } : {}),
      }),
      // 浏览器工具按会话授权注入（PRD 4.2 / 15.2）：
      // 只有「生成 Playwright 脚本」任务会登记宿主，普通 Chat 与 SKILL.md 生成
      // 不会拿到浏览器工具，避免 Agent 在无授权场景访问目标页面。
      ...createSessionBrowserTools(sessionId),
      // v14：发问工具按会话授权注入（与 authineE2E-agent 同一注册表接缝）。
      // 多候选时用 ask_user_question 让用户选（PRD ID-5），因此工作台必须有它。
      ...createSessionAskTools(sessionId),
      // 工作台专有工具：检索、动作、执行。由 CLI 在会话创建前装配完毕。
      ...capability.tools,
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
      // v20：填入能力，与 select 同层（先输入再提交）。敏感数据以引用填入。
      createBrowserFillTool(host),
      createBrowserWaitForTool(host),
      createBrowserScreenshotTool(host),
      // v12：视觉基线捕获。产出「新旧 DOM 对比」的基准图片（落盘到 baselines/），
      // 供执行期脚本用 toMatchSnapshot 比对。
      // 注意：浏览器工具实际有**两处**枚举点（本文件与 authineE2E-agent.ts），
      // 新增工具时两处都要登记，否则该 Agent 会静默拿不到新工具。
      createBrowserCaptureBaselineTool(host),
    ]
    : []
}
