/**
 * 「启动服务」面板的内容装配。
 *
 * 本文件只负责把启动结果翻译成面板字段，不含任何装潢逻辑（边框与配色在
 * panel-renderer.ts）。三种启动结果——新启动、复用、忽略陈旧记录后启动——
 * 共用同一套字段，仅状态与概述行的措辞不同。
 *
 * **概述行是断言载体**：`started in the background` / `already running` /
 * `started at` 等短语必须逐字保留，e2e 用例依赖它们（且测试走无边框层级）。
 */
import { createPanelStyle } from './ansi-style'
import { formatLocalTimestamp } from './format-timestamp'
import {
  renderPanel,
  type IPanelAction,
  type IPanelContent,
  type IPanelField,
} from './panel-renderer'
import { resolveTerminalOutputMode } from './terminal-output-mode'
import {
  createLogFollowAction,
  createStatusAction,
  createStopAction,
} from './panel-actions'
import type { TBashShellProbe } from '../../application/bash-shell-check'

/** 服务标题，前后台与各结果形态一致。 */
const PANEL_TITLE = 'AUTHINE E2E AGENT PLATFORM'

/**
 * 启动面板的输入。
 */
export interface IStartPanelInput {
  /** 启动结果形态，决定概述行措辞。 */
  outcome: 'started' | 'reused' | 'started-after-stale-record'
  /** 运行形态；前台模式的日志不落盘，因此不显示日志路径。 */
  mode: 'foreground' | 'background'
  /** 服务根地址。 */
  serverUrl: string
  /** 监听端口。 */
  port: number
  /** 服务进程号；不可得时不渲染该行。 */
  pid?: number
  /** 服务启动时刻（ISO 8601）；不可得或不合法时不渲染该行。 */
  startedAt?: string
  /** 后台日志文件路径；仅后台模式需要。 */
  logPath?: string
  /**
   * bash 探测结果；仅新启动时有值（复用分支不重新探测）。
   *
   * 缺省时不渲染 bash 行——既不谎报可用，也不给无意义的占位。
   */
  shellProbe?: TBashShellProbe
  /**
   * 日志轮转失败的原因；未失败时不带该字段。
   *
   * 不阻断启动，但必须告知：静默会让用户以为日志是连续的，而实际已被覆盖。
   */
  logRotationFailureReason?: string
  /**
   * 本 CLI 包（`@authine-e2e-agent/cli`）的版本号，**不含 `v` 前缀**。
   *
   * 由命令层从 `infrastructure/cli-package-version` 解析后注入：presentation
   * 层不做 I/O，面板只负责呈现。不可得时为 `null`，此时不渲染该行——与 PID、
   * 启动时间「不可得即不渲染」的约定一致。
   */
  cliVersion: string | null
}

/**
 * 渲染启动面板并返回待打印文本。
 *
 * @param input - 启动结果与终端上下文。
 * @returns 待打印的完整文本（含结尾换行）。
 * @throws 不抛出异常。
 */
export function renderStartPanel(input: IStartPanelInput): string {
  return renderPanel({
    content: buildStartPanelContent(input),
    mode: resolveTerminalOutputMode(),
    style: createPanelStyle(),
    ...(process.stdout.columns !== undefined
      ? { columns: process.stdout.columns }
      : {}),
  })
}

/**
 * 组装启动面板的内容。
 *
 * @param input - 启动结果。
 * @returns 与渲染层级无关的面板内容。
 * @throws 不抛出异常。
 */
export function buildStartPanelContent(input: IStartPanelInput): IPanelContent {
  return {
    title: PANEL_TITLE,
    headline: buildHeadline(input),
    fields: buildFields(input),
    notes: buildNotes(input),
    actions: buildActions(input),
    mascot: buildMascot(input),
  }
}

/**
 * 构造字段行：状态、地址、端口三项恒有，其余按可得性追加。
 *
 * 「不可得就不渲染」而非填占位：PID、启动时间与 CLI 版本在个别路径上拿不到，
 * 补 `undefined` 会让用户误以为读到了一条真实信息。
 *
 * @param input - 启动结果。
 * @returns 字段行列表。
 * @throws 不抛出异常。
 */
function buildFields(input: IStartPanelInput): IPanelField[] {
  const localizedStartedAt = formatLocalTimestamp(input.startedAt)
  const fields: IPanelField[] = [
    { icon: '📌', label: '状态', value: buildStatusValue(input), tone: 'ok' },
    { icon: '🔗', label: '地址', value: input.serverUrl, tone: 'ok' },
    { icon: '🔌', label: '端口', value: String(input.port) },
  ]

  if (input.pid !== undefined) {
    fields.push({ icon: '🆔', label: 'PID', value: String(input.pid) })
  }

  if (localizedStartedAt) {
    fields.push({ icon: '🕒', label: '启动时间', value: localizedStartedAt })
  }

  // CLI 版本行：取代原先的「协议」行。协议版本是服务间比对用的内部标识，
  // 对用户没有意义；用户真正需要的是「我装的是哪个版本的 CLI」，出问题时
  // 报版本号即可。不可得时不渲染，不补占位。
  // 图标用 📦 且与 status 面板的同行保持一致：🧩 在 status 面板仍属「协议」行，
  // 同一行在两处面板上换图标会让人误以为是两回事。
  if (input.cliVersion) {
    fields.push({
      icon: '📦',
      label: 'cli',
      value: `v${input.cliVersion}`,
    })
  }

  // bash 工具可用性：Windows 上探测不到 bash 时 Agent 的 bash 工具不可用，
  // 这对「能不能跑测试」影响很大，值得在启动面板上直接说明。
  // 非 Windows 平台不显示该行——那里不缺 bash，显示只会增噪。
  if (input.shellProbe?.outcome === 'found') {
    fields.push({ icon: '🐚', label: 'bash', value: '已就绪' })
  } else if (input.shellProbe?.outcome === 'missing') {
    fields.push({ icon: '🐚', label: 'bash', value: '未找到', tone: 'warn' })
  }

  // 日志路径只对后台模式有意义：前台模式的日志直接刷在它自己的终端里。
  if (input.mode === 'background' && input.logPath) {
    fields.push({ icon: '📜', label: '日志', value: input.logPath })
  }

  return fields
}

/**
 * 构造命令提示：每条命令一行，尾部跟一句作用说明。
 *
 * 三件事按「刚启动后最可能想做什么」排序：看日志 → 查状态 → 停服务。
 * 查看日志仅后台模式提供（前台模式的日志就在它自己的终端里，跟随无意义）。
 *
 * @param input - 启动结果。
 * @returns 命令提示列表。
 * @throws 不抛出异常。
 */
function buildActions(input: IStartPanelInput): IPanelAction[] {
  const actions: IPanelAction[] = []

  if (input.mode === 'background') {
    actions.push(createLogFollowAction())
  }

  actions.push(createStatusAction())
  actions.push(createStopAction())

  return actions
}

/**
 * 构造概述行：一句话说清本次启动的结果。
 *
 * **刻意不带地址**：地址已有独立字段，重复一遍既冗长又会在窄卡片上折行，
 * 把 `started in the background` 这类关键短语切断——而它是 e2e 的断言目标。
 * 保持短句可确保任何宽度下短语都落在同一行内。
 *
 * 措辞按结果形态区分，**关键短语不可改动**（`started in the background`、
 * `already running` 为 e2e 断言目标）。
 *
 * @param input - 启动结果。
 * @returns 概述行文本。
 * @throws 不抛出异常。
 */
function buildHeadline(input: IStartPanelInput): string {
  if (input.outcome === 'reused') {
    return '♻️ Authine E2E Agent Platform is already running'
  }

  if (input.mode === 'background') {
    return '🚀 Authine E2E Agent Platform started in the background'
  }

  return '🚀 Authine E2E Agent Platform started'
}

/**
 * 构造状态字段的值：一行中文说清本次启动属于哪种情形。
 *
 * 与概述行互补——概述行承载可断言的英文原句，状态行给人一眼可读的结论。
 *
 * @param input - 启动结果。
 * @returns 状态文本。
 * @throws 不抛出异常。
 */
function buildStatusValue(input: IStartPanelInput): string {
  if (input.outcome === 'reused') {
    return '已复用 · 服务已在运行'
  }

  if (input.mode === 'background') {
    return '已启动 · 后台运行中'
  }

  return '已启动 · 前台运行中'
}

/**
 * 构造补充说明行。
 *
 * @param input - 启动结果。
 * @returns 说明文本列表；无需说明时为空数组。
 * @throws 不抛出异常。
 */
function buildNotes(input: IStartPanelInput): string[] {
  const notes: string[] = []

  if (input.outcome === 'started-after-stale-record') {
    notes.push(
      '⚠️ 检测到陈旧的运行态记录（原服务已不再运行），已自动忽略并启动新服务。',
    )
  }

  if (input.logRotationFailureReason) {
    notes.push(`⚠️ ${input.logRotationFailureReason}`)
  }

  if (input.shellProbe?.outcome === 'missing') {
    // 修复指引必须在**启动它的那个终端**里给出：后台模式下这行若打印在
    // 子进程，只会落进日志文件，用户看不到。
    notes.push(
      '⚠️ 未找到 bash，Agent 的 bash 工具将不可用（其他功能不受影响）。修复方式任选其一后重启服务：',
    )
    notes.push(
      '1. 安装 Git for Windows（https://git-scm.com/download/win），使用默认安装路径；',
    )
    notes.push('2. 将已有 bash.exe 所在目录加入系统 PATH。')
  }

  return notes
}

/**
 * 构造吉祥物台词。
 *
 * @param input - 启动结果。
 * @returns 台词文本。
 * @throws 不抛出异常。
 */
function buildMascot(input: IStartPanelInput): string {
  if (input.outcome === 'reused') {
    return '( •_•)  我早就在这儿干活了，没重复启动哦～'
  }

  if (input.mode === 'foreground') {
    return '( •_•)  我就在这个终端里跑，按 Ctrl+C 可以让我下班～'
  }

  return '( •_•)  我先去后台待命了，有事随时喊我～'
}
