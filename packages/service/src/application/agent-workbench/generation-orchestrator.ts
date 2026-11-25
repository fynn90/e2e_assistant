/**
 * 工作台的生成编排（v16 §6.5，决策 D3 的关键）：把「生成」与「保存」串成一次服务端调用。
 *
 * 为什么必须有这一层：Skill 开发页的既有链路里，**生成不保证产物终态落地**——
 *   - 脚本生成只写 `temp/candidate.spec.ts`，正式文件由**前端**在用户确认后另调
 *     `PUT /playwright-script`（F5）；
 *   - SKILL.md 虽由 Agent 直接写盘，但 `manifest.generatedSkill` 元数据只在仓储
 *     `save()` 中提交，且保存写入的是**规范化后的正文**（F6/F7）。
 *
 * `/agent` 场景没有「前端第二步」可依赖（生成全在对话流内完成），若照搬现状，
 * 产物会停在「磁盘上有半成品、元数据缺失」的状态。因此本模块把两步都编排到底。
 *
 * 与既有链路的关系：**不是新建生成能力**，只是把既有的 `generateX` 与 `saveX`
 * 在服务端连起来；Skill 开发页的链路完全不变（两者共用同一批底层服务）。
 *
 * 为什么必须放在同一次调用内：`generatePlaywrightScript` 在 `finally` 中清理整个
 * `temp/`，保存必须在它返回后立刻完成；且生成的版本字段（sourceHash / scriptVersion
 * / skillDocumentVersion）是保存的乐观锁输入，跨调用传递会引入一致性风险。
 */

import { randomUUID } from 'node:crypto'
import type { IAuthinePlatformConfig } from '../../config/config-store'
import type { IGenerationTaskRegistry } from '../../generation-runtime/generation-task-registry'
import type { IGenerationBrowserHost } from '../../generation-runtime/browser-session-host'
import type { IAgentWorkRuntime } from '../../agent-runtime/agent-work-runtime'
import type { IE2ETestCaseApplicationServices } from '../e2e-test-case/application-types'
import type { IRepairContext } from '../e2e-test-case/playwright-script-generator'
import type {
  IGeneratePlaywrightData,
  ISkillDocumentGenerationResult,
} from '@authine-e2e-agent/types'
import { ApiError } from '../../shared/errors/api-error'
import { SkillManagerError } from '@authine-e2e-agent/skill-manager'

/** 工作台可发起的生成动作。 */
export type TGenerationAction =
  | 'generate-skill-document'
  | 'generate-playwright-script'
  | 'update-playwright-script'
  | 'retry'
  /**
   * 修复脚本（v17，PRD G2）：
   *
   * 与 `update-playwright-script` 走**同一条生成链路**，差别只在**入参**
   * ——本动作携带 `repairContext`（失败报告摘要），服务端把它写进生成 prompt。
   * 实现上等同整体重生成，因此发起前必须告知（G2b），且与 GEN-10 的
   * 手工编辑覆盖确认合并为一次（不得连弹两次）。
   */
  | 'repair-script'

/** 一次生成编排的结果。 */
export interface TGenerationOutcome {
  ok: boolean
  /** 面向用户与模型的结果说明（成功含产物摘要，失败含原因）。 */
  message: string
  /** 目标用例标题（卡片展示用）。 */
  skillTitle?: string
  /** 被安全族诊断阻断（v15）：文案需说明违规类别与修复方向。 */
  blocked?: boolean
}

/** 生成编排的依赖（组合根注入）。 */
export interface IGenerationOrchestratorDependencies {
  /** 任务注册表（与 Skill 开发页共用，跨入口互斥）。 */
  taskRegistry: IGenerationTaskRegistry
  /** 应用服务聚合（生成 + 保存），缺省由组合根注入真实实现。 */
  services?: IE2ETestCaseApplicationServices
  /** 浏览器宿主（脚本生成的页面核对），缺省由组合根注入。 */
  browserHost?: IGenerationBrowserHost
  /** 平台配置解析（模型与工作区），缺省由组合根注入。 */
  resolveConfig?: () => Promise<IAuthinePlatformConfig>
}

/** 生成编排接口。 */
export interface IGenerationOrchestrator {
  /**
   * 编排一次生成：发起子会话 → 生成 → 服务端落盘 → 卡片终态。
   *
   * @param input - 工作区、发起会话、目标用例与生成动作。
   * @returns 生成结果（成功/失败与说明）。
   * @throws 不抛出异常——所有失败都归一为 `{ ok: false }` 结果。
   */
  run(input: {
    rootDir: string
    sessionId: string
    /** 承载发起会话的常驻运行时（生成卡片的发布落点）。 */
    runtime: IAgentWorkRuntime
    skillId: string
    skillTitle: string
    action: TGenerationAction
    /**
     * 修复上下文（v17 G2；仅 `repair-script` 使用）。
     *
     * 由工作台服务读出失败摘要后传入——生成编排不自己去读报告
     *（读盘与脱敏属于服务的职责，编排只负责把上下文交给生成器）。
     */
    repairContext?: IRepairContext
  }): Promise<TGenerationOutcome>
}

/**
 * 创建生成编排。
 *
 * @param dependencies - 任务注册表、运行时解析与（可选）应用服务。
 * @returns 生成编排实例。
 * @throws 不抛出异常。
 */
export function createGenerationOrchestrator(
  dependencies: IGenerationOrchestratorDependencies,
): IGenerationOrchestrator {
  return {
    async run(input) {
      const config = await resolveConfig(dependencies)
      if (!config) {
        return {
          ok: false,
          message: '平台配置不可用（模型或项目目录未配置），无法发起生成。',
        }
      }

      const services = dependencies.services
      const browserHost = dependencies.browserHost
      if (
        !services?.generate ||
        !services.saveScript ||
        !services.generateSkillDocument ||
        !services.saveSkillDocument
      ) {
        return {
          ok: false,
          message: '生成服务未配置完整，无法发起生成。',
        }
      }

      // 生成会话 ID：子会话（kind: 'generation'）承载 Agent 的工作过程，
      // 工作台卡片内嵌订阅它的时间线（GEN-3：与开发页侧边栏同源同构）。
      const generationSessionId = randomUUID()
      const startedAt = Date.now()
      const runtime = input.runtime

      // 生成卡片：同一 blockId 在终态时被重发（物化落盘 → 历史回看可还原）。
      runtime.publishTaskCard({
        sessionId: input.sessionId,
        taskId: generationSessionId,
        taskKind: 'generation',
        skillId: input.skillId,
        skillTitle: input.skillTitle,
        status: 'running',
        startedAt,
      })

      // 互斥（GEN-6 / RUN-3）：与 Skill 开发页共用同一注册表，跨入口天然互斥。
      let lease
      try {
        lease = dependencies.taskRegistry.acquire(
          input.skillId,
          generationSessionId,
        )
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.message
            : '当前用例已有生成或执行任务正在运行，请等待其结束。'
        runtime.publishTaskCard({
          sessionId: input.sessionId,
          taskId: generationSessionId,
          taskKind: 'generation',
          skillId: input.skillId,
          skillTitle: input.skillTitle,
          status: 'failed',
          startedAt,
          errorMessage: message,
        })
        return { ok: false, message, skillTitle: input.skillTitle }
      }

      try {
        // `retry` 不是一种生成，而是「重做上一步」：它必须按**当前产物缺口**
        // 决定重做哪一步——失败的是 SKILL.md 就该重生成文档，否则重生成脚本。
        // 若笼统按「脚本」执行，文档缺失时重试会直接撞上就绪门槛（GEN-11），
        // 用户看到的就是「点了重试还是报缺文档」。
        const resolvedAction =
          input.action === 'retry'
            ? await resolveRetryAction(config.projectDirectory, input.skillId)
            : input.action

        const outcome =
          resolvedAction === 'generate-skill-document'
            ? await runSkillDocumentGeneration({
                config,
                input,
                generationSessionId,
                services,
              })
            : await runScriptGeneration({
                config,
                input,
                generationSessionId,
                services,
                ...(browserHost ? { browserHost } : {}),
              })

        runtime.publishTaskCard({
          sessionId: input.sessionId,
          taskId: generationSessionId,
          taskKind: 'generation',
          skillId: input.skillId,
          skillTitle: input.skillTitle,
          status: outcome.ok ? 'completed' : 'failed',
          startedAt,
          ...(outcome.ok
            ? {
                summary: { diagnostics: outcome.diagnostics },
                artifacts: outcome.artifacts,
              }
            : { errorMessage: outcome.message }),
          // 进行中的任务卡片不携带终态字段（类型上可选，语义上不应出现）。
        })

        // 生成是单轮任务：子会话结束后立即释放，避免任务句柄长期滞留
        //（工作块已物化落盘，历史记录不受释放影响）。
        await runtime.releaseSession(generationSessionId)

        // 安全族阻断标记只在失败分支存在（v15）：用判别收窄而不是可选访问。
        if (outcome.ok) {
          return {
            ok: true,
            message: outcome.message,
            skillTitle: input.skillTitle,
          }
        }
        return {
          ok: false,
          message: outcome.message,
          skillTitle: input.skillTitle,
          ...(outcome.blocked ? { blocked: true } : {}),
        }
      } finally {
        lease.release()
      }
    },
  }
}

/** 生成路径的公共输入。 */
interface IGenerationInput {
  config: IAuthinePlatformConfig
  input: {
    rootDir: string
    sessionId: string
    skillId: string
    skillTitle: string
    action: TGenerationAction
    repairContext?: IRepairContext
  }
  generationSessionId: string
  services: IE2ETestCaseApplicationServices
}

/**
 * 生成路径的结果（内部形态，含卡片所需字段）。
 *
 * 判别依据是 `ok`：成功分支携带诊断计数与产物完备性（卡片摘要与下一步引导都要），
 * 失败分支携带可选的安全族阻断标记（v15：文案需说明违规类别）。
 */
interface IGenerationSuccess {
  ok: true
  message: string
  diagnostics: number
  artifacts: { hasSkillDocument: boolean; hasPlaywrightScript: boolean }
}

/** 生成失败的内部结果。 */
interface IGenerationFailure {
  ok: false
  message: string
  blocked?: boolean
}

/** 生成路径的结果（内部形态，含卡片所需字段）。 */
type TGenerationInternalOutcome = IGenerationSuccess | IGenerationFailure

/**
 * SKILL.md 生成 + 服务端落盘（§6.5 的第一条链路）。
 *
 * @param options - 配置、输入、子会话 ID 与应用服务。
 * @returns 生成结果。
 * @throws 不抛出异常——失败归一为 `{ ok: false }`。
 */
async function runSkillDocumentGeneration(
  options: IGenerationInput,
): Promise<TGenerationInternalOutcome> {
  const { config, input, generationSessionId, services } = options
  const abortController = new AbortController()

  try {
    // 第一步：生成。Agent 在子会话中写 SKILL.md 并回读比对。
    const request = await buildSkillDocumentRequest(
      config.projectDirectory,
      input.skillId,
    )
    const generated = (await services.generateSkillDocument!({
      config,
      skillId: input.skillId,
      sessionId: generationSessionId,
      request,
      signal: abortController.signal,
    })) as ISkillDocumentGenerationResult

    // 第二步：保存。提交 manifest 元数据与规范化正文（F6/F7 的缺口在此补齐）。
    const saved = await services.saveSkillDocument!({
      rootDir: config.projectDirectory,
      skillId: input.skillId,
      request: {
        content: generated.content,
        sourceHash: generated.sourceHash,
        expectedSkillDocumentVersion: generated.skillDocumentVersion,
        mode: 'generation',
      },
    })

    const diagnostics = saved.diagnostics.length
    return {
      ok: true,
      message:
        diagnostics > 0
          ? `SKILL.md 已生成并保存（${diagnostics} 项提示，见产物卡片）。`
          : 'SKILL.md 已生成并保存。',
      diagnostics,
      artifacts: {
        hasSkillDocument: true,
        hasPlaywrightScript: await hasScript(
          config.projectDirectory,
          input.skillId,
        ),
      },
    }
  } catch (error) {
    return { ok: false, ...describeGenerationFailure(error, 'SKILL.md') }
  } finally {
    abortController.abort()
  }
}

/**
 * Playwright 脚本生成 + 服务端落盘（§6.5 的第二条链路）。
 *
 * @param options - 配置、输入、子会话 ID、应用服务与浏览器宿主。
 * @returns 生成结果。
 * @throws 不抛出异常——失败归一为 `{ ok: false }`。
 */
async function runScriptGeneration(
  options: IGenerationInput & { browserHost?: IGenerationBrowserHost },
): Promise<TGenerationInternalOutcome> {
  const { config, input, generationSessionId, services, browserHost } = options
  const abortController = new AbortController()

  try {
    if (!browserHost) {
      return {
        ok: false,
        message: '浏览器宿主未配置，无法发起脚本生成（需要核对目标页面）。',
      }
    }

    // 生成前的环境检查：Chromium 不可用时先自动安装，安装失败不请求模型。
    await browserHost.ensureChromium()

    // 第一步：生成（Agent 只写 temp/candidate.spec.ts + 页面核对）。
    const request = await buildScriptRequest(
      config.projectDirectory,
      input.skillId,
    )
    const generated = (await services.generate({
      config,
      skillId: input.skillId,
      sessionId: generationSessionId,
      request,
      // v17 G2：修复上下文直通生成器（缺省时是普通更新 / 生成）。
      ...(input.repairContext ? { repairContext: input.repairContext } : {}),
      signal: abortController.signal,
      registerBrowserHost: (context) =>
        browserHost.acquire({
          sessionId: context.sessionId,
          headed: context.headed,
          baseUrl: context.baseUrl,
          signal: context.signal,
          skillRoot: context.skillRoot,
          skillId: context.skillId,
          // 前端两步式的残留：`skillId` 与 `skillRoot` 都可能缺省，此处透传即可。
          // v20：带上工作区根目录，使宿主能构造凭据解析器读取该 Skill 的 env.json。
          rootDir: config.projectDirectory,
        }),
    })) as IGeneratePlaywrightData

    // 第二步：保存（写入正式 test.spec.ts + 提交 generatedScript 元数据）。
    // 必须在同一次调用内完成——generate 的 finally 会清理整个 temp/。
    const saved = await services.saveScript({
      rootDir: config.projectDirectory,
      skillId: input.skillId,
      request: {
        code: generated.code,
        sourceHash: generated.sourceHash,
        expectedScriptVersion: generated.scriptVersion,
        mode: 'generation',
      },
    })

    const diagnostics = saved.diagnostics.length
    return {
      ok: true,
      message:
        diagnostics > 0
          ? `Playwright 脚本已生成并保存（${diagnostics} 项提示，见产物卡片）。`
          : 'Playwright 脚本已生成并保存。',
      diagnostics,
      artifacts: {
        hasSkillDocument: true,
        hasPlaywrightScript: true,
      },
    }
  } catch (error) {
    return { ok: false, ...describeGenerationFailure(error, '脚本') }
  } finally {
    abortController.abort()
  }
}

/**
 * 解析生成请求的用例版本（生成与保存的乐观锁输入）。
 *
 * @param rootDir - 工作区根目录。
 * @param skillId - 用例 ID。
 * @returns 用例文件版本与当前 SKILL.md 版本（不存在时为 null）。
 * @throws ApiError 用例或文件不可读时抛出（E2E_SCHEMA_INVALID）。
 */
async function buildSkillDocumentRequest(
  rootDir: string,
  skillId: string,
): Promise<{
  expectedTestCaseFileVersion: string
  expectedSkillDocumentVersion: string | null
}> {
  const { FileE2ETestCaseRepository, FileSkillDocumentRepository } =
    await import('@authine-e2e-agent/skill-manager')
  const storage = { rootDir }

  try {
    const testCaseDocument = await new FileE2ETestCaseRepository(
      storage,
    ).findBySkillId(skillId)
    const documentState = await new FileSkillDocumentRepository(
      storage,
    ).getState(skillId, testCaseDocument.sourceHash)

    return {
      expectedTestCaseFileVersion: testCaseDocument.version,
      expectedSkillDocumentVersion: documentState.version,
    }
  } catch (error) {
    throw new ApiError({
      code: 'E2E_SCHEMA_INVALID',
      status: 400,
      message: '无法读取该用例的结构化数据，请先修复用例内容后再生成。',
      cause: error,
    })
  }
}

/**
 * 解析脚本生成请求的版本（与 SKILL.md 链路同构）。
 *
 * @param rootDir - 工作区根目录。
 * @param skillId - 用例 ID。
 * @returns 用例文件版本与当前脚本版本（不存在时为 null）。
 * @throws ApiError 用例或文件不可读时抛出。
 */
async function buildScriptRequest(
  rootDir: string,
  skillId: string,
): Promise<{
  expectedTestCaseFileVersion: string
  expectedScriptVersion: string | null
}> {
  const { FileE2ETestCaseRepository, FilePlaywrightScriptRepository } =
    await import('@authine-e2e-agent/skill-manager')
  const storage = { rootDir }

  try {
    const testCaseDocument = await new FileE2ETestCaseRepository(
      storage,
    ).findBySkillId(skillId)
    const script = await new FilePlaywrightScriptRepository(
      storage,
    ).findBySkillId(skillId)

    return {
      expectedTestCaseFileVersion: testCaseDocument.version,
      expectedScriptVersion: script?.version ?? null,
    }
  } catch (error) {
    throw new ApiError({
      code: 'E2E_SCHEMA_INVALID',
      status: 400,
      message: '无法读取该用例的结构化数据，请先修复用例内容后再生成脚本。',
      cause: error,
    })
  }
}

/**
 * 把生成过程中的异常归一为面向用户的说明（v15 安全族阻断与质量告警在此分叉）。
 *
 * @param error - 捕获到的异常。
 * @param artifactName - 产物名（'SKILL.md' 或 '脚本'）。
 * @returns 失败说明与是否属安全族阻断。
 * @throws 不抛出异常。
 */
function describeGenerationFailure(
  error: unknown,
  artifactName: string,
): { message: string; blocked?: boolean } {
  if (error instanceof ApiError && error.code === 'PLAYWRIGHT_SCRIPT_INVALID') {
    // v15：脚本生成产物含安全族的缺失（静态校验未过），属阻断。
    return {
      message: `${artifactName}生成被阻断：${error.message}`,
      blocked: true,
    }
  }

  if (error instanceof SkillManagerError) {
    if (error.code === 'SKILL_DOCUMENT_INVALID') {
      return {
        message: `SKILL.md 存在缺陷，脚本生成要求文档零缺陷：${error.message}`,
      }
    }
    if (error.code === 'FILE_VERSION_CONFLICT') {
      return {
        message: '用例在生成期间被修改（版本冲突），请重新发起生成。',
      }
    }
    if (error.code === 'SOURCE_HASH_CONFLICT') {
      return {
        message: '用例数据在生成期间被外部修改，产物来源不一致，请重新生成。',
      }
    }
    return { message: `${artifactName}生成失败：${error.message}` }
  }

  if (error instanceof ApiError && error.code === 'ENV_FILE_INVALID') {
    return {
      message:
        '用例引用的环境变量在 env.json 中缺失或类型不符，请先在用例编辑页补齐。',
    }
  }

  return {
    message: `${artifactName}生成失败：${
      error instanceof Error ? error.message : String(error)
    }`,
  }
}

/**
 * 解析「重试」要重做哪一步（按当前产物缺口）。
 *
 * @param rootDir - 工作区根目录。
 * @param skillId - 用例 ID。
 * @returns 缺文档则重生成文档，否则重生成脚本。
 * @throws 不抛出异常——读取失败按「重生成文档」处理（更保守，不会跳过前置）。
 */
async function resolveRetryAction(
  rootDir: string,
  skillId: string,
): Promise<'generate-skill-document' | 'generate-playwright-script'> {
  try {
    const { FileSkillDocumentRepository } =
      await import('@authine-e2e-agent/skill-manager')
    const state = await new FileSkillDocumentRepository({ rootDir }).getState(
      skillId,
      '',
    )
    return state.exists
      ? 'generate-playwright-script'
      : 'generate-skill-document'
  } catch {
    // 读不到文档状态：按「先生成文档」处理——脚本生成的就绪门槛本就要求
    // 文档零缺陷，重试时先补文档是安全方向（GEN-11）。
    return 'generate-skill-document'
  }
}

/**
 * 判断某用例是否已有 test.spec.ts（生成终态的产物完备性）。
 *
 * @param rootDir - 工作区根目录。
 * @param skillId - 用例 ID。
 * @returns 存在返回 true。
 * @throws 不抛出异常——读取失败按不存在处理。
 */
async function hasScript(rootDir: string, skillId: string): Promise<boolean> {
  try {
    const { PLAYWRIGHT_SCRIPT_FILE_NAME, readSkillFile } =
      await import('@authine-e2e-agent/skill-manager')
    await readSkillFile({ rootDir }, skillId, PLAYWRIGHT_SCRIPT_FILE_NAME)
    return true
  } catch {
    return false
  }
}

/**
 * 解析平台配置：依赖可注入（测试替身），缺省留给组合根实现。
 *
 * @param dependencies - 编排依赖。
 * @returns 平台配置；不可用时返回 undefined。
 * @throws 不抛出异常——解析失败按「配置不可用」处理。
 */
async function resolveConfig(
  dependencies: IGenerationOrchestratorDependencies,
): Promise<IAuthinePlatformConfig | undefined> {
  if (!dependencies.resolveConfig) return undefined
  try {
    return await dependencies.resolveConfig()
  } catch {
    return undefined
  }
}
