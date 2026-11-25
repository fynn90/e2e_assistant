/**
 * 视图宿主（v17 §6.2）：把 `render_view` 的「选择」变成对话流里的只读卡片。
 *
 * ## 核心职责有两件，缺一不可
 *
 *   ① **按 params 自取数据**——本宿主自己检索一遍，模型给的数据一律**忽略**
 *      （协议传的是选择不是数据，见 `packages/agent/src/tools/render-view.ts`）；
 *   ② 填进 payload 并发布为 `workbench_view` 块。
 *
 * 宿主按会话创建（与 `assembleWorkbenchCapability` 的既有接缝一致），
 * 因此「哪个会话、哪个工作区」在构造期就已知，不需要每次渲染都传。
 *
 * ## 渲染与读取工具共用同一批查询函数
 *
 * 清单 / 详情 / 历史的渲染都调 `ISkillCatalog` 的同一批方法——这保证
 * 「模型看到的」与「卡片显示的」必然一致（技术方案 §6.2 末段）。
 *
 * ## 发布门（沿用 v16 的既有机制）
 *
 * 卡片必须在本轮 `turn end` 之后发布，否则会排在 Agent 的说明文本**之前**，
 * 叙述顺序与事实相反。v16 已为 `execute_test` 实现该门，本宿主复用同一门
 *（`PUBLISH_GUARD_MS` 兜底）。
 *
 * ## 行内操作的回指（Q6）
 *
 * 清单卡每行的「执行」「生成脚本」按钮点击后走已有的动作接口。因此渲染清单卡时，
 * 要为每一行**预先登记一张动作卡片记录**（复用 v16 的 `publishAction` 登记机制），
 * 但**不另行发布卡片块**（否则清单卡旁边会多出 20 张动作卡片，滚动与筛选都要
 * 跨块协调）。这是「登记与呈现解耦」：清单卡是呈现，登记是为了让按钮可点。
 */

import { randomUUID } from 'node:crypto'
import { toCapabilityViewPayload } from '@authine-e2e-agent/agent'
import type {
  IReadinessViewPayload,
  ISkillListViewPayload,
  TAgentWorkbenchAction,
  TWorkbenchRenderParams,
} from '@authine-e2e-agent/types'
import type { IAgentWorkRuntime } from '../../agent-runtime/agent-work-runtime'
import type { ISkillCatalog } from './skill-catalog'
import type { IReadinessService } from './execution-readiness'

/**
 * 发布门的兜底等待上限（毫秒）。
 *
 * 与 `workbench-service.ts` 的同名常量同值同理由：正常路径下 `turn end` 在
 * 本轮文本写完后立刻到达；本上限只兜住「等不到 turn end」的异常情形
 *（服务重启后会话状态残留为 running，PRD LOG-4 的已知边界）。
 */
const PUBLISH_GUARD_MS = 120_000

/**
 * 行内动作的登记回调（由工作台服务注入）。
 *
 * 宿主不认识动作登记表——那是工作台服务的内部状态；由它暴露一个「登记但不发布」
 * 的回调，宿主在渲染清单卡时按行调用（依赖倒转：宿主只声明需要什么）。
 */
export interface IInlineActionRegistrar {
  /**
   * 为清单卡的某一行登记一个可点击的动作记录（**不发布卡片块**）。
   *
   * @param input - 动作、目标用例与按钮文案。
   * @returns 登记后的动作 ID（前端行内按钮点击时回传）。
   * @throws 不抛出异常——登记失败时由调用方决定不渲染按钮。
   */
  (input: {
    action: TAgentWorkbenchAction
    skillId: string
    skillTitle: string
    label: string
  }): string
}

/** 视图宿主的构造依赖。 */
export interface IViewHostDependencies {
  /** 会话 ID（发布的目标）。 */
  sessionId: string
  /** 承载该会话的常驻运行时（发布落点）。 */
  runtime: IAgentWorkRuntime
  /** 工作区根目录（检索的解析根）。 */
  rootDir: string
  catalog: ISkillCatalog
  readiness: IReadinessService
  /** 清单卡行内动作的登记回调；缺省时不渲染行内按钮（测试场景可省）。 */
  registerInline?: IInlineActionRegistrar
}

/** 视图宿主接口（与 agent 包的 `IViewHost` 结构兼容）。 */
export interface IWorkbenchViewHost {
  /**
   * 渲染并发布一张只读视图卡。
   *
   * @param params - 模型给出的渲染参数（视图种类 + 范围，不含数据）。
   * @returns 发布结果；目标不存在或参数不合法时为 ok:false 并说明。
   * @throws 不抛出异常——失败以 ok:false 归一，由工具转述给模型。
   */
  renderView(
    params: TWorkbenchRenderParams,
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }>
}

/**
 * 创建视图宿主。
 *
 * @param dependencies - 会话、运行时、工作区与检索/体检依赖。
 * @returns 可注入给 `createRenderViewTool` 的宿主。
 * @throws 不抛出异常。
 */
export function createViewHost(
  dependencies: IViewHostDependencies,
): IWorkbenchViewHost {
  return {
    renderView: (params) => renderView(dependencies, params),
  }
}

/**
 * 按 `viewKind` 分派渲染。
 *
 * @param dependencies - 宿主依赖。
 * @param params - 渲染参数。
 * @returns 发布结果。
 * @throws 不抛出异常。
 */
async function renderView(
  dependencies: IViewHostDependencies,
  params: TWorkbenchRenderParams,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  switch (params.viewKind) {
    case 'skill-list':
      return renderSkillList(dependencies, params)

    case 'skill-detail': {
      const result = await dependencies.catalog.readTestCase(
        dependencies.rootDir,
        params.skillId,
      )
      if (!result.ok) return { ok: false, message: result.message }
      return publishView(dependencies, {
        viewKind: 'skill-detail',
        skillId: params.skillId,
        payload: result.detail,
        message:
          '用例详情卡已上屏。请用文本补充结论或下一步（如产物是否齐备），不要重复卡片里的字段。',
      })
    }

    case 'run-history': {
      const result = await dependencies.catalog.readRunHistory(
        dependencies.rootDir,
        params.skillId,
      )
      if (!result.ok) return { ok: false, message: result.message }
      return publishView(dependencies, {
        viewKind: 'run-history',
        skillId: params.skillId,
        payload: result.history,
        message: result.history.neverExecuted
          ? '执行历史卡已上屏（该用例还没有执行过）。请如实说明「还没有执行过」，并给出执行入口。'
          : '执行历史卡已上屏。若要解读失败原因，请基于失败摘要说明失败发生在哪一步；报告信息不足时如实说明，不要编造。',
      })
    }

    case 'readiness': {
      const result = await dependencies.readiness.check(
        dependencies.rootDir,
        params.skillId,
      )
      if (!result.ok) return { ok: false, message: result.message }
      return publishView(dependencies, {
        viewKind: 'readiness',
        skillId: params.skillId,
        // 修复入口与「全部通过时的执行」都走与清单卡同一套行内登记机制
        //（登记与呈现解耦，Q6/E3 同构）。
        payload: attachReadinessActions(
          dependencies,
          result.readiness,
          params.skillId,
        ),
        message: result.readiness.ok
          ? '体检卡已上屏（全部通过）。卡片上已给出「执行」按钮，请不要再自行发起执行——由用户点击。'
          : '体检卡已上屏（存在未通过项）。请如实说明缺什么、怎么补，并给出对应的修复入口。',
      })
    }

    case 'capability':
      return publishView(dependencies, {
        viewKind: 'capability',
        skillId: null,
        payload: toCapabilityViewPayload(),
        message: '能力卡已上屏。请只补一句引导，不要复述卡片里的清单（H4）。',
      })
  }
}

/**
 * 渲染清单卡（Q1/Q2/Q3/Q6）。
 *
 * @param dependencies - 宿主依赖。
 * @param params - 已窄化的清单筛选参数。
 * @returns 发布结果。
 * @throws 不抛出异常。
 */
async function renderSkillList(
  dependencies: IViewHostDependencies,
  params: { status?: string; keyword?: string; tag?: string },
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const filter = {
    ...(params.keyword ? { keyword: params.keyword } : {}),
    ...(params.tag ? { tag: params.tag } : {}),
    ...(params.status ? { status: params.status as never } : {}),
  }

  const { rows, total } = await dependencies.catalog.listFiltered(
    dependencies.rootDir,
    filter,
  )

  // 行内操作回指（Q6）：为每行登记动作记录，但不发布卡片块。
  const rowsWithActions = rows.map((row) =>
    attachInlineAction(dependencies, row),
  )

  const payload: ISkillListViewPayload = {
    rows: rowsWithActions,
    total,
    filter,
  }

  return publishView(dependencies, {
    viewKind: 'skill-list',
    skillId: null,
    payload,
    message:
      total === 0
        ? '清单卡已上屏（当前条件下没有命中用例）。请如实说明筛选条件与命中为空，并提示可放宽条件。'
        : `清单卡已上屏（${total} 个用例）。请不要再把清单内容写成文字。`,
  })
}

/**
 * 为清单行补行内动作登记（Q6）。
 *
 * 给什么按钮按缺口判定（与 ID-7 同一口径）：产物齐备给「执行」、缺文档给
 * 「生成 SKILL.md」、缺脚本给「生成 Playwright 脚本」。**不提供删除**——
 * 删除只在用例删除卡内进行，避免清单里误触（Q6 / L2）。
 *
 * @param dependencies - 宿主依赖（含登记回调）。
 * @param row - 清单行。
 * @returns 补了行内动作字段的行；登记不可用或失败时不补（前端据此不渲染按钮）。
 * @throws 不抛出异常。
 */
function attachInlineAction(
  dependencies: IViewHostDependencies,
  row: ISkillListViewPayload['rows'][number],
): ISkillListViewPayload['rows'][number] {
  const register = dependencies.registerInline
  if (!register) return row

  const action = pickInlineAction(row)
  try {
    const actionId = register({
      action,
      skillId: row.skillId,
      skillTitle: row.title,
      label: inlineActionLabel(action),
    })
    return { ...row, inlineActionId: actionId, inlineAction: action }
  } catch {
    // 登记失败：不渲染按钮（比渲染一个点了报错的按钮好）。
    return row
  }
}

/**
 * 按缺口挑选行内动作（Q6：不提供删除）。
 *
 * @param row - 清单行。
 * @returns 该行应给的动作。
 * @throws 不抛出异常。
 */
function pickInlineAction(
  row: ISkillListViewPayload['rows'][number],
): TAgentWorkbenchAction {
  if (!row.hasSkillDocument) return 'generate-skill-document'
  if (!row.hasPlaywrightScript) return 'generate-playwright-script'
  return 'execute-test'
}

/**
 * 为体检卡补修复入口与「全部通过时的执行」入口（R3）。
 *
 * 与清单卡的行内按钮**同一套机制**：宿主预先登记动作记录、但只把 actionId
 * 随卡片下发（登记与呈现解耦）。不给 ID 的检查项意味着「这一项没有可点的
 * 修复入口」——例如环境变量缺失要走补齐提案、目标地址缺失要走变更提案，
 * 两者都不在动作枚举里，由 Agent 依体检结果自行发起（前端不渲染按钮）。
 *
 * @param dependencies - 宿主依赖（含登记回调）。
 * @param readiness - 体检载荷（就地补 id 后返回）。
 * @param skillId - 目标用例。
 * @returns 补过入口的载荷；登记不可用或失败时不补对应字段。
 * @throws 不抛出异常。
 */
function attachReadinessActions(
  dependencies: IViewHostDependencies,
  readiness: IReadinessViewPayload,
  skillId: string,
): IReadinessViewPayload {
  const register = dependencies.registerInline
  if (!register) return readiness

  /** 登记一个动作，失败时返回 undefined（不渲染按钮好过渲染一个点了报错的）。 */
  const tryRegister = (action: TAgentWorkbenchAction): string | undefined => {
    try {
      return register({
        action,
        skillId,
        skillTitle: readiness.skillTitle,
        label: inlineActionLabel(action),
      })
    } catch {
      return undefined
    }
  }

  const checks = readiness.checks.map((check) => {
    if (check.ok || !check.fixAction) return check
    const fixActionId = tryRegister(check.fixAction)
    return fixActionId ? { ...check, fixActionId } : check
  })

  // 全部通过才给「执行」——存在未通过项时点执行必然被就绪校验拦下，
  // 那是「给出了一个点了就报错的入口」，比不给更糟（ID-7 的既有口径）。
  const executeActionId = readiness.ok ? tryRegister('execute-test') : undefined

  return {
    ...readiness,
    checks,
    ...(executeActionId ? { executeActionId } : {}),
  }
}

/**
 * 行内动作的按钮文案。
 *
 * @param action - 动作身份。
 * @returns 中文按钮文案。
 * @throws 不抛出异常。
 */
function inlineActionLabel(action: TAgentWorkbenchAction): string {
  switch (action) {
    case 'generate-skill-document':
      return '生成 SKILL.md'
    case 'generate-playwright-script':
      return '生成脚本'
    default:
      return '执行'
  }
}

/** 视图发布的输入。 */
interface IPublishViewInput {
  viewKind:
    'skill-list' | 'skill-detail' | 'run-history' | 'readiness' | 'capability'
  skillId: string | null
  /** 载荷由宿主自取后填充；发布时展开为普通对象交给事件契约。 */
  payload: object
  message: string
}

/**
 * 走发布门把视图块写到会话总线。
 *
 * 发布门与 `execute_test` 的卡片完全同构：
 *   - 有进行中的轮次（用户在对话里问）→ 等 `turn end` 再发布，
 *     让卡片排到 Agent 的说明之后；
 *   - 没有进行中的轮次（用户点历史卡片触发）→ 立即发布，
 *     否则永远等不到 turn end，卡片会凭空消失。
 *
 * @param dependencies - 宿主依赖（会话、运行时）。
 * @param input - 视图种类、目标与载荷。
 * @returns 发布结果（模型可见文本）。
 * @throws 不抛出异常。
 */
function publishView(
  dependencies: IViewHostDependencies,
  input: IPublishViewInput,
): { ok: true; message: string } {
  const { runtime, sessionId } = dependencies
  const viewId = randomUUID()

  const publish = (): void => {
    runtime.publishBlock(sessionId, {
      type: 'workbench_view',
      phase: 'begin',
      viewId,
      viewKind: input.viewKind,
      skillId: input.skillId,
      // 展开成普通对象：事件契约要求 `Record<string, unknown>`，而具体载荷
      // 接口（如 ISkillListViewPayload）没有索引签名——展开后 TS 可直接赋值，
      // 运行时结构不变（前端仍按 viewKind 做一次带校验的窄化）。
      payload: { ...input.payload },
    })
  }

  if (!hasOpenTurn(runtime, sessionId)) {
    publish()
    return { ok: true, message: input.message }
  }

  let published = false
  let guard: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined

  const publishOnce = (): void => {
    if (published) return
    published = true
    if (guard) clearTimeout(guard)
    unsubscribe?.()
    publish()
  }

  // afterSeq 取当前最大序号：只接**之后**的事件。若传 undefined，总线会把
  // 缓冲里的历史事件整体补发，上一条 `turn end` 会立刻把卡片放出去——
  // 发布门就形同虚设。
  unsubscribe = runtime.bus.subscribe(
    sessionId,
    runtime.bus.currentSeq(sessionId),
    (event) => {
      if (event.type !== 'turn' || event.phase !== 'end') return
      publishOnce()
    },
  )
  guard = setTimeout(publishOnce, PUBLISH_GUARD_MS)
  guard.unref?.()

  return { ok: true, message: input.message }
}

/**
 * 判断会话当前是否有**进行中的对话轮次**（与 workbench-service 同口径）。
 *
 * @param runtime - 承载该会话的运行时。
 * @param sessionId - 会话 ID。
 * @returns 存在进行中的轮次时返回 true。
 * @throws 不抛出异常——读取失败按「没有进行中的轮次」处理（立即发布更安全）。
 */
function hasOpenTurn(runtime: IAgentWorkRuntime, sessionId: string): boolean {
  try {
    const summary = runtime
      .listSessions()
      .find((item) => item.sessionId === sessionId)
    return summary?.status === 'running'
  } catch {
    return false
  }
}
