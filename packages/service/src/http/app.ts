import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import {
  LOCAL_SERVICE_IDENTITY,
  LOCAL_SERVICE_PROTOCOL_VERSION,
  type ILocalServiceHealthResponse,
  type IApiErrorResponse,
} from '@fynn90-e2e_assistant/types'
import { createE2ETestCaseApplicationServices } from '../application/e2e-test-case/create-services'
import type { IE2ETestCaseApplicationServices } from '../application/e2e-test-case/application-types'
import { createSkillMarkdownGenerator } from '../application/e2e-test-case/skill-markdown-generator'
import { createPlaywrightScriptGenerator } from '../application/e2e-test-case/playwright-script-generator'
import type { TPlaywrightGeneratorFactory } from '../application/e2e-test-case/generate-playwright-script'
import type { TSkillMarkdownGeneratorFactory } from '../application/e2e-test-case/skill-document'
import type { IAppEnv } from './app-types'
import { toApiError } from './error-mapper'
import { ApiError } from '../shared/errors/api-error'
import type { ChatConcurrencyGate } from './chat-concurrency'
import { consoleHttpLogger, isQuietHttpRequest, type IHttpLogger } from './logger'
import { createShutdownRoutes } from './routes/shutdown'
import { createShutdownSequence } from './shutdown-sequence'
import {
  createAgentWorkRuntimeRegistry,
  createSkillGenerationSessionRunner,
  type IAgentWorkRuntime,
  type IAgentWorkRuntimeRegistry,
} from '../agent-runtime/index'
import {
  createAgentWorkbenchService,
  type IAgentWorkbenchService,
} from '../application/agent-workbench/workbench-service'
import { assembleWorkbenchCapability } from '../application/agent-workbench/workbench-assembly'
import { createGenerationOrchestrator } from '../application/agent-workbench/generation-orchestrator'
import { createSkillCatalog } from '../application/agent-workbench/skill-catalog'
import { createReadinessService } from '../application/agent-workbench/execution-readiness'
import {
  createProposalService,
  type IProposalService,
} from '../application/agent-workbench/proposal-service'
import {
  createBatchExecutionService,
  type IBatchExecutionService,
} from '../application/agent-workbench/batch-execution-service'
import {
  createSuggestionService,
  type ISuggestionService,
} from '../application/agent-workbench/suggestion-service'
import {
  createSkillLifecycleService,
  type ISkillLifecycleService,
} from '../application/agent-workbench/skill-lifecycle-service'
import { updateE2ETestCase } from '../application/e2e-test-case/update-e2e-test-case'
import { requirePlatformConfig } from './routes/route-utils'
import {
  createGenerationBrowserHost,
  createGenerationTaskRegistry,
  type IBrowserSessionHostOptions,
  type IGenerationBrowserHost,
  type IGenerationTaskRegistry,
} from '../generation-runtime/index'
import { createPlaywrightEngine } from '@fynn90-e2e_assistant/playwright-engine'
import {
  createExecutionEventBus,
  type IExecutionEventBus,
} from '../application/test-execution/execution-event-bus'
import {
  createTestExecutionService,
  type ITestExecutionService,
} from '../application/test-execution/execution-service'
import { createAgentRoutes } from './routes/agent/index'
import { createConfigRoutes } from './routes/config'
import { createFsRoutes } from './routes/fs'
import { createRecordRoutes } from './routes/record'
import { createSkillRoutes } from './routes/skills/index'
import type { TSkillChatRuntimeFactory } from './routes/skills/skill-chat'
import { createWorkspaceRoutes } from './routes/workspace'

export interface ICreateHttpAppOptions {
  chatRuntimeFactory: TSkillChatRuntimeFactory
  chatConcurrencyGate: ChatConcurrencyGate
  /** 工作通道运行时注册表；缺省内部创建（测试场景可注入替身）。 */
  workRuntimeRegistry?: IAgentWorkRuntimeRegistry
  e2eTestCaseServices?: IE2ETestCaseApplicationServices
  /** 生成任务运行时：浏览器宿主与并发排他；缺省内部创建（测试可注入替身）。 */
  generationRuntime?: {
    browserHost: IGenerationBrowserHost
    taskRegistry: IGenerationTaskRegistry
  }
  /** 测试执行运行时（v11）；缺省内部创建（测试可注入替身）。 */
  testExecutionRuntime?: {
    testExecutionService: ITestExecutionService
    executionEventBus: IExecutionEventBus
  }
  /**
   * 工作台能力服务（v16）；缺省由本组合根创建。
   *
   * 缺省创建时依赖以下既有单例：工作通道运行时注册表、生成任务注册表、
   * 执行服务与执行事件总线——它们与 Skill 开发页共用，因此 `/agent` 与
   * 开发页的发起跨入口天然互斥（PRD RUN-3 场景 15）。
   */
  workbenchService?: IAgentWorkbenchService

  /**
   * v17 的三个编排服务；缺省由本组合根创建（测试可注入替身）。
   *
   * 它们都持有跨请求的编排状态（提案登记、批次进度、会话引用），
   * 必须与服务同生命周期——按请求创建会让每次 apply 都找不到上一轮的提案。
   */
  proposalService?: IProposalService
  batchService?: IBatchExecutionService
  suggestionService?: ISuggestionService
  /** 用例生命周期服务（v17）；缺省内部创建。路由与工作台删除共用同一实现。 */
  skillLifecycle?: ISkillLifecycleService
  /** 浏览器宿主的可替换依赖；仅内部创建 generationRuntime 时生效。 */
  browserSessionHostOptions?: IBrowserSessionHostOptions
  logger?: IHttpLogger
  requestIdGenerator?: () => string

  /**
   * 优雅关闭凭据；提供时才注册 `POST /api/shutdown`。
   *
   * 由 CLI 生成并随运行态记录保存：端点本身不做鉴权存储，只做凭据比对。
   * 缺省不注册——纯 API 部署与既有测试因此不受影响。
   */
  shutdownToken?: string
  /**
   * 关闭序列的就绪回调：应用装配完成后，把「中止在跑任务 + 关浏览器 + 释放运行时」
   * 这一步交给调用方（见 §4.2）。
   *
   * 它是 `extendApp` 的反向通道——组合根（CLI）无需重复本文件的装配逻辑，
   * 即可拿到服务内部的关闭序列。**服务层仍然不含 `process.exit` / 信号钩子**：
   * 谁关进程、什么退出码，全部由调用方决定（v18 原则二）。
   *
   * @param handler - 无参、无返回值的关闭函数；调用方自行决定何时调用。
   */
  registerShutdownHandler?: (handler: () => Promise<void>) => void
  /**
   * 关闭端点被合法请求时通知宿主（`startLocalServer` 的调用方）。
   *
   * 端点本身只做「校验 → 应答 → 通知」，**关闭与退出由宿主执行**（C3）。
   * 未提供时端点只应答不动作——纯 API 部署没有「谁负责结束进程」的答案。
   */
  onShutdownRequested?: () => void

  /**
   * 应用扩展点：在全部 API 路由与 `/health` 注册完成之后挂载额外路由。
   *
   * 主要用途是让调用方（CLI）挂载前端静态资源——**服务层自身不依赖任何前端包**，
   * 它只提供这个挂载时机，由调用方决定挂什么。这样服务层保持为纯 API 服务，
   * 可独立部署到服务器端；前端资源如何提供是客户端形态的自由。
   *
   * 挂载顺序：本回调最后执行，因此它注册的兜底路由（如 `*`）不会遮蔽任何 API 路由。
   *
   * @param app - 已完成 API 装配的 Hono 应用实例。
   * @returns 无返回值。
   */
  extendApp?: (app: Hono<IAppEnv>) => void
}

export function createHttpApp (options: ICreateHttpAppOptions): Hono<IAppEnv> {
  const app = new Hono<IAppEnv>()
  const logger = options.logger ?? consoleHttpLogger
  const requestIdGenerator = options.requestIdGenerator ?? randomUUID

  // 工作通道运行时注册表：/api/agent 路由与 SKILL.md 生成共用同一实例。
  // 两处若各自创建，生成会话的事件会发布到一个总线上而前端订阅另一个，
  // 表现为侧边栏与生成弹窗都收不到 Agent 工作内容（静默失效，无报错）。
  const workRuntimeRegistry =
    options.workRuntimeRegistry ?? createAgentWorkRuntimeRegistry()
  // 生成任务运行时：浏览器宿主在整个服务生命周期内复用（内部持有会话表），
  // 并发注册表必须单例，否则排他锁在每次请求间失效。
  const generationRuntime = options.generationRuntime ?? {
    browserHost: createGenerationBrowserHost(options.browserSessionHostOptions),
    taskRegistry: createGenerationTaskRegistry(),
  }
  // 测试执行运行时（v11）：执行服务与生成任务共用同一并发注册表（技术方案 D7，
  // 生成 ↔ 执行互斥）；engine 的 Chromium 安装器与测试执行器在整个服务生命周期内复用。
  const testExecutionRuntime =
    options.testExecutionRuntime ??
    (() => {
      const engine = createPlaywrightEngine()
      const executionEventBus = createExecutionEventBus()
      return {
        executionEventBus,
        testExecutionService: createTestExecutionService({
          taskRegistry: generationRuntime.taskRegistry,
          chromium: engine.chromium,
          testRunner: engine.testRunner,
          eventBus: executionEventBus,
        }),
      }
    })()

  app.use('*', async (context, next) => {
    const requestStartedAt = Date.now()
    context.set('requestId', requestIdGenerator())
    context.set('requestStartedAt', requestStartedAt)
    await next()

    const logEntry = {
      requestId: context.get('requestId'),
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Date.now() - requestStartedAt,
      errorCode: context.get('errorCode'),
    }

    // 静态资源成功请求静默（Q1）：只跳过打印，请求处理与响应不受影响。
    if (isQuietHttpRequest(logEntry)) {
      return
    }

    if (context.res.status >= 400) {
      logger.error(logEntry)
    } else {
      logger.request(logEntry)
    }
  })

  app.onError((error, context) => {
    const apiError = toApiError(error)
    context.set('errorCode', apiError.code)
    const responseBody: IApiErrorResponse = {
      success: false,
      code: apiError.code,
      message: apiError.message,
      requestId: context.get('requestId') || requestIdGenerator(),
      // env.json 校验失败时携带问题明细（行:列 + 原因），供前端校验反馈区渲染。
      ...(apiError.issues ? { issues: apiError.issues } : {}),
    }

    return context.json(responseBody, apiError.status as 400)
  })

  // 应用服务聚合：/api/skills 的生成/保存与 /agent 工作台的生成编排共用同一实例
  // （工作台编排需要 generate + save 两步都在服务端完成，见 v16 §6.5）。
  const e2eTestCaseServices =
    options.e2eTestCaseServices ??
    createE2ETestCaseApplicationServices(
      // v7：接入真实 Playwright 生成器（此前为返回空对象的占位实现，
      // 调用即抛 TypeError，导致「生成 Playwright 脚本」链路不可用）。
      createDefaultPlaywrightGeneratorFactory(workRuntimeRegistry),
      createDefaultSkillMarkdownGeneratorFactory(workRuntimeRegistry),
    )

  /**
   * 工作台能力服务（v16）：承载 /agent 的检索、执行与生成编排。
   *
   * 依赖全部取自上面的既有单例——生成任务注册表是「跨入口互斥」的关键，
   * 执行服务与执行总线让工作台复用 v11 的 J1–J8、报告与事件流。
   */
  // v17：用例生命周期服务（删除用例的唯一实现，含任务冲突检查）。
  // 构造位置在 testExecutionRuntime 之后——它与工作台提案服务共用同一个
  // 任务注册表，那是「有任务在跑就拒绝」的判定来源。
  const skillLifecycle = options.skillLifecycle ?? createSkillLifecycleService()

  // v17：提案服务（四类「用户确认后才生效」的动作的唯一状态机）。
  // 必须在 testExecutionRuntime 之后构造（依赖执行服务与用例生命周期）。
  const proposalService =
    options.proposalService ??
    createProposalService({
      taskRegistry: generationRuntime.taskRegistry,
      updateTestCase: updateE2ETestCase,
      skillLifecycle,
    })

  // v17：连续执行编排（会话内串行，非平台级批量）。
  const batchService =
    options.batchService ??
    createBatchExecutionService({
      testExecutionService: testExecutionRuntime.testExecutionService,
      executionEventBus: testExecutionRuntime.executionEventBus,
      taskRegistry: generationRuntime.taskRegistry,
      readiness: createReadinessService({
        taskRegistry: generationRuntime.taskRegistry,
      }),
    })

  // v17：空态建议问题（与卡片/工具共用同一检索实例，判定同源）。
  const suggestionService =
    options.suggestionService ??
    createSuggestionService({
      catalog: createSkillCatalog(),
    })

  const workbenchService =
    options.workbenchService ??
    createAgentWorkbenchService({
      taskRegistry: generationRuntime.taskRegistry,
      testExecutionService: testExecutionRuntime.testExecutionService,
      executionEventBus: testExecutionRuntime.executionEventBus,
      proposalService,
      batchService,
      generationOrchestrator: createGenerationOrchestrator({
        taskRegistry: generationRuntime.taskRegistry,
        services: e2eTestCaseServices,
        browserHost: generationRuntime.browserHost,
        resolveConfig: async () => (await requirePlatformConfig()).config,
      }),
    })

  registerApiRoutes(app, {
    workRuntimeRegistry,
    workbenchService,
    proposalService,
    batchService,
    suggestionService,
    chatRuntimeFactory: options.chatRuntimeFactory,
    chatConcurrencyGate: options.chatConcurrencyGate,
    generationRuntime,
    testExecutionRuntime,
    e2eTestCaseServices,
    skillLifecycle,
    ...(options.shutdownToken ? { shutdownToken: options.shutdownToken } : {}),
    ...(options.onShutdownRequested
      ? { onShutdownRequested: options.onShutdownRequested }
      : {}),
  })

  app.get('/health', (context) => {
    const responseBody: ILocalServiceHealthResponse = {
      service: LOCAL_SERVICE_IDENTITY,
      status: 'ok',
      version: LOCAL_SERVICE_PROTOCOL_VERSION,
      // 上报真实 PID：调用方据此把响应者与运行态记录精确对应，
      // 避免 PID 被无关进程复用后仍被当作本服务。
      pid: process.pid,
    }

    return context.json(responseBody)
  })

  // 关闭序列（唯一实现，三处共用）：实现与容错语义见 shutdown-sequence.ts。
  options.registerShutdownHandler?.(
    createShutdownSequence({
      testExecutionService: testExecutionRuntime.testExecutionService,
      browserHost: generationRuntime.browserHost,
      workRuntimeRegistry,
    }),
  )

  // 扩展点最后执行：调用方挂载的路由（如前端静态资源兜底）不会遮蔽任何 API 路由。
  options.extendApp?.(app)

  return app
}

/**
 * 组合根：构造带 agent-work 运行时的 SKILL.md 生成器工厂。
 *
 * 生成器本身属于应用层，但其会话承载依赖基础设施层的运行时，
 * 因此在组合根完成装配，避免应用层反向依赖基础设施（依赖倒转原则）。
 *
 * @param registry - 与 /api/agent 路由共享的工作通道运行时注册表。
 * @returns 按平台配置构造生成器的工厂。
 * @throws 不抛出异常；配置不完整时由生成阶段返回稳定错误码。
 */
function createDefaultSkillMarkdownGeneratorFactory (
  registry: IAgentWorkRuntimeRegistry,
): TSkillMarkdownGeneratorFactory {
  return (config) =>
    createSkillMarkdownGenerator({
      workspace: config.projectDirectory,
      sessionRunner: createSkillGenerationSessionRunner(registry, {
        workspace: config.projectDirectory,
        model: config.llmModelName,
        apiBaseUrl: config.llmApiBaseUrl,
        apiKey: config.llmApiKey,
      }),
    })
}

/**
 * 组合根：构造带 agent-work 运行时的 Playwright 脚本生成器工厂。
 *
 * 与 SKILL.md 生成器同源装配：应用层声明生成规则与守卫，
 * 会话承载由基础设施层的运行时负责（依赖倒转原则）。
 * 浏览器会话不由生成器创建——它由 generationRuntime 在生成前登记到
 * agent 包的浏览器注册表，Agent 配置工厂据此为该会话注入 browser_* 工具。
 *
 * @param registry - 与 /api/agent 路由共享的工作通道运行时注册表。
 * @returns 按平台配置构造 Playwright 生成器的工厂。
 * @throws 不抛出异常；配置不完整时由生成阶段返回稳定错误码。
 */
function createDefaultPlaywrightGeneratorFactory (
  registry: IAgentWorkRuntimeRegistry,
): TPlaywrightGeneratorFactory {
  return (config) =>
    createPlaywrightScriptGenerator({
      workspace: config.projectDirectory,
      sessionRunner: createSkillGenerationSessionRunner(registry, {
        workspace: config.projectDirectory,
        model: config.llmModelName,
        apiBaseUrl: config.llmApiBaseUrl,
        apiKey: config.llmApiKey,
      }),
    })
}

interface IRegisterApiRoutesOptions {
  workRuntimeRegistry: IAgentWorkRuntimeRegistry
  workbenchService: IAgentWorkbenchService
  proposalService: IProposalService
  batchService: IBatchExecutionService
  suggestionService: ISuggestionService
  chatRuntimeFactory: TSkillChatRuntimeFactory
  chatConcurrencyGate: ChatConcurrencyGate
  generationRuntime: {
    browserHost: IGenerationBrowserHost
    taskRegistry: IGenerationTaskRegistry
  }
  testExecutionRuntime: {
    testExecutionService: ITestExecutionService
    executionEventBus: IExecutionEventBus
  }
  e2eTestCaseServices: IE2ETestCaseApplicationServices
  skillLifecycle: ISkillLifecycleService
  /** 优雅关闭凭据；提供时才注册 `POST /api/shutdown`。 */
  shutdownToken?: string
  /** 关闭端点的宿主回调（见 `ICreateHttpAppOptions.onShutdownRequested`）。 */
  onShutdownRequested?: () => void
}

/**
 * 注册全部 API 路由（装配的独立一段，避免组合根过长掩盖顺序约束）。
 *
 * 顺序不可随意调整的三处：
 *   - 优雅关闭端点必须在 `/api/*` 兜底**之前**注册（M3：先注册的兜底会遮蔽
 *     后注册的精确路由，实测得到 404）；
 *   - `/api/*` 兜底必须在所有具体 API 路由之后；
 *   - `extendApp`（前端静态资源）由调用方在最后执行，因此它不会遮蔽任何 API。
 *
 * @param app - 已装配好中间件、错误处理与服务单例的 Hono 应用。
 * @param options - 各路由所需的服务实例与关闭端点配置。
 * @returns 注册完成后无返回值。
 * @throws 不抛出异常。
 */
function registerApiRoutes (
  app: Hono<IAppEnv>,
  options: IRegisterApiRoutesOptions,
): void {
  app.route('/api/config', createConfigRoutes())
  app.route('/api/fs', createFsRoutes())
  app.route('/api/workspace', createWorkspaceRoutes())
  app.route(
    '/api/agent',
    createAgentRoutes({
      workRuntimeRegistry: options.workRuntimeRegistry,
      workbenchService: options.workbenchService,
      proposalService: options.proposalService,
      batchService: options.batchService,
      suggestionService: options.suggestionService,
    }),
  )
  app.route(
    '/api/skills',
    createSkillRoutes({
      chatRuntimeFactory: options.chatRuntimeFactory,
      chatConcurrencyGate: options.chatConcurrencyGate,
      generationRuntime: options.generationRuntime,
      testExecutionRuntime: options.testExecutionRuntime,
      e2eTestCaseServices: options.e2eTestCaseServices,
      skillLifecycle: options.skillLifecycle,
    }),
  )
  app.route('/api/record', createRecordRoutes())
  registerShutdownRoute(app, options)

  app.all('/api/*', (context) => {
    throw new ApiError({
      code: 'API_NOT_FOUND',
      status: 404,
      message: 'API 不存在。',
    })
  })
}

/**
 * 注册优雅关闭端点（仅当提供凭据时）。
 *
 * 必须注册在 `/api/*` 兜底之前（M3）；端点只通知宿主、不执行关闭序列——
 * 宿主（CLI）的例行程序会调 `closeServer`，那里才是「释放资源」的唯一触发点。
 *
 * @param app - 已装配的 Hono 应用。
 * @param options - 关闭凭据与宿主回调。
 * @returns 注册完成后无返回值。
 * @throws 不抛出异常。
 */
function registerShutdownRoute (
  app: Hono<IAppEnv>,
  options: IRegisterApiRoutesOptions,
): void {
  if (!options.shutdownToken) {
    return
  }

  app.route(
    '/api',
    createShutdownRoutes({
      token: options.shutdownToken,
      onShutdownRequested: () => {
        options.onShutdownRequested?.()
      },
    }),
  )
}
