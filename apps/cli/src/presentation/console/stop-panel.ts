/**
 * 「停止服务」面板的内容装配。
 *
 * 与启动面板的关键差异：停止有若干**没有运行态记录**的分支（记录缺失、记录
 * 损坏），此时没有 PID、端口可显示。因此字段一律按「有则渲染、无则不渲染」
 * 处理，绝不填空占位或 `undefined`——那会让用户以为查到了一条真实记录。
 *
 * **概述行原样承载 `stopResult.message`**：`已优雅停止` 等文案由应用层决定，
 * 面板只负责呈现，不重新措辞（e2e 依赖该短语）。
 */
import { createPanelStyle } from './ansi-style'
import { formatLocalTimestamp } from './format-timestamp'
import {
  renderPanel,
  type IPanelContent,
  type IPanelField,
} from './panel-renderer'
import { resolveTerminalOutputMode } from './terminal-output-mode'

/** 服务标题，与启动面板保持一致。 */
const PANEL_TITLE = 'AUTHINE E2E AGENT PLATFORM'

/**
 * 停止面板的输入。
 */
export interface IStopPanelInput {
  /** 是否确实结束了一个进程；用于选择吉祥物台词与状态语气。 */
  stopped: boolean
  /** 是否本就无需停止（记录缺失、服务已不在运行等）。 */
  alreadyStopped: boolean
  /** 面向用户的结论文案，由应用层给出，此处原样呈现。 */
  message: string
  /** 服务地址；无记录时为空字符串，此时不渲染该字段。 */
  serverUrl?: string
  /** 监听端口；不可得时不渲染。 */
  port?: number
  /** 被停止的服务进程号；不可得时不渲染。 */
  pid?: number
  /** 该服务的启动时刻（ISO 8601）；不可得时不渲染。 */
  startedAt?: string
}

/**
 * 渲染停止面板并返回待打印文本。
 *
 * @param input - 停止结果与终端上下文。
 * @returns 待打印的完整文本（含结尾换行）。
 * @throws 不抛出异常。
 */
export function renderStopPanel(input: IStopPanelInput): string {
  return renderPanel({
    content: buildStopPanelContent(input),
    mode: resolveTerminalOutputMode(),
    style: createPanelStyle(),
    ...(process.stdout.columns !== undefined
      ? { columns: process.stdout.columns }
      : {}),
  })
}

/**
 * 组装停止面板的内容。
 *
 * @param input - 停止结果。
 * @returns 与渲染层级无关的面板内容。
 * @throws 不抛出异常。
 */
export function buildStopPanelContent(input: IStopPanelInput): IPanelContent {
  const localizedStartedAt = formatLocalTimestamp(input.startedAt)
  const fields: IPanelField[] = []

  if (input.serverUrl) {
    fields.push({ icon: '🔗', label: '地址', value: input.serverUrl })
  }

  if (input.port !== undefined) {
    fields.push({ icon: '🔌', label: '端口', value: String(input.port) })
  }

  if (input.pid !== undefined) {
    fields.push({ icon: '🆔', label: 'PID', value: String(input.pid) })
  }

  if (localizedStartedAt) {
    fields.push({ icon: '🕒', label: '启动时间', value: localizedStartedAt })
  }

  return {
    title: PANEL_TITLE,
    // 前缀图标表达结果语气；消息正文由应用层给出，逐字呈现。
    headline: `${resolveHeadlineIcon(input)} ${input.message}`,
    fields,
    notes: [],
    actions: [],
    mascot: buildMascot(input),
  }
}

/**
 * 选择概述行前缀图标。
 *
 * @param input - 停止结果。
 * @returns 图标字符。
 * @throws 不抛出异常。
 */
function resolveHeadlineIcon(input: IStopPanelInput): string {
  if (input.stopped) {
    return '🛑'
  }

  if (input.alreadyStopped) {
    return '💤'
  }

  // 既未停止也非「本就无需停止」：只剩超时一类失败结果。
  return '⚠️'
}

/**
 * 构造吉祥物台词。
 *
 * @param input - 停止结果。
 * @returns 台词文本。
 * @throws 不抛出异常。
 */
function buildMascot(input: IStopPanelInput): string {
  if (input.stopped) {
    return '( -_-)zzZ  收工，我先睡一会儿～'
  }

  if (input.alreadyStopped) {
    return '( •_•)  我本来就没在跑，没白忙活～'
  }

  return '( º﹃º )  它好像不肯走，可能需要你手动看看～'
}
