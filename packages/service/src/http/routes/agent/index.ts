/**
 * Agent 工作通道路由：会话管理、消息发送、历史恢复与 SSE 实时事件流。
 *
 * 路由只负责 HTTP 语义：参数校验、平台配置检查、错误信封；
 * 会话执行与事件分发由 agent-runtime（工作通道运行时 + 事件总线）承担。
 *
 * 端点一览：
 *   GET  /sessions                     会话列表（恢复入口）
 *   POST /sessions                     创建会话并发送首条消息
 *   POST /sessions/:sessionId/messages 在已有会话中续接新一轮
 *   GET  /sessions/:sessionId/blocks   历史工作块（物化视图，恢复时间线）
 *   GET  /sessions/:sessionId/stream   SSE 实时事件流（支持 afterSeq 补发）
 *   POST /sessions/:sessionId/abort    中止当前轮次
 *   POST /sessions/:sessionId/actions/:actionId  动作卡片点击（v16）
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { listSkills } from '@fynn90-e2e_assistant/skill-manager'
import type {
  IAgentSessionSummary,
  IAgentWorkBlock,
} from '@fynn90-e2e_assistant/types'
import type { IAppEnv } from '../../app-types'
import { ApiError } from '../../../shared/errors/api-error'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import type {
  IAgentWorkRuntime,
  IAgentWorkRuntimeRegistry,
} from '../../../agent-runtime/index'
import type { IAgentWorkbenchService } from '../../../application/agent-workbench/workbench-service'
import type { IProposalService } from '../../../application/agent-workbench/proposal-service'
import type { IBatchExecutionService } from '../../../application/agent-workbench/batch-execution-service'
import type { ISuggestionService } from '../../../application/agent-workbench/suggestion-service'
import { assembleWorkbenchCapability } from '../../../application/agent-workbench/workbench-assembly'
import type { IWorkbenchAssembly } from '../../../agent-runtime/agent-work-runtime'

/** 多问题形态回答表中单个值的长度上限（与「其它」长文本一致，Q19）。 */
const ANSWER_VALUE_MAX_LENGTH = 10_000

/** 消息体的最大字节数。 */
const MESSAGE_BODY_LIMIT = 256 * 1024

/** SSE 心跳间隔（毫秒）：无业务事件期间保活连接。 */
const HEARTBEAT_INTERVAL_MS = 15_000

/** 发送消息的请求体。 */
const sendMessageSchema = z.object({
  message: z.string().min(1, '消息内容不能为空').max(100_000),
})

/** 创建会话的请求体。 */
const createSessionSchema = z.object({
  message: z.string().min(1, '消息内容不能为空').max(100_000),
})

/**
 * 交互回答的请求体（v14 D5：`{ answer }`，answer 为 string | Record<questionId, string>）。
 *
 * string 分支保持 v8 单问题语义（confirm 的 'yes'/'no'、choice 的 value、
 * input 文本、取消哨兵）；Record 分支是多问题形态的整卡回答表。
 */
const answerSchema = z.object({
  answer: z.union([
    z.string().min(1, '回答内容不能为空').max(ANSWER_VALUE_MAX_LENGTH),
    z.record(z.string().min(1), z.string().min(1).max(ANSWER_VALUE_MAX_LENGTH)),
  ]),
})

/** 交互回答体的最大字节数。 */
const ANSWER_BODY_LIMIT = 16 * 1024

/** 会话 ID 路径参数。 */
const sessionIdSchema = z.string().min(1).max(128)

/** 动作点击的请求体（v16：覆盖确认，PRD GEN-10）。 */
const actionRequestSchema = z.object({
  /** 脚本被手工编辑时，用户确认覆盖后再发起生成。 */
  confirmOverwrite: z.boolean().optional(),
})

/** 动作请求体的最大字节数。 */
const ACTION_BODY_LIMIT = 4 * 1024

/**
 * 应用提案的请求体（v17）。
 *
 * `envValues` 只在 env-fill 提案上出现：**值由用户在前端填写后随本请求
 * 直达平台**，不进入任何事件、工作块或模型上下文（D7 / PRD V3）。
 * 长度上限沿用「其它」长文本的口径（10_000），足够容纳任何环境变量值。
 */
const applyProposalSchema = z.object({
  envValues: z
    .record(z.string().min(1), z.string().max(ANSWER_VALUE_MAX_LENGTH))
    .optional(),
})

/** 提案请求体的最大字节数（值可能较长，给足空间）。 */
const PROPOSAL_BODY_LIMIT = 64 * 1024

/** 会话重命名的请求体（v17 S1）。长度沿用会话标题的既有上限（80 字符）。 */
const renameSessionSchema = z.object({
  title: z
    .string()
    .min(1, '会话标题不能为空')
    .max(80, '会话标题不能超过 80 个字符'),
})

/** 会话请求体的最大字节数。 */
const SESSION_BODY_LIMIT = 4 * 1024

/** 工作通道路由依赖。 */
export interface IAgentRouteDependencies {
  /** 工作通道运行时注册表（按工作区缓存常驻运行时）。 */
  workRuntimeRegistry: IAgentWorkRuntimeRegistry
  /**
   * 工作台能力服务（v16）：动作卡片点击的编排落点。
   *
   * 缺省时 `/agent` 退化为纯对话（无执行/生成能力），路由对动作端点返回 503；
   * 这让本路由在未装配服务的测试场景下仍可独立工作。
   */
  workbenchService?: IAgentWorkbenchService
  /** 提案服务（v17）：apply / cancel 的落点。缺省时提案端点返回 503。 */
  proposalService?: IProposalService
  /** 批次服务（v17）：confirm / cancel / stop 的落点。缺省时批次端点返回 503。 */
  batchService?: IBatchExecutionService
  /** 建议问题服务（v17 H1）：空态建议的生成方。缺省时返回空列表。 */
  suggestionService?: ISuggestionService
}

/**
 * 注册 Agent 工作通道路由。
 *
 * @param dependencies - 工作通道运行时注册表与工作台服务。
 * @returns 挂载到 /api/agent 下的路由组。
 */
export function createAgentRoutes (
  dependencies: IAgentRouteDependencies,
): Hono<IAppEnv> {
  const routes = new Hono<IAppEnv>()

  /** 按平台配置获取（或惰性创建）当前工作区的常驻运行时。 */
  async function runtimeOf (options: { requireChat?: boolean } = {}) {
    const { config } = await requirePlatformConfig(options)
    return dependencies.workRuntimeRegistry.getRuntime({
      workspace: config.projectDirectory,
      model: config.llmModelName,
      apiBaseUrl: config.llmApiBaseUrl,
      apiKey: config.llmApiKey,
    })
  }

  /**
   * 取出必需的服务（缺省时统一 503，与动作端点的既有处置一致）。
   *
   * @param service - 可能未装配的服务。
   * @param message - 未装配时的用户可读说明。
   * @returns 已确认存在的服务。
   * @throws ApiError（INTERNAL_ERROR / 503）服务未装配时抛出。
   */
  function requireService<T> (service: T | undefined, message: string): T {
    if (!service) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        status: 503,
        message,
      })
    }
    return service
  }

  /**
   * 解析批次端点的两个路径参数。
   *
   * @param context - Hono 请求上下文。
   * @returns 已校验的会话 ID 与批次 ID。
   * @throws ApiError（INVALID_REQUEST / 400）格式不正确时抛出。
   */
  function parseBatchParams (context: {
    req: { param: (name: string) => string | undefined }
  }): { sessionId: string; batchId: string } {
    const sessionId = sessionIdSchema.safeParse(context.req.param('sessionId'))
    const batchId = sessionIdSchema.safeParse(context.req.param('batchId'))
    if (!sessionId.success || !batchId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '会话 ID 或批次 ID 格式不正确。',
      })
    }
    return { sessionId: sessionId.data, batchId: batchId.data }
  }

  /**
   * 装配一个工作台会话的能力（v16）：工具、规则提示词与专用守卫。
   *
   * 为什么在这里装配而不是运行时内部：工作台能力依赖**业务服务**（检索宿主、
   * 执行宿主、动作宿主），那属于应用层；运行时只负责会话与事件通道，
   * 不该认识它们（依赖倒转）。因此由路由层（它已持有服务）在创建会话时装配好、
   * 作为参数传给运行时。
   *
   * @param sessionId - 即将创建的会话 ID。
   * @param workspace - 会话工作区（守卫边界与宿主解析根）。
   * @param runtime - 承载该会话的运行时（卡片发布落点）。
   * @returns 能力装配；工作台服务未配置时返回 undefined（会话退化为普通对话）。
   * @throws 不抛出异常。
   */
  function buildWorkbenchAssembly (
    sessionId: string,
    workspace: string,
    runtime: IAgentWorkRuntime,
  ): IWorkbenchAssembly | undefined {
    const service = dependencies.workbenchService
    if (!service) return undefined
    return assembleWorkbenchCapability({
      sessionId,
      workspace,
      runtime,
      service,
    })
  }

  // —— 会话列表：恢复对话的入口（只返回用户对话，生成任务会话不进列表） ——
  routes.get('/sessions', async (context) => {
    const runtime = await runtimeOf()
    const sessions: IAgentSessionSummary[] = runtime.listSessions({
      kind: 'chat',
    })
    return context.json({ success: true, data: sessions })
  })

  // —— 创建会话并发送首条消息 ——
  // v16：/agent 工作台的会话带 `workbench: true`，装配执行与生成能力。
  // 已有的历史会话（v16 之前创建）续轮时不会补装配——工具与守卫只能在
  // 会话创建时确定；用户新建会话即获得完整能力。
  routes.post('/sessions', async (context) => {
    const request = await parseJsonBody(
      context,
      createSessionSchema,
      MESSAGE_BODY_LIMIT,
    )
    const runtime = await runtimeOf({ requireChat: true })
    // 会话 ID 先由路由生成：能力装配需要它（宿主按会话寻址），
    // 而装配必须在运行时创建会话之前完成。
    const sessionId = randomUUID()
    const { config } = await requirePlatformConfig({ requireChat: true })
    const workbench = buildWorkbenchAssembly(
      sessionId,
      config.projectDirectory,
      runtime,
    )
    runtime.sendMessage({
      sessionId,
      message: request.message,
      ...(workbench ? { workbench } : {}),
    })
    return context.json({ success: true, data: { sessionId } }, 201)
  })

  // —— 在已有会话中续接新一轮 ——
  routes.post('/sessions/:sessionId/messages', async (context) => {
    const sessionId = sessionIdSchema.safeParse(context.req.param('sessionId'))
    if (!sessionId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '会话 ID 格式不正确。',
      })
    }
    const request = await parseJsonBody(
      context,
      sendMessageSchema,
      MESSAGE_BODY_LIMIT,
    )
    const runtime = await runtimeOf({ requireChat: true })
    const { config } = await requirePlatformConfig({ requireChat: true })
    const workbench = buildWorkbenchAssembly(
      sessionId.data,
      config.projectDirectory,
      runtime,
    )
    runtime.sendMessage({
      sessionId: sessionId.data,
      message: request.message,
      // 续轮时装配会被忽略（工具与守卫在首建时已定），但首次创建仍需它。
      ...(workbench ? { workbench } : {}),
    })
    return context.json({ success: true, data: { sessionId: sessionId.data } })
  })

  // —— 历史工作块：恢复时间线的物化视图 ——
  routes.get('/sessions/:sessionId/blocks', async (context) => {
    const sessionId = sessionIdSchema.safeParse(context.req.param('sessionId'))
    if (!sessionId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '会话 ID 格式不正确。',
      })
    }
    const runtime = await runtimeOf()
    const blocks: IAgentWorkBlock[] = runtime.listBlocks(sessionId.data)

    // L2d：在**读取侧**标注「目标用例是否已不存在」。
    //
    // 为什么在读取侧而不是删除侧回写历史块：删除一个用例要回改它历史上
    // 出现过的所有会话块，代价随使用时长增长；读取侧一次 listSkills 就够，
    // 且天然覆盖「用户直接删了目录」这种绕过平台的情况。
    const missingSkillIds = await collectMissingSkillIds(blocks)
    for (const block of blocks) {
      const skillId = (block.payload as { skillId?: unknown }).skillId
      if (typeof skillId === 'string' && missingSkillIds.has(skillId)) {
        block.payload.skillMissing = true
      }
    }

    return context.json({
      success: true,
      data: { blocks, currentSeq: runtime.bus.currentSeq(sessionId.data) },
    })
  })

  // —— SSE 实时事件流：先补发缺口，再实时推送 ——
  routes.get('/sessions/:sessionId/stream', async (context) => {
    const sessionId = sessionIdSchema.safeParse(context.req.param('sessionId'))
    if (!sessionId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '会话 ID 格式不正确。',
      })
    }
    const afterSeqParam = context.req.query('afterSeq')
    const afterSeq =
      afterSeqParam === undefined ? undefined : Number(afterSeqParam)
    if (
      afterSeq !== undefined &&
      (!Number.isInteger(afterSeq) || afterSeq < 0)
    ) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: 'afterSeq 必须是非负整数。',
      })
    }
    const runtime = await runtimeOf()

    context.header('Cache-Control', 'no-cache, no-transform')
    context.header('Connection', 'keep-alive')
    context.header('X-Accel-Buffering', 'no')

    return streamSSE(context, async (stream) => {
      // 订阅总线：先补发 afterSeq 之后的缓冲事件，之后实时推送。
      const unsubscribe = runtime.bus.subscribe(
        sessionId.data,
        afterSeq,
        (event) => {
          void stream.writeSSE({
            id: String(event.seq),
            event: event.type,
            data: JSON.stringify(event),
          })
        },
      )

      // 心跳：SSE 注释帧保活（客户端解析器自动忽略注释行，不进事件流）。
      const heartbeat = setInterval(() => {
        void stream.write(': heartbeat\n\n')
      }, HEARTBEAT_INTERVAL_MS)

      try {
        // 保持连接直到客户端断开。
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve())
        })
      } finally {
        clearInterval(heartbeat)
        unsubscribe()
      }
    })
  })

  // —— 提交交互回答（双向交互的上行半边） ——
  routes.post(
    '/sessions/:sessionId/interactions/:interactionId/answer',
    async (context) => {
      const sessionId = sessionIdSchema.safeParse(
        context.req.param('sessionId'),
      )
      if (!sessionId.success) {
        throw new ApiError({
          code: 'INVALID_REQUEST',
          status: 400,
          message: '会话 ID 格式不正确。',
        })
      }
      const interactionId = sessionIdSchema.safeParse(
        context.req.param('interactionId'),
      )
      if (!interactionId.success) {
        throw new ApiError({
          code: 'INVALID_REQUEST',
          status: 400,
          message: '交互 ID 格式不正确。',
        })
      }
      const request = await parseJsonBody(
        context,
        answerSchema,
        ANSWER_BODY_LIMIT,
      )
      const runtime = await runtimeOf()
      const answered = runtime.answerInteraction(
        sessionId.data,
        interactionId.data,
        request.answer,
      )
      if (!answered) {
        throw new ApiError({
          code: 'INVALID_REQUEST',
          status: 404,
          message: '该交互不存在或已回答。',
        })
      }
      return context.json({ success: true })
    },
  )

  // —— 动作卡片点击（v16）：执行 / 生成 / 覆盖确认的编排落点 ——
  routes.post('/sessions/:sessionId/actions/:actionId', async (context) => {
    const sessionId = sessionIdSchema.safeParse(context.req.param('sessionId'))
    if (!sessionId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '会话 ID 格式不正确。',
      })
    }
    const actionId = sessionIdSchema.safeParse(context.req.param('actionId'))
    if (!actionId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '动作 ID 格式不正确。',
      })
    }
    const service = dependencies.workbenchService
    if (!service) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        status: 503,
        message: '工作台能力未配置，当前无法处理动作。',
      })
    }

    const request = await parseJsonBody(
      context,
      actionRequestSchema,
      ACTION_BODY_LIMIT,
    )
    const runtime = await runtimeOf({ requireChat: true })
    const { config } = await requirePlatformConfig({ requireChat: true })

    const result = await service.runAction({
      rootDir: config.projectDirectory,
      sessionId: sessionId.data,
      runtime,
      actionId: actionId.data,
      ...(request.confirmOverwrite !== undefined
        ? { confirmOverwrite: request.confirmOverwrite }
        : {}),
    })

    return context.json({ success: true, data: result })
  })

  /**
   * 收集已被删除的用例 ID（L2d 的读取侧标注）。
   *
   * 只对「块里出现过的 skillId」做一次核验：先取现有集合，再逐个比对——
   * 比「对每个块都查一次」省得多（前者一次 listSkills，后者 N 次磁盘）。
   *
   * @param blocks - 待标注的历史块。
   * @returns 已不存在的用例 ID 集合；工作区不可读时为空集（不标注）。
   * @throws 不抛出异常。
   */
  async function collectMissingSkillIds (
    blocks: readonly IAgentWorkBlock[],
  ): Promise<Set<string>> {
    const referenced = new Set<string>()
    for (const block of blocks) {
      const skillId = (block.payload as { skillId?: unknown }).skillId
      if (typeof skillId === 'string' && skillId.length > 0) {
        referenced.add(skillId)
      }
    }
    if (referenced.size === 0) return new Set()

    try {
      const { config } = await requirePlatformConfig()
      const candidates = await listSkills({ rootDir: config.projectDirectory })
      const existing = new Set(candidates.map((item) => item.id))
      return new Set([...referenced].filter((id) => !existing.has(id)))
    } catch {
      // 工作区不可读：按「全部存在」处理（不误标删除，用户仍能看到原卡片）。
      return new Set()
    }
  }

  // —— 提案通道（v17 §6.10）：应用 / 取消 ——
  //
  // 只有 apply 这一条路径会触发写操作（D2：卡片按钮不直接触发写操作，
  // 必须经前端确认弹框后再调本端点）。取消语义：弹框内取消**不调本端点**
  //（提案仍是 pending，用户还可以再点）；只有卡片上的「取消」才走 cancel。
  routes.post(
    '/sessions/:sessionId/proposals/:proposalId/apply',
    async (context) => {
      const sessionId = sessionIdSchema.safeParse(
        context.req.param('sessionId'),
      )
      const proposalId = sessionIdSchema.safeParse(
        context.req.param('proposalId'),
      )
      if (!sessionId.success || !proposalId.success) {
        throw new ApiError({
          code: 'INVALID_REQUEST',
          status: 400,
          message: '会话 ID 或提案 ID 格式不正确。',
        })
      }
      const service = requireService(
        dependencies.proposalService,
        '提案能力未配置，当前无法应用提案。',
      )
      const request = await parseJsonBody(
        context,
        applyProposalSchema,
        PROPOSAL_BODY_LIMIT,
      )
      const { config } = await requirePlatformConfig({ requireChat: true })

      const result = await service.apply({
        rootDir: config.projectDirectory,
        sessionId: sessionId.data,
        proposalId: proposalId.data,
        // env 值由用户在前端填写后随本请求直达平台：不落盘、不入块、不经模型（D7）。
        ...(request.envValues ? { envValues: request.envValues } : {}),
      })

      return context.json({ success: true, data: result })
    },
  )

  routes.post(
    '/sessions/:sessionId/proposals/:proposalId/cancel',
    async (context) => {
      const sessionId = sessionIdSchema.safeParse(
        context.req.param('sessionId'),
      )
      const proposalId = sessionIdSchema.safeParse(
        context.req.param('proposalId'),
      )
      if (!sessionId.success || !proposalId.success) {
        throw new ApiError({
          code: 'INVALID_REQUEST',
          status: 400,
          message: '会话 ID 或提案 ID 格式不正确。',
        })
      }
      const service = requireService(
        dependencies.proposalService,
        '提案能力未配置，当前无法取消提案。',
      )
      const runtime = await runtimeOf({ requireChat: true })

      await service.cancel({
        runtime,
        sessionId: sessionId.data,
        proposalId: proposalId.data,
      })
      return context.json({ success: true })
    },
  )

  // —— 连续执行（v17 §6.10）：确认 / 取消 / 停止 ——
  routes.post(
    '/sessions/:sessionId/batches/:batchId/confirm',
    async (context) => {
      const params = parseBatchParams(context)
      const service = requireService(
        dependencies.batchService,
        '连续执行能力未配置，当前无法发起。',
      )
      const runtime = await runtimeOf({ requireChat: true })
      const { config } = await requirePlatformConfig({ requireChat: true })

      const result = await service.confirm({
        rootDir: config.projectDirectory,
        sessionId: params.sessionId,
        batchId: params.batchId,
        runtime,
      })
      return context.json({ success: true, data: result })
    },
  )

  routes.post(
    '/sessions/:sessionId/batches/:batchId/cancel',
    async (context) => {
      const params = parseBatchParams(context)
      const service = requireService(
        dependencies.batchService,
        '连续执行能力未配置，当前无法取消。',
      )
      const runtime = await runtimeOf({ requireChat: true })

      service.cancel({
        sessionId: params.sessionId,
        batchId: params.batchId,
        runtime,
      })
      return context.json({ success: true })
    },
  )

  routes.post('/sessions/:sessionId/batches/:batchId/stop', async (context) => {
    const params = parseBatchParams(context)
    const service = requireService(
      dependencies.batchService,
      '连续执行能力未配置，当前无法停止。',
    )
    const runtime = await runtimeOf({ requireChat: true })

    service.stop({
      sessionId: params.sessionId,
      batchId: params.batchId,
      runtime,
    })
    return context.json({ success: true })
  })

  // —— 空态建议问题（v17 H1） ——
  routes.get('/suggestions', async (context) => {
    const service = dependencies.suggestionService
    if (!service) {
      return context.json({ success: true, data: { suggestions: [] } })
    }
    const { config } = await requirePlatformConfig()
    const suggestions = await service.suggest({
      rootDir: config.projectDirectory,
    })
    return context.json({ success: true, data: { suggestions } })
  })

  // —— 会话重命名（v17 S1） ——
  routes.patch('/sessions/:sessionId', async (context) => {
    const sessionId = sessionIdSchema.safeParse(context.req.param('sessionId'))
    if (!sessionId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '会话 ID 格式不正确。',
      })
    }
    const request = await parseJsonBody(
      context,
      renameSessionSchema,
      SESSION_BODY_LIMIT,
    )
    const runtime = await runtimeOf()
    const renamed = runtime.renameSession(sessionId.data, request.title.trim())
    if (!renamed) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 404,
        message: '该会话不存在。',
      })
    }
    return context.json({ success: true })
  })

  // —— 会话删除（v17 S2） ——
  //
  // 只删对话记录：**不影响**用例、产物与报告（S2 明确要求）。
  // 有运行中任务时不拒绝（任务是服务端的，会话只是观察入口），但把「有无任务」
  // 如实告知前端，让确认文案能说清后果（S2：任务如何处理如实说明）。
  routes.delete('/sessions/:sessionId', async (context) => {
    const sessionId = sessionIdSchema.safeParse(context.req.param('sessionId'))
    if (!sessionId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '会话 ID 格式不正确。',
      })
    }
    const runtime = await runtimeOf()
    const summary = runtime
      .listSessions()
      .find((item) => item.sessionId === sessionId.data)
    if (!summary) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 404,
        message: '该会话不存在。',
      })
    }

    // 会话删除要连它的轮次一起收尾（否则后台还在跑但没有观察者）。
    await runtime.releaseSession(sessionId.data)
    runtime.removeSession(sessionId.data)

    return context.json({
      success: true,
      data: {
        sessionId: sessionId.data,
        // 如实区分两种情形（前端据此给不同的确认文案）。
        hadRunningTask: summary.status === 'running',
      },
    })
  })

  // —— 中止当前轮次 ——
  routes.post('/sessions/:sessionId/abort', async (context) => {
    const sessionId = sessionIdSchema.safeParse(context.req.param('sessionId'))
    if (!sessionId.success) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: '会话 ID 格式不正确。',
      })
    }
    const runtime = await runtimeOf()
    const aborted = runtime.abort(sessionId.data)
    return context.json({ success: true, data: { aborted } })
  })

  return routes
}
