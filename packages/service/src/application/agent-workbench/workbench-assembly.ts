/**
 * 工作台会话的能力装配（v16 §6.3）。
 *
 * 单一职责：把一个「工作台会话」需要的东西组装齐——检索/执行/动作三类工具、
 * 工作台规则提示词、以及专用工具守卫。装配本身是纯函数式拼接，不含业务逻辑：
 * 工具的实现来自 agent 包（端口消费），宿主来自工作台服务（业务编排），
 * 边界判定来自守卫（策略）。
 *
 * 为什么单独成模块而不写进组合根：组合根负责「何时创建谁」，本模块负责
 * 「一个会话要用到哪些东西」——后者是策略集合的声明，可被独立测试与审阅；
 * 写进组合根会让 app.ts 同时承担依赖装配与策略声明两种职责。
 *
 * 装配时机（v16 §6.3 的时序坑）：本函数只在**会话首建**时被调用一次。
 * 工具与守卫在会话创建时装配，此后无法动态增删——`AgentTaskRunner.getOrCreate`
 * 对已存在会话直接返回旧句柄，续轮传入的装配会被忽略。
 */

import {
  createCheckReadinessTool,
  createExecuteBatchTool,
  createExecuteTestTool,
  createListSkillsTool,
  createProposeActionTool,
  createProposeCaseChangeTool,
  createProposeCaseDeletionTool,
  createProposeCaseRepairTool,
  createProposeEnvFillTool,
  createProposeReportCleanupTool,
  createReadRunHistoryTool,
  createReadSkillDocumentTool,
  createReadTestCaseTool,
  createRenderViewTool,
  getWorkbenchPromptSection,
} from '@authine-e2e-agent/agent'
import { createAgentWorkbenchGuard } from './workbench-tool-guard'
import type { IAgentWorkbenchService } from './workbench-service'
import type {
  IAgentWorkRuntime,
  IWorkbenchAssembly,
} from '../../agent-runtime/agent-work-runtime'

/** 工作台守卫的标识（用于诊断与区分其他守卫实例）。 */
const WORKBENCH_GUARD_ID = 'agent-workbench-tool-guard'

/**
 * 为一个工作台会话装配能力。
 *
 * @param input.sessionId - 会话 ID（宿主按会话寻址）。
 * @param input.workspace - 会话工作区（守卫边界与宿主解析根）。
 * @param input.runtime - 承载该会话的常驻运行时（卡片发布落点）。
 * @param input.service - 工作台能力服务（提供三类宿主）。
 * @returns 该会话的能力装配（工具、规则提示词、守卫）。
 * @throws 不抛出异常。
 */
export function assembleWorkbenchCapability(input: {
  sessionId: string
  workspace: string
  runtime: IAgentWorkRuntime
  service: IAgentWorkbenchService
}): IWorkbenchAssembly {
  const { sessionId, workspace, runtime, service } = input

  // 检索宿主按会话创建一次即可：四个读取工具共用同一个宿主实例
  //（各建一次也能工作，但会让「同一份判定」在内存里出现多份引用）。
  const catalogHost = service.createCatalogHost(workspace)

  return {
    systemPromptSection: getWorkbenchPromptSection(),
    tools: [
      // —— 检索：定位目标用例（受控，不接受路径参与，PRD ID-3） ——
      createListSkillsTool(catalogHost),
      createReadSkillDocumentTool(catalogHost),
      // v17 问询域：结构化用例 / 执行历史（**只回数据**，不发卡）。
      createReadTestCaseTool(catalogHost),
      createReadRunHistoryTool(catalogHost),
      // v17 体检（R3）：不启动浏览器、不产生执行记录、不占用执行通道。
      createCheckReadinessTool(service.createReadinessHost(workspace)),
      // —— 动作：请求平台发布可点击入口（ID-6/ID-7） ——
      createProposeActionTool(
        service.createActionHost(workspace, sessionId, runtime),
      ),
      // —— v17 视图：协议传「选择」不传「数据」，宿主按参数自取 ——
      createRenderViewTool(
        service.createViewHost(workspace, sessionId, runtime),
      ),
      // —— v17 提案：四类「用户确认后才生效」的动作共用一条通道 ——
      // origin 由各工具的宿主在调用点写死（模型无从传入，R15）：
      //   propose_case_change → user（红线不适用）
      //   propose_case_repair → agent-analysis（红线适用，且 evidence 必填）
      createProposeCaseChangeTool(
        service.createProposalHost(workspace, sessionId, runtime),
      ),
      createProposeCaseRepairTool(
        service.createProposalHost(workspace, sessionId, runtime),
      ),
      createProposeEnvFillTool(
        service.createProposalHost(workspace, sessionId, runtime),
      ),
      createProposeReportCleanupTool(
        service.createProposalHost(workspace, sessionId, runtime),
      ),
      createProposeCaseDeletionTool(
        service.createProposalHost(workspace, sessionId, runtime),
      ),
      // —— 执行：发起一次测试（复用 v11 链路，含 J1–J8 就绪校验） ——
      createExecuteTestTool(
        service.createTestRunnerHost(workspace, sessionId, runtime),
      ),
      // v17 连续执行（R4）：会话内串行编排，非平台级批量。
      createExecuteBatchTool(
        service.createBatchHost(workspace, sessionId, runtime),
      ),
    ],
    // 守卫与工具同生共死：只给工具不给守卫，工作台会话就能直接改 manifest 与读 env.json。
    toolGuard: createAgentWorkbenchGuard({
      id: WORKBENCH_GUARD_ID,
      workspace,
      blockedToolReason:
        '当前会话不支持该操作；请只使用平台上提供的用例检索、生成与执行能力。',
    }),
  }
}
