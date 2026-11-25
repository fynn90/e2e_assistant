/**
 * 生成任务的浏览器会话宿主：把 playwright-engine 的浏览器能力接入 Agent 工具。
 *
 * 职责（v7-technical-design 5.5）：
 *   - 在生成任务开始前确认本机 Chromium 可用，缺失时自动安装（PRD 2.1-10 / AC-01）；
 *   - 按 browserVisualization 以有头 / 无头模式创建浏览器会话（PRD 8.2 / AC-06）；
 *   - 把会话登记到 agent 包的浏览器注册表，使该会话的 Agent 获得 browser_* 工具；
 *   - 任务结束（成功、失败、取消）时注销登记并关闭浏览器，释放本机资源（PRD 4.2 / 15.5）。
 *
 * 与 Agent 的分工：Agent 只调用工具读写页面，不管理浏览器进程；
 * 浏览器生命周期完全由本模块拥有，因此 agent 包对 playwright-engine 只依赖类型契约。
 */

import {
  browserSessionRegistry,
  createBrowserSessionHost,
  type IBrowserSessionHost,
  type IScreenshotArchive,
  type IVisualBaselineArchive,
} from '@charlie_deng/e2e-assistant-agent'
import {
  writeExplorationScreenshot,
  writeVisualBaseline,
} from '@charlie_deng/e2e-assistant-skill-manager'
import {
  ChromiumInstaller,
  PlaywrightBrowserSessionFactory,
  type IBrowserSession,
  type IChromiumInstaller,
  type IChromiumStatus,
} from '@charlie_deng/e2e-assistant-playwright-engine'
import { ApiError } from '../shared/errors/api-error'
import { createSkillCredentialResolver } from './credential-resolver'

/** 浏览器会话宿主的可替换依赖，供测试注入替身以避免真实启动浏览器。 */
export interface IBrowserSessionHostOptions {
  /** Chromium 检测 / 安装器；缺省使用真实实现。 */
  chromiumInstaller?: IChromiumInstaller
  /** 浏览器会话工厂；缺省使用真实 Playwright Chromium。 */
  sessionFactory?: Pick<PlaywrightBrowserSessionFactory, 'create'>
}

/**
 * 管理单个生成任务的浏览器会话生命周期。
 *
 * 使用方式：
 * ```ts
 * const host = createGenerationBrowserHost()
 * await host.ensureChromium()                  // 生成前环境检查
 * await host.acquire({ sessionId, headed, baseUrl, signal })
 * // ... Agent 在生成期间通过 browser_* 工具访问页面
 * await host.release(sessionId)                // 任务终态释放
 * ```
 */
export interface IGenerationBrowserHost {
  /**
   * 确认本机 Chromium 可用，缺失时自动安装。
   *
   * @returns Chromium 安装状态。
   * @throws ApiError 当自动安装失败时抛出，携带可供用户处理的原因。
   */
  ensureChromium (): Promise<IChromiumStatus>
  /**
   * 为生成会话创建浏览器并登记到 Agent 注册表。
   *
   * @param input - 会话 ID、浏览器模式、基准地址与取消信号。
   * @returns 无返回值；登记成功后该会话的 Agent 即可使用页面核对工具。
   * @throws ApiError 当浏览器启动失败或导航基准地址非法时抛出。
   */
  acquire (input: {
    sessionId: string
    headed: boolean
    baseUrl: string
    signal: AbortSignal
    /**
     * 当前 Skill 根目录（可选）。
     *
     * 提供时截图会归档到 `<skillRoot>/temp/exploration/<sessionId>/` 并在生成过程中
     * 于界面展示（任务终态随 temp/ 删除）；缺省时截图只回传模型、不落盘
     * （与普通 Chat 场景的浏览器能力一致）。
     */
    skillRoot?: string
    /** 当前 Skill ID（可选）；与 skillRoot 同时提供时才启用截图归档。 */
    skillId?: string
    /**
     * 平台工作区根目录（可选，v20）。
     *
     * 与 skillId 同时提供时启用**凭据引用**能力：Agent 可在 `browser_fill` 中
     * 传入 `${ENV:KEY}`，由本宿主读该 Skill 的 env.json 换取真值填入页面。
     * 缺省时不注入解析端口——此时 fill 遇到引用形态会明确报错，而不是静默填入占位符。
     */
    rootDir?: string
  }): Promise<void>
  /**
   * 释放生成会话的浏览器资源并注销登记。
   *
   * @param sessionId - 生成会话 ID。
   * @returns 释放完成；会话不存在时安全无操作。
   * @throws 不抛出异常；释放失败仅记录，避免掩盖生成结果。
   */
  release (sessionId: string): Promise<void>
  /**
   * 关闭全部浏览器会话（服务关闭序列的第二步，v19 §4.2）。
   *
   * 与 `release` 的区别只在触发时机：这里不针对某个任务，而是「服务要停了，
   * 把所有还开着的有头 Chromium 一并关掉」，避免留下孤儿窗口。
   *
   * @returns 全部会话处理完成时兑现。
   * @throws 不抛出异常；单个会话关闭失败只记录，不影响其余会话。
   */
  dispose (): Promise<void>
}

/**
 * 生成一次探查截图的文件名。
 *
 * 命名规则 `<时间戳>-<序号>.png`：时间戳在前使目录内按字典序即时间序
 * （便于人肉排查）；序号用于同一毫秒内连续截图时避免覆盖。
 *
 * @param capturedAt - 截图时刻的毫秒时间戳。
 * @param sequence - 同一毫秒内的序号，从 0 开始。
 * @returns 符合探查产物命名白名单的文件名。
 * @throws 不抛出异常。
 */
function buildScreenshotFileName (capturedAt: number, sequence: number): string {
  return `${String(capturedAt).padStart(13, '0')}-${String(sequence).padStart(2, '0')}.png`
}

/**
 * 创建探查截图的归档端口。
 *
 * 归档只做两件事：把 base64 解码为 PNG 字节写入 Skill 的 temp/exploration 目录，
 * 以及拼出客户端可拉取的 URL。URL 规则与文件服务路由一一对应
 * （`/api/skills/:skillId/exploration/...`），但此处只持有 sessionId——
 * skillId 是 URL 路径的一部分，由注入方提供拼接好的前缀，避免在本模块重复解析 Skill。
 *
 * 落盘位置在 temp/ 之下，因此**不清理由本模块负责**：任务终态整体删除 temp/
 * （见 generate-playwright-script.ts 的 finally），截图随之消失，客户端卡片
 * 转为「截图已失效」占位。这正是「探查截图只在生成过程中有意义」的产品选择。
 *
 * 失败语义：本函数返回的 archive 会向上抛错，由 `browser_screenshot` 工具
 * 捕获后降级为「不展示缩略图」——界面少一张图不应让页面核对整体失败。
 *
 * @param options - Skill 根目录、会话 ID 与 Skill ID（用于拼 URL）。
 * @returns 截图归档端口。
 * @throws 不抛出异常；归档失败由 archive() 自身抛出。
 */
function createExplorationScreenshotArchive (options: {
  skillRoot: string
  sessionId: string
  skillId: string
}): IScreenshotArchive {
  // 同一毫秒内多次截图时用序号区分；计数器按归档器实例隔离，随会话结束释放。
  let lastCapturedAt = 0
  let sequenceWithinMillis = 0

  return {
    async archive (screenshot, context) {
      if (context.capturedAt === lastCapturedAt) {
        sequenceWithinMillis += 1
      } else {
        lastCapturedAt = context.capturedAt
        sequenceWithinMillis = 0
      }

      const fileName = buildScreenshotFileName(
        context.capturedAt,
        sequenceWithinMillis,
      )
      await writeExplorationScreenshot({
        skillRoot: options.skillRoot,
        sessionId: options.sessionId,
        fileName,
        content: Buffer.from(screenshot.data, 'base64'),
      })

      // 无需在此做数量淘汰：产物位于 temp/ 之下，任务终态整目录删除，不会累积。

      return {
        url: `/api/skills/${options.skillId}/exploration/${options.sessionId}/${fileName}`,
        mimeType: screenshot.mimeType,
        width: screenshot.width,
        height: screenshot.height,
      }
    },
  }
}

/**
 * 创建视觉基线的归档端口（v12）。
 *
 * 与探查截图归档的关键差异：**基线是正式产物**，失败必须抛错——
 * 静默降级会让执行期因「基线不存在」而整体失败，且用户看不到根因。
 * 因此本端口不做任何 catch，异常由 `browser_capture_baseline` 工具直接透传给模型。
 *
 * 文件命名由模型在工具参数中给出（`fileName`），落在
 * `<skillRoot>/userWorkSpace/<segments>/`（v14 换根，默认分组 `baselines`），
 * 路径安全校验由 skill-manager 的 `writeVisualBaseline` 统一把关。
 *
 * @param options - Skill 根目录。
 * @returns 视觉基线归档端口。
 * @throws 不抛出异常；归档失败由 archive() 自身抛出。
 */
function createVisualBaselineArchive (options: {
  skillRoot: string
}): IVisualBaselineArchive {
  return {
    async archive (screenshot, context) {
      const relativePath = await writeVisualBaseline({
        skillRoot: options.skillRoot,
        segments: context.segments,
        fileName: context.fileName,
        content: Buffer.from(screenshot.data, 'base64'),
      })

      return {
        relativePath,
        width: screenshot.width,
        height: screenshot.height,
      }
    },
  }
}

/**
 * 创建生成任务的浏览器会话宿主。
 *
 * @param options - 可替换的 Chromium 安装器与会话工厂。
 * @returns 浏览器会话宿主实例。
 * @throws 不抛出异常。
 */
export function createGenerationBrowserHost (
  options: IBrowserSessionHostOptions = {},
): IGenerationBrowserHost {
  const chromiumInstaller = options.chromiumInstaller ?? new ChromiumInstaller()
  const sessionFactory =
    options.sessionFactory ?? new PlaywrightBrowserSessionFactory()

  /** 每个生成会话持有的浏览器会话；释放时统一关闭。 */
  const sessions = new Map<string, IBrowserSession>()

  return {
    async ensureChromium (): Promise<IChromiumStatus> {
      const status = await chromiumInstaller.detect()

      if (status.installed) {
        return status
      }

      // 缺失时执行等价于 `playwright install chromium` 的自动安装（AC-01）。
      try {
        return await chromiumInstaller.install()
      } catch (error) {
        throw new ApiError({
          code: 'INTERNAL_ERROR',
          status: 500,
          message:
            error instanceof Error
              ? `本机缺少 Playwright Chromium，自动安装失败：${error.message}。可手动执行 npx playwright install chromium 后重试。`
              : '本机缺少 Playwright Chromium，自动安装失败。可手动执行 npx playwright install chromium 后重试。',
          cause: error,
        })
      }
    },

    async acquire (input): Promise<void> {
      // 同一会话重复登记视为编排缺陷：先释放旧会话，避免泄漏浏览器进程。
      await this.release(input.sessionId)

      try {
        const session = await sessionFactory.create({
          headed: input.headed,
          baseUrl: input.baseUrl,
          signal: input.signal,
          // v20 凭据代理：仅在能定位到 Skill 时注入解析端口。
          // 不做「缺省也注入一个永远失败的解析器」的兜底——那会把
          // 「本场景不支持凭据引用」与「env.json 里没这个 key」混为一谈。
          ...(input.rootDir && input.skillId
            ? {
              credentialResolver: createSkillCredentialResolver({
                rootDir: input.rootDir,
                skillId: input.skillId,
              }),
            }
            : {}),
        })
        sessions.set(input.sessionId, session)
        // 登记后 Agent 配置工厂才会为该会话注入 browser_* 工具（PRD 4.2 授权边界）。
        // 有 Skill 根目录时一并注入截图归档端口，让界面能看到 Agent 截到的页面。
        const archive =
          input.skillRoot && input.skillId
            ? createExplorationScreenshotArchive({
              skillRoot: input.skillRoot,
              sessionId: input.sessionId,
              skillId: input.skillId,
            })
            : undefined
        // v12：基线归档与探查截图归档各自独立——前者是正式产物，后者是旁路展示能力。
        const baselineArchive = input.skillRoot
          ? createVisualBaselineArchive({ skillRoot: input.skillRoot })
          : undefined
        browserSessionRegistry.register(
          input.sessionId,
          createBrowserSessionHost(
            session,
            archive,
            baselineArchive,
          ) as IBrowserSessionHost,
        )
      } catch (error) {
        throw new ApiError({
          code: 'INTERNAL_ERROR',
          status: 500,
          message:
            error instanceof Error
              ? `无法启动 Playwright 浏览器：${error.message}`
              : '无法启动 Playwright 浏览器。',
          cause: error,
        })
      }
    },

    async release (sessionId: string): Promise<void> {
      // 先注销登记：即使关闭失败，Agent 也不会再拿到已失效的浏览器宿主。
      browserSessionRegistry.unregister(sessionId)
      const session = sessions.get(sessionId)

      if (!session) {
        return
      }

      sessions.delete(sessionId)

      try {
        await session.close()
      } catch {
        // 释放失败不阻断生成结果上报；浏览器进程由 Playwright 自身兜底回收。
      }
    },

    async dispose (): Promise<void> {
      // 先整体取走再逐个关闭：关闭过程中若有新会话被登记（理论上不该发生，
      // 但关闭序列与请求可能并发），它不属于「本次要关掉的那一批」。
      const pendingSessions = [...sessions.entries()]
      sessions.clear()

      for (const [sessionId, session] of pendingSessions) {
        browserSessionRegistry.unregister(sessionId)

        try {
          await session.close()
        } catch {
          // 单个会话关闭失败不影响其余：关闭序列最怕「一个失败让后面的都不执行」。
        }
      }
    },
  }
}
