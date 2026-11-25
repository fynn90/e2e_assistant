import { Hono } from 'hono'
import {
  createSkill,
  listSkills,
  toSkillSummary,
} from '@authine-e2e-agent/skill-manager'
import type {
  ICreateSkillResponse,
  IListSkillsResponse,
} from '@authine-e2e-agent/types'
import type { IE2ETestCaseApplicationServices } from '../../../application/e2e-test-case/application-types'
import type { IExecutionEventBus } from '../../../application/test-execution/execution-event-bus'
import type { ITestExecutionService } from '../../../application/test-execution/execution-service'
import type { ISkillLifecycleService } from '../../../application/agent-workbench/skill-lifecycle-service'
import type {
  IGenerationBrowserHost,
  IGenerationTaskRegistry,
} from '../../../generation-runtime/index'
import type { IAppEnv } from '../../app-types'
import type { ChatConcurrencyGate } from '../../chat-concurrency'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import { registerE2ETestCaseRoutes } from './e2e-test-case'
import { registerPlaywrightGenerationRoute } from './playwright-generation'
import { registerSkillDocumentGenerationRoute } from './skill-document-generation'
import { registerSkillDocumentRoute } from './skill-document'
import { registerPlaywrightScriptRoute } from './playwright-script'
import {
  registerSkillChatRoute,
  type TSkillChatRuntimeFactory,
} from './skill-chat'
import { registerSkillDeleteRoute } from './skill-delete'
import { registerSkillDetailRoutes } from './skill-detail'
import { registerSkillFileRoutes } from './skill-files'
import { registerTestExecutionRoutes } from './test-execution'
import { createSkillSchema } from './validation'

const CREATE_SKILL_BODY_LIMIT = 64 * 1024

export function createSkillRoutes(dependencies: {
  chatRuntimeFactory: TSkillChatRuntimeFactory
  chatConcurrencyGate: ChatConcurrencyGate
  e2eTestCaseServices: IE2ETestCaseApplicationServices
  /** 生成任务运行时：浏览器宿主与 per-Skill 并发排他（v7）。 */
  generationRuntime: {
    browserHost: IGenerationBrowserHost
    taskRegistry: IGenerationTaskRegistry
  }
  /** 测试执行运行时（v11）：执行服务与事件总线。 */
  testExecutionRuntime: {
    testExecutionService: ITestExecutionService
    executionEventBus: IExecutionEventBus
  }
  /** 用例生命周期服务（v17）：删除用例的唯一实现（含任务冲突检查）。 */
  skillLifecycle: ISkillLifecycleService
}): Hono<IAppEnv> {
  const routes = new Hono<IAppEnv>()

  routes.get('/', async (context) => {
    const { config } = await requirePlatformConfig()
    const skills = await listSkills({ rootDir: config.projectDirectory })
    const responseBody: IListSkillsResponse = { success: true, data: skills }
    return context.json(responseBody)
  })

  routes.post('/', async (context) => {
    const input = await parseJsonBody(
      context,
      createSkillSchema,
      CREATE_SKILL_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig()
    const result = await createSkill({
      rootDir: config.projectDirectory,
      title: input.title,
      description: input.description,
    })
    const responseBody: ICreateSkillResponse = {
      success: true,
      data: toSkillSummary(result.skillManifest),
    }
    return context.json(responseBody, 201)
  })

  registerE2ETestCaseRoutes(routes, dependencies.e2eTestCaseServices)
  registerPlaywrightGenerationRoute(
    routes,
    dependencies.e2eTestCaseServices,
    dependencies.generationRuntime,
  )
  registerPlaywrightScriptRoute(routes, dependencies.e2eTestCaseServices)
  registerSkillDocumentGenerationRoute(routes, dependencies.e2eTestCaseServices)
  registerSkillDocumentRoute(routes, dependencies.e2eTestCaseServices)
  registerSkillChatRoute(routes, {
    chatRuntimeFactory: dependencies.chatRuntimeFactory,
    chatConcurrencyGate: dependencies.chatConcurrencyGate,
  })
  registerSkillFileRoutes(routes)
  registerSkillDetailRoutes(routes)
  // v17：删除走共享的用例生命周期服务（与 /agent 的删除提案同一实现，
  // 含 L2c 的任务冲突检查——顺带修好管理页删掉正在执行的用例的缺陷）。
  registerSkillDeleteRoute(
    routes,
    dependencies.skillLifecycle,
    dependencies.generationRuntime.taskRegistry,
  )
  registerTestExecutionRoutes(routes, dependencies.testExecutionRuntime)
  return routes
}
