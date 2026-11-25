/**
 * 侧边栏内容的纯派生逻辑（PRD 5.4、6.3–6.7）。
 *
 * 全部为纯函数：输入阶段记录，输出渲染所需的数据形状。
 * 组件只做渲染，**不含任何状态判定**——「副标题文案、关闭按钮归属哪张卡、
 * 主按钮何时置灰」这类规则集中在此处（PRD 14.3 分层约束）。
 */
import type {
  IFailureCard,
  IProductCard,
  IStageRecord,
  TSidebarItem,
} from './types'
import { isStageRunning } from './types'

/**
 * 按 PRD 5.4 的出现规则把阶段记录展开为侧边栏内容项。
 *
 * 规则：
 *   - 阶段区块一开始就出现；
 *   - 产物卡片只在「完成」时出现；
 *   - 失败 / 取消时出现终止卡片，不出现产物卡片。
 *
 * @param stages - 按发生顺序排列的阶段记录。
 * @returns 平级排列的阶段区块与卡片项。
 */
export function toSidebarItems(
  stages: readonly IStageRecord[],
): TSidebarItem[] {
  return stages.flatMap((stage) => [
    { kind: 'stage' as const, key: `stage:${stage.kind}`, stage },
    ...(stage.card
      ? [{ kind: 'card' as const, key: stage.card.key, card: stage.card }]
      : []),
    ...(stage.failureCard
      ? [
          {
            kind: 'failure' as const,
            key: stage.failureCard.key,
            card: stage.failureCard,
          },
        ]
      : []),
  ])
}

/**
 * 派生唯一承载关闭按钮的「最新卡片」标识（PRD 6.6）。
 *
 * 关闭按钮只出现在最新卡片上；有任务运行时返回 null，使所有卡片都不渲染关闭按钮。
 * 判定集中在此处而非散落在各卡片组件内。
 *
 * @param stages - 按发生顺序排列的阶段记录。
 * @returns 最新卡片的 key；无卡片或存在运行中阶段时返回 null。
 */
export function deriveLatestCardKey(
  stages: readonly IStageRecord[],
): string | null {
  if (stages.some((stage) => isStageRunning(stage))) return null

  // 从后往前找第一张存在的卡片：流程终点的产物卡片或终止卡片即「最新」。
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const stage = stages[index]!
    if (stage.card) return stage.card.key
    if (stage.failureCard) return stage.failureCard.key
  }

  return null
}

/**
 * 派生 SKILL.md 卡片主按钮的置灰状态（PRD 6.7）。
 *
 * 主按钮执行成功后不消失，而是置灰并追加执行结果标记
 * （`✓ 已于 {时间} 生成`），使卡片整体成为不可变的历史记录。
 *
 * @param stages - 按发生顺序排列的阶段记录。
 * @param card - 待判定的 SKILL.md 卡片。
 * @returns 置灰信息；无需置灰时返回 null。
 */
export function derivePrimaryAction(
  stages: readonly IStageRecord[],
  card: IProductCard,
): { executedAt: string; label: string } | null {
  if (card.kind !== 'skill-document') return card.primaryAction ?? null

  const scriptStage = stages.find((stage) => stage.kind === 'script')
  if (!scriptStage) return card.primaryAction ?? null

  // 脚本阶段一旦开始，SKILL.md 卡片即成为历史卡片：主按钮置灰并标注执行时间。
  return {
    executedAt: scriptStage.startedAt,
    label: `生成 Playwright 脚本 ✓ 已于 ${formatClockTime(scriptStage.startedAt)} 生成`,
  }
}

/**
 * 把阶段记录列表归约为流程整体阶段。
 *
 * 以**最后一个有状态的阶段**为准：脚本阶段一旦存在就代表流程已推进，
 * 用户看到的就是脚本阶段的状态（PRD 5.2）。
 *
 * @param stages - 按发生顺序排列的阶段记录。
 * @returns 流程整体阶段标识。
 */
export function deriveFlowPhaseFromStages(
  stages: readonly IStageRecord[],
): import('./types').TFlowPhase {
  const last = stages[stages.length - 1]
  if (!last) return 'idle'

  return derivePhase(last)
}

/**
 * 由单个阶段派生流程阶段。
 *
 * @param stage - 阶段记录。
 * @returns 对应流程阶段。
 */
function derivePhase(stage: IStageRecord): import('./types').TFlowPhase {
  const prefix = stage.kind === 'skill' ? 'skill' : 'script'

  switch (stage.status) {
    case 'completed':
      return `${prefix}-completed` as const
    case 'failed':
    case 'conflict':
      return `${prefix}-failed` as const
    case 'cancelled':
      return `${prefix}-cancelled` as const
    default:
      return `${prefix}-running` as const
  }
}

/** `summarizeStage` 的可选入参：注入实时时钟与运行态。 */
export interface ISummarizeStageOptions {
  /**
   * 当前毫秒时间戳，用于把**尚未结束**的思考块计成实时时长。
   *
   * 省略即退化为「只统计已定型的耗时」，与引入实时计时前的行为完全一致——
   * 终态阶段本就不需要它（`durationMs` 已由 `end` 事件给出）。
   *
   * 时钟由调用方**显式注入**而非在本函数内读 `Date.now()`：这样本函数保持纯，
   * 单元测试传一个固定值即可得到确定性断言，无需伪造全局时钟。
   */
  now?: number
  /** 阶段是否仍在运行；决定「无任何统计」时的兜底文案。 */
  running?: boolean
}

/**
 * 由时间线项派生阶段头部的统计摘要（PRD 5.3）。
 *
 * 复用既有 item 结构，不新增数据来源。例：`已思考 12 秒 · 8 次工具调用`。
 *
 * 运行中的思考块用 `now - startedAt` 计入实时时长，因此秒数会随 `now` 推进
 * 而增长；已结束的块用 `durationMs`。两者**相加而不是取其一**：一轮对话里
 * 可以有多段思考，先前几段已定型、当前这段仍在跑是常态。
 *
 * @param items - 该阶段的时间线项。
 * @param options - 实时时钟与运行态（均可选，省略时为纯终态语义）。
 * @returns 一行统计文案；运行中且尚无任何统计时返回「准备中…」，
 *          终态且无统计时返回「已完成」。
 * @throws 不抛出异常；`startedAt` 缺失或时序倒挂时该项计 0，不产生负数与 NaN。
 */
export function summarizeStage(
  items: readonly import('../agent-work/timeline').TWorkTimelineItem[],
  options: ISummarizeStageOptions = {},
): string {
  const { now, running = false } = options

  const thinkingMs = items.reduce((total, item) => {
    if (item.kind !== 'thinking') return total
    // 已定型：用服务端给出的精确耗时。
    if (item.durationMs !== undefined) return total + item.durationMs
    // 未定型且没有时钟：无从推算，计 0（保持纯终态语义）。
    if (now === undefined || item.startedAt === undefined) return total
    const elapsed = now - item.startedAt
    // `isFinite` 同时挡掉 NaN 与 Infinity（startedAt 为脏值时）；负数来自
    // 服务端与本地时钟的偏移。两者都计 0，避免「已思考 -3 秒 / NaN 秒」。
    if (!Number.isFinite(elapsed) || elapsed <= 0) return total
    return total + elapsed
  }, 0)
  const toolCount = items.filter((item) => item.kind === 'tool').length
  const commandCount = items.filter((item) => item.kind === 'command').length
  /** 是否已出现思考块（决定「已思考 N 秒」这一项是否展示）。 */
  const hasThinking = items.some((item) => item.kind === 'thinking')
  // 待办进度（v12-pre）：多步骤任务里最有信息量的一项，放最前面。
  // 取最后一块清单（整体替换语义，最新的一块即当前状态）。
  const latestTodo = [...items].reverse().find((item) => item.kind === 'todo')

  const parts: string[] = []
  if (latestTodo && latestTodo.kind === 'todo' && latestTodo.items.length > 0) {
    const completed = latestTodo.items.filter(
      (item) => item.status === 'completed',
    ).length
    parts.push(`任务清单 ${completed}/${latestTodo.items.length}`)
  }
  // 判据是「有没有思考块」而非「耗时是否 > 0」：后者会把「思考块已开始、
  // 但尚未跑满 1 秒」误判成毫无进展。`max(1, ...)` 正是为此而设——
  // 不足 1 秒也按 1 秒展示，不出现「已思考 0 秒」。
  if (thinkingMs > 0 || hasThinking) {
    parts.push(`已思考 ${Math.max(1, Math.round(thinkingMs / 1000))} 秒`)
  }
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  if (commandCount > 0) parts.push(`${commandCount} 次命令执行`)

  if (parts.length > 0) return parts.join(' · ')
  // 运行中尚无数据（阶段刚启动、第一个思考块还没到）：不能显示「已完成」，
  // 那会与同一行右侧的「进行中」徽标自相矛盾。
  return running ? '准备中…' : '已完成'
}

/**
 * 构造产物卡片的唯一标识。
 *
 * @param kind - 产物种类。
 * @param version - 本次生成产出的版本或时间戳。
 * @returns 卡片 key。
 */
export function createCardKey(
  kind: 'skill-document' | 'playwright-script',
  version: string,
): string {
  return `card:${kind}:${version}`
}

/**
 * 构造终止卡片的唯一标识。
 *
 * @param kind - 阶段种类。
 * @param status - 终止状态（失败 / 已停止）。
 * @returns 卡片 key。
 */
export function createFailureCardKey(
  kind: 'skill' | 'script',
  status: 'failed' | 'cancelled',
): string {
  return `failure:${kind}:${status}`
}

/**
 * 把 ISO 时间格式化为 `HH:mm`，用于置灰按钮上的时间戳标记（PRD 6.7）。
 *
 * @param isoTimestamp - ISO 8601 时间字符串。
 * @returns 本地时间的时:分文本；无法解析时返回原始文本。
 */
function formatClockTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return isoTimestamp

  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** 类型再导出，方便渲染组件只从本模块引入。 */
export type { IFailureCard, IProductCard, IStageRecord, TSidebarItem }
