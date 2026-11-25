/**
 * 「服务状态」面板的内容装配（`e2e_assistant status`）。
 *
 * 三种状态各有不同形态，不可合并：
 *   - `active`  ：服务在运行，给出与 start 面板一致的完整字段；
 *   - `absent`  ：服务未运行（从未启动 / 陈旧记录 / 记录损坏），给启动命令；
 *   - `unknown` ：端口被占用但无法确认身份——**不给任何动作建议**。
 *
 * `unknown` 必须单独呈现而不是并入「未运行」：此时端口已被占，若用户据此
 * 启动，新实例会顺延端口并覆盖运行态记录，让仍可能存活的旧服务彻底失去
 * 可管理性。这一判断与 service-identity.ts 的核心安全性质一脉相承。
 */
import { createPanelStyle } from './ansi-style'
import { formatElapsedDuration, formatLocalTimestamp } from './format-timestamp'
import {
  renderPanel,
  type IPanelAction,
  type IPanelContent,
  type IPanelField,
} from './panel-renderer'
import { resolveTerminalOutputMode } from './terminal-output-mode'
import {
  createLogFollowAction,
  createStartAction,
  createStopAction,
} from './panel-actions'

/** 服务标题，与启停面板保持一致。 */
const PANEL_TITLE = 'AUTHINE E2E AGENT PLATFORM'

/**
 * 状态面板的输入。
 *
 * `kind` 是判别式：`running` 与 `unconfirmable` 都带运行态记录（两者都读到了
 * 记录），`stopped` 只有成因与日志路径。
 */
export type TStatusPanelInput =
  | {
    kind: 'running'
    /** 服务地址。 */
    serverUrl: string
    /** 监听端口。 */
    port: number
    /** 运行形态。 */
    mode: 'foreground' | 'background'
    /** 服务进程号。 */
    pid: number
    /** 启动时刻（ISO 8601）。 */
    startedAt: string
    /**
     * 服务**自报**的协议版本（来自健康探测，不是本地常量）。
     *
     * 这是 status 相对 start 的一处额外价值：start 只能报告自己期望的版本，
     * 而 status 能发现「跑着的是一个旧版服务」。
     */
    version: number
    /**
     * 本 CLI 包（`@authine-e2e-agent/cli`）的版本号，**不含 `v` 前缀**。
     *
     * 与上面的 `version` 是两个不同的概念，故两行并存：
     * 本字段是「我装的 CLI 是哪个版本」，`version` 是「跑着的服务说哪种协议」。
     * 二者不一致正是需要排查的信号（旧服务尚未重启）。
     * 不可得时为 `null`，此时不渲染该行。
     */
    cliVersion: string | null
    /** 日志路径；前台模式不落盘，故为可选。 */
    logPath?: string
  }
  | {
    kind: 'stopped'
    /** 未运行的成因，决定状态值与提示文案。 */
    reason: 'no-record' | 'service-gone' | 'record-invalid'
    /** 日志路径（供服务崩过之后直接查看）。 */
    logPath: string
  }
  | {
    kind: 'unconfirmable'
    /** 无法确认的具体原因，取自状态判定层。 */
    detail: string
    /** 记录中的端口。 */
    port: number
    /** 记录中的进程号。 */
    pid: number
  }

/**
 * 渲染状态面板并返回待打印文本。
 *
 * @param input - 状态查询结果与终端上下文。
 * @returns 待打印的完整文本（含结尾换行）。
 * @throws 不抛出异常。
 */
export function renderStatusPanel (input: TStatusPanelInput): string {
  return renderPanel({
    content: buildStatusPanelContent(input),
    mode: resolveTerminalOutputMode(),
    style: createPanelStyle(),
    ...(process.stdout.columns !== undefined
      ? { columns: process.stdout.columns }
      : {}),
  })
}

/**
 * 组装状态面板的内容。
 *
 * @param input - 状态查询结果。
 * @returns 与渲染层级无关的面板内容。
 * @throws 不抛出异常。
 */
export function buildStatusPanelContent (
  input: TStatusPanelInput,
): IPanelContent {
  if (input.kind === 'running') {
    return buildRunningContent(input)
  }

  if (input.kind === 'unconfirmable') {
    return buildUnconfirmableContent(input)
  }

  return buildStoppedContent(input)
}

/**
 * 组装「服务在运行」的内容。
 *
 * @param input - 运行中的状态信息。
 * @returns 面板内容。
 * @throws 不抛出异常。
 */
function buildRunningContent (
  input: Extract<TStatusPanelInput, { kind: 'running' }>,
): IPanelContent {
  const localizedStartedAt = formatLocalTimestamp(input.startedAt)
  const elapsed = formatElapsedDuration(input.startedAt)
  const fields: IPanelField[] = [
    {
      icon: '📌',
      label: '状态',
      value:
        input.mode === 'background' ? '运行中 · 后台模式' : '运行中 · 前台模式',
      tone: 'ok',
    },
    { icon: '🔗', label: '地址', value: input.serverUrl, tone: 'ok' },
    { icon: '🔌', label: '端口', value: String(input.port) },
    { icon: '🆔', label: 'PID', value: String(input.pid) },
  ]

  if (localizedStartedAt) {
    fields.push({ icon: '🕒', label: '启动时间', value: localizedStartedAt })
  }

  if (elapsed) {
    fields.push({ icon: '⏱️', label: '已运行', value: elapsed })
  }

  // 「cli」在前、「协议」在后：前者是用户手上的东西，后者是服务的自报属性。
  // 两行并存时，二者不一致正好提示「跑着的是一个旧版服务」。
  // 图标不复用 🔌（本面板的「端口」已占用）、🧩（本面板的「协议」保留）。
  if (input.cliVersion) {
    fields.push({ icon: '📦', label: 'cli', value: `v${input.cliVersion}` })
  }

  fields.push({ icon: '🧩', label: '协议', value: `v${input.version}` })

  if (input.logPath) {
    fields.push({ icon: '📜', label: '日志', value: input.logPath })
  }

  // 不提示 `e2e_assistant status`：用户刚刚才敲过它。
  const actions: IPanelAction[] = [createLogFollowAction(), createStopAction()]

  return {
    title: PANEL_TITLE,
    headline: '🟢 Authine E2E Agent Platform is running',
    fields,
    notes: ['ℹ️ 在浏览器打开上面的地址即可进入工作台。'],
    actions,
    mascot: '( •_•)  我一直在这儿待命呢，随时可以开工～',
  }
}

/**
 * 组装「服务未运行」的内容。
 *
 * 三种成因共用同一张卡片，靠状态值与提示行区分——用户最关心的「怎么启动
 * 它」在三种情形下是同一件事，不必为它们各画一张卡。
 *
 * @param input - 未运行的状态信息。
 * @returns 面板内容。
 * @throws 不抛出异常。
 */
function buildStoppedContent (
  input: Extract<TStatusPanelInput, { kind: 'stopped' }>,
): IPanelContent {
  return {
    title: PANEL_TITLE,
    headline: '💤 Authine E2E Agent Platform is not running',
    fields: [
      {
        icon: '📌',
        label: '状态',
        value: resolveStoppedStatusText(input.reason),
      },
      { icon: '📜', label: '日志', value: input.logPath },
    ],
    notes: buildStoppedNotes(input.reason),
    actions: [createStartAction()],
    // 有异常提示时不出吉祥物台词：一边报告残留记录一边卖萌会显得轻佻。
    mascot: buildStoppedMascot(input.reason),
  }
}

/**
 * 依成因给出状态值文本。
 *
 * @param reason - 未运行的成因。
 * @returns 状态值文本。
 * @throws 不抛出异常。
 */
function resolveStoppedStatusText (
  reason: Extract<TStatusPanelInput, { kind: 'stopped' }>['reason'],
): string {
  if (reason === 'no-record') {
    return '未启动 · 服务正在休息'
  }

  if (reason === 'record-invalid') {
    return '未运行 · 记录异常'
  }

  return '未运行 · 服务已停止'
}

/**
 * 依成因给出补充提示。
 *
 * @param reason - 未运行的成因。
 * @returns 说明文本列表；从未启动时为空数组。
 * @throws 不抛出异常。
 */
function buildStoppedNotes (
  reason: Extract<TStatusPanelInput, { kind: 'stopped' }>['reason'],
): string[] {
  if (reason === 'record-invalid') {
    return ['⚠️ 运行态记录已损坏，下次启动时会自动清理。']
  }

  if (reason === 'service-gone') {
    return [
      '⚠️ 检测到上次运行的残留记录（服务已不在运行），下次启动时会自动清理。',
    ]
  }

  return []
}

/**
 * 依成因决定是否给吉祥物台词。
 *
 * @param reason - 未运行的成因。
 * @returns 台词文本；有异常提示时返回空串以省略该行。
 * @throws 不抛出异常。
 */
function buildStoppedMascot (
  reason: Extract<TStatusPanelInput, { kind: 'stopped' }>['reason'],
): string {
  return reason === 'no-record' ? '( -_-)zzZ  我在打盹，喊我一声就起来～' : ''
}

/**
 * 组装「无法确认状态」的内容。
 *
 * 刻意**不给任何命令提示**：此时没有安全的自动操作可推荐——启动会抢占被
 * 占用的端口并覆盖记录，停止则可能误杀无关进程。只陈述事实，交用户处置。
 *
 * @param input - 无法确认的状态信息。
 * @returns 面板内容。
 * @throws 不抛出异常。
 */
function buildUnconfirmableContent (
  input: Extract<TStatusPanelInput, { kind: 'unconfirmable' }>,
): IPanelContent {
  return {
    title: PANEL_TITLE,
    headline: '⚠️ 无法确认服务状态',
    fields: [
      { icon: '📌', label: '状态', value: '待确认 · 端口被占用', tone: 'warn' },
      { icon: '🔌', label: '端口', value: String(input.port) },
      { icon: '🆔', label: 'PID', value: `${input.pid}（记录中的）` },
    ],
    notes: [
      input.detail,
      '为避免误操作，本命令未清理记录、未结束任何进程。请手动确认后处理。',
    ],
    actions: [],
    mascot: '( •_•)?  这个端口上好像有人，但我不确定是不是我自己…',
  }
}
