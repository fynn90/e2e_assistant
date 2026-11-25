/**
 * 测试执行路由（v11，技术方案 §5.2）。
 *
 * 端点一览：
 *   POST /:skillId/test-executions                       发起执行（就绪失败 → 422 + issues）
 *   GET  /:skillId/test-executions/current               最近一次执行快照（X16 恢复入口）
 *   GET  /:skillId/test-executions/:executionId          执行快照（状态 + summary + 环形缓冲事件）
 *   GET  /:skillId/test-executions/:executionId/stream   SSE（afterSeq 补发 + 15s 心跳，镜像 /api/agent）
 *   POST /:skillId/test-executions/:executionId/stop     停止执行（X10）
 *   GET  /:skillId/test-reports/:runId/report.html       报告文件服务（D10 路径白名单）
 *
 * 路由只负责 HTTP 语义：参数校验、错误信封与流式响应；
 * 校验、互斥、进程编排与事件分发由 test-execution 应用层承担。
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  TEST_REPORT_DIRECTORY_NAME,
  TEST_REPORT_REPORT_FILE_NAME,
  TEST_REPORT_RUN_DIR_PATTERN,
  deleteTestReportRun,
  resolveSkill,
} from '@fynn90-e2e_assistant/skill-manager'
import type {
  IDeleteTestReportResponse,
  IStartExecutionResponse,
} from '@fynn90-e2e_assistant/types'
import type { IAppEnv } from '../../app-types'
import { ApiError } from '../../../shared/errors/api-error'
import type { IExecutionEventBus } from '../../../application/test-execution/execution-event-bus'
import type { ITestExecutionService } from '../../../application/test-execution/execution-service'
import { requirePlatformConfig } from '../route-utils'
import { skillIdSchema } from './validation'

/** SSE 心跳间隔（毫秒）：无业务事件期间保活连接（与 /api/agent 一致）。 */
const HEARTBEAT_INTERVAL_MS = 15_000

/** 执行路由依赖。 */
export interface ITestExecutionRouteDependencies {
  /** 执行编排服务（组合根单例）。 */
  testExecutionService: ITestExecutionService
  /** 执行事件总线（与服务共享同一实例）。 */
  executionEventBus: IExecutionEventBus
}

/**
 * 注册测试执行路由。
 *
 * @param routes - 挂载到 /api/skills 下的路由组。
 * @param dependencies - 执行服务与事件总线。
 * @returns 无返回值。
 * @throws 不抛出异常；业务错误以 ApiError 形式在 handler 内抛出。
 */
export function registerTestExecutionRoutes (
  routes: Hono<IAppEnv>,
  dependencies: ITestExecutionRouteDependencies,
): void {
  const { testExecutionService, executionEventBus } = dependencies

  // —— 发起执行：就绪校验失败 → 422 + 全部问题；成功 → 执行 ID ——
  routes.post('/:skillId/test-executions', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const { config } = await requirePlatformConfig()
    const result = await testExecutionService.start({
      rootDir: config.projectDirectory,
      skillId,
    })

    if (!result.ok) {
      // 就绪校验失败不产生执行记录（PRD P1），以 422 信封携带全部问题（5.2）。
      throw new ApiError({
        code: 'EXECUTION_PRECHECK_FAILED',
        status: 422,
        message: result.issues[0]?.message ?? '执行前就绪校验未通过。',
        issues: result.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          ...(issue.target ? { target: issue.target } : {}),
        })),
      })
    }

    const responseBody: IStartExecutionResponse = {
      executionId: result.executionId,
    }
    return context.json({ success: true, data: responseBody }, 201)
  })

  // —— 最近一次执行快照：进入 Skill 页时的恢复入口（X16） ——
  routes.get('/:skillId/test-executions/current', async (context) => {
    parseSkillId(context.req.param('skillId'))
    const snapshot = testExecutionService.current(context.req.param('skillId'))

    if (!snapshot) {
      throw executionNotFoundError()
    }

    return context.json({ success: true, data: snapshot })
  })

  // —— 指定执行快照 ——
  routes.get('/:skillId/test-executions/:executionId', async (context) => {
    parseSkillId(context.req.param('skillId'))
    const snapshot = testExecutionService.snapshot(
      context.req.param('executionId'),
    )

    if (!snapshot) {
      throw executionNotFoundError()
    }

    return context.json({ success: true, data: snapshot })
  })

  // —— SSE 实时事件流：先补发 afterSeq 之后的缓冲事件，再实时推送 ——
  routes.get(
    '/:skillId/test-executions/:executionId/stream',
    async (context) => {
      parseSkillId(context.req.param('skillId'))
      const executionId = context.req.param('executionId')
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

      if (!testExecutionService.snapshot(executionId)) {
        throw executionNotFoundError()
      }

      context.header('Cache-Control', 'no-cache, no-transform')
      context.header('Connection', 'keep-alive')
      context.header('X-Accel-Buffering', 'no')

      return streamSSE(context, async (stream) => {
        // 订阅总线：先补发 afterSeq 之后的缓冲事件，之后实时推送。
        const unsubscribe = executionEventBus.subscribe(
          executionId,
          afterSeq,
          (event) => {
            void stream.writeSSE({
              id: String(event.seq),
              event: event.type,
              data: JSON.stringify(event),
            })
          },
        )

        // 心跳：SSE 注释帧保活（客户端解析器自动忽略注释行）。
        const heartbeat = setInterval(() => {
          void stream.write(': heartbeat\n\n')
        }, HEARTBEAT_INTERVAL_MS)

        try {
          await new Promise<void>((resolve) => {
            stream.onAbort(() => resolve())
          })
        } finally {
          clearInterval(heartbeat)
          unsubscribe()
        }
      })
    },
  )

  // —— 停止执行（X10） ——
  routes.post(
    '/:skillId/test-executions/:executionId/stop',
    async (context) => {
      const skillId = parseSkillId(context.req.param('skillId'))
      const requested = testExecutionService.stop({ skillId })
      return context.json({ success: true, data: { requested } })
    },
  )

  // —— 删除一次执行的报告目录（仅时间戳子目录；顶层 test_report 不受影响） ——
  routes.delete('/:skillId/test-reports/:runId', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const runId = context.req.param('runId') ?? ''

    // runId 白名单：yyyyMMdd-HHmmss，杜绝目录穿越。
    if (!TEST_REPORT_RUN_DIR_PATTERN.test(runId)) {
      throw new ApiError({
        code: 'FILE_NOT_FOUND',
        status: 404,
        message: '测试报告不存在。',
      })
    }

    const { config } = await requirePlatformConfig()
    const resolvedSkill = await resolveSkill(
      { rootDir: config.projectDirectory },
      skillId,
    )
    const runDirectory = path.join(
      resolvedSkill.skillRoot,
      TEST_REPORT_DIRECTORY_NAME,
      runId,
    )

    // 双保险：归一后必须仍位于 Skill 目录内。
    const relative = path.relative(resolvedSkill.skillRoot, runDirectory)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ApiError({
        code: 'INVALID_FILE_PATH',
        status: 400,
        message: '报告路径不合法。',
      })
    }

    await deleteTestReportRun(resolvedSkill.skillRoot, runId)
    const responseBody: IDeleteTestReportResponse = { skillId, runId }
    return context.json({ success: true, data: responseBody })
  })

  // —— 报告文件服务（D10 路径白名单：test_report/<runId>/report.html 单文件） ——
  routes.get('/:skillId/test-reports/:runId/report.html', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const runId = context.req.param('runId') ?? ''

    // runId 白名单：yyyyMMdd-HHmmss，杜绝目录穿越的第一道防线。
    if (!TEST_REPORT_RUN_DIR_PATTERN.test(runId)) {
      throw new ApiError({
        code: 'FILE_NOT_FOUND',
        status: 404,
        message: '报告文件不存在。',
      })
    }

    const { config } = await requirePlatformConfig()
    const resolvedSkill = await resolveSkill(
      { rootDir: config.projectDirectory },
      skillId,
    )
    const reportPath = path.join(
      resolvedSkill.skillRoot,
      TEST_REPORT_DIRECTORY_NAME,
      runId,
      TEST_REPORT_REPORT_FILE_NAME,
    )

    // 双保险：归一后必须仍位于 Skill 目录内（相对前缀校验）。
    const relative = path.relative(resolvedSkill.skillRoot, reportPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ApiError({
        code: 'INVALID_FILE_PATH',
        status: 400,
        message: '报告路径不合法。',
      })
    }

    let reportStat
    try {
      reportStat = await stat(reportPath)
      if (!reportStat.isFile()) {
        throw new Error('not-a-file')
      }
    } catch {
      // 报告被用户手动删除（V7）或尚未生成。
      throw new ApiError({
        code: 'FILE_NOT_FOUND',
        status: 404,
        message: '报告文件不存在。',
      })
    }

    const html = await readFile(reportPath, 'utf8')
    return context.html(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(reportStat.size),
      'Cache-Control': 'no-store',
    })
  })
}

/** 执行记录不存在的 404（服务重启或已被清理，R7）。 */
function executionNotFoundError (): ApiError {
  return new ApiError({
    code: 'EXECUTION_NOT_FOUND',
    status: 404,
    message: '执行记录不存在（可能因本地服务重启而丢失）。',
  })
}

/** 解析并校验 Skill ID 路径参数。 */
function parseSkillId (skillId: string | undefined): string {
  const result = skillIdSchema.safeParse(skillId)

  if (!result.success) {
    throw new ApiError({
      code: 'INVALID_SKILL_ID',
      status: 400,
      message: 'Skill ID 格式不正确。',
    })
  }

  return result.data
}
