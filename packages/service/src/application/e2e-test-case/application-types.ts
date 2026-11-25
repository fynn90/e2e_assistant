/**
 * 定义 CLI E2E 应用服务的输入、进度回调和可替换依赖。
 */
import type {
  IGeneratePlaywrightData,
  IGeneratePlaywrightRequest,
  IGenerateSkillDocumentRequest,
  IE2ETestCaseDocumentData,
  ISavePlaywrightScriptData,
  ISavePlaywrightScriptRequest,
  ISaveSkillDocumentData,
  ISaveSkillDocumentRequest,
  ISkillDocumentGenerationResult,
  IUpdateE2ETestCaseData,
  IUpdateE2ETestCaseRequest,
} from '@fynn90-e2e_assistant/types'
import type { IAuthinePlatformConfig } from '../../config/config-store'

export interface IE2ETestCaseApplicationServices {
  get (input: {
    rootDir: string
    skillId: string
  }): Promise<IE2ETestCaseDocumentData>
  update (input: {
    rootDir: string
    skillId: string
    request: IUpdateE2ETestCaseRequest
  }): Promise<IUpdateE2ETestCaseData>
  generate (input: {
    config: IAuthinePlatformConfig
    skillId: string
    /** 本次生成的 Agent 会话 ID：路由生成并在 SSE start 事件下发给前端订阅。 */
    sessionId: string
    request: IGeneratePlaywrightRequest
    /**
     * 修复上下文（v17 G2a）：提供时本次生成按「修复」语义执行
     *（prompt 会带上失败报告摘要与修复要求）。
     */
    repairContext?: import('./playwright-script-generator').IRepairContext
    signal: AbortSignal
    onProgress?: (
      progress: import('./generate-playwright-script').TPlaywrightGenerationStage,
    ) => void
    /**
     * 在 Agent 开始工作前登记浏览器宿主：由组合根把已启动的浏览器会话
     * 与该生成会话关联，使 Agent 获得页面核对工具（v7 页面核对能力）。
     */
    registerBrowserHost?: (context: {
      sessionId: string
      headed: boolean
      baseUrl: string
      signal: AbortSignal
      /**
       * 当前 Skill 目录与 ID（v12-pre）：提供时 Agent 的页面截图会归档到该目录
       * 并可在界面展示；缺省时截图只回传模型、不落盘。
       */
      skillRoot?: string
      skillId?: string
    }) => Promise<void>
  }): Promise<IGeneratePlaywrightData>
  saveScript (input: {
    rootDir: string
    skillId: string
    request: ISavePlaywrightScriptRequest
  }): Promise<ISavePlaywrightScriptData>
  generateSkillDocument?: (input: {
    config: IAuthinePlatformConfig
    skillId: string
    /** 本次生成对应的 Agent 会话 ID：路由生成并在 SSE start 事件下发给前端。 */
    sessionId: string
    request: IGenerateSkillDocumentRequest
    signal: AbortSignal
    onProgress?: (
      progress:
        | 'requesting-model'
        | 'writing-skill'
        | 'repairing-output'
        | 'validating-output'
        | 'completed',
    ) => void
  }) => Promise<ISkillDocumentGenerationResult>
  saveSkillDocument?: (input: {
    rootDir: string
    skillId: string
    request: ISaveSkillDocumentRequest
  }) => Promise<ISaveSkillDocumentData>
}
