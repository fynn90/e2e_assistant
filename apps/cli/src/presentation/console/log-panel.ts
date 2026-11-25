/**
 * 「查看日志」面板的内容装配。
 *
 * 只负责 `log` 命令的**提示类**输出（服务在前台运行、尚无日志文件）。日志
 * 正文本身绝不经过本模块——它是原始文本，套上边框会破坏可读性与可复制性，
 * 且 e2e 只要求正文非空。
 */
import { createPanelStyle } from './ansi-style'
import {
  renderPanel,
  type IPanelAction,
  type IPanelContent,
  type IPanelField,
} from './panel-renderer'
import { resolveTerminalOutputMode } from './terminal-output-mode'
import {
  createForegroundStartAction,
  createStartAction,
  createStopAction,
} from './panel-actions'

/** 服务标题，与启停面板保持一致。 */
const PANEL_TITLE = 'AUTHINE E2E AGENT PLATFORM'

/**
 * 日志面板的输入。
 */
export interface ILogPanelInput {
  /** 提示类型：服务以前台运行中 / 尚无后台日志。 */
  notice: 'foreground-running' | 'no-log-file'
  /** 日志文件路径。 */
  logPath: string
}

/**
 * 渲染日志提示面板并返回待打印文本。
 *
 * @param input - 提示类型与日志路径。
 * @returns 待打印的完整文本（含结尾换行）。
 * @throws 不抛出异常。
 */
export function renderLogPanel(input: ILogPanelInput): string {
  return renderPanel({
    content: buildLogPanelContent(input),
    mode: resolveTerminalOutputMode(),
    style: createPanelStyle(),
    ...(process.stdout.columns !== undefined
      ? { columns: process.stdout.columns }
      : {}),
  })
}

/**
 * 组装日志提示面板的内容。
 *
 * @param input - 提示类型与日志路径。
 * @returns 与渲染层级无关的面板内容。
 * @throws 不抛出异常。
 */
export function buildLogPanelContent(input: ILogPanelInput): IPanelContent {
  if (input.notice === 'foreground-running') {
    return buildForegroundRunningContent()
  }

  return buildNoLogFileContent(input)
}

/**
 * 组装「服务以前台模式运行中」的内容。
 *
 * @returns 面板内容。
 * @throws 不抛出异常。
 */
function buildForegroundRunningContent(): IPanelContent {
  return {
    title: PANEL_TITLE,
    headline: '🔍 服务以前台模式运行中，日志输出在其终端',
    fields: [],
    notes: ['前台模式不写日志文件，因此这里不展示可能过期的历史日志。'],
    actions: [createStopAction()],
    mascot: '( •_•)  它的日志在自己的终端里，去那边看哦～',
  }
}

/**
 * 组装「尚无后台日志」的内容。
 *
 * @param input - 日志路径。
 * @returns 面板内容。
 * @throws 不抛出异常。
 */
function buildNoLogFileContent(input: ILogPanelInput): IPanelContent {
  const fields: IPanelField[] = [
    { icon: '📜', label: '日志文件', value: input.logPath },
  ]
  const actions: IPanelAction[] = [
    createStartAction(),
    createForegroundStartAction(),
  ]

  return {
    title: PANEL_TITLE,
    headline: '📭 尚无后台服务日志：可能从未以后台模式启动过，或日志尚未产生',
    fields,
    notes: [],
    actions,
    mascot: '( •_•)  我还没写过日志呢，先让我跑起来吧～',
  }
}
