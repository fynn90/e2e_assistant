/**
 * 单行提示的统一渲染（信息 / 警告 / 错误）。
 *
 * 为什么需要它：面板负责「一次操作的结果」，而错误与警告是散落在各条路径上的
 * 单行消息——它们原先各自拼字符串，于是出现了 `🚀【cli】`、`⚠️【cli】` 这类
 * 前缀与面板的新风格并存的情况。把「一行提示长什么样」收敛到一处，命令层只
 * 负责决定说什么、写到哪个流。
 *
 * 与 `panel-renderer.ts` 的分工：那边画多行卡片，这边只管一行；两者共用同一套
 * 配色（`ansi-style.ts`），因此观感一致。本模块不写任何流——调用方决定走
 * stdout 还是 stderr（错误与警告一律应走 stderr）。
 */
import { styleText } from 'node:util'
import { createPanelStyle } from './ansi-style'

/**
 * 提示的严重级别。
 *
 * - `info`：中性信息，不表示出问题；
 * - `warn`：功能降级但仍可继续（如浏览器没打开、日志轮转失败）；
 * - `error`：本次操作失败。
 */
export type TNoticeLevel = 'info' | 'warn' | 'error'

/** 各级别的行首图标。 */
const NOTICE_ICONS: Record<TNoticeLevel, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
}

export interface IRenderNoticeLineOptions {
  level: TNoticeLevel
  /** 提示正文；不该重复图标或前缀。 */
  message: string
}

/**
 * 渲染一行提示：`<图标> <正文>`，按级别配色。
 *
 * 非 TTY 下 `styleText` 自动降级为纯文本，调用方无需判断终端能力。
 *
 * @param options - 级别与正文。
 * @returns 待输出的单行文本（不含换行）。
 * @throws 不抛出异常。
 */
export function renderNoticeLine(options: IRenderNoticeLineOptions): string {
  const style = createPanelStyle()
  const icon = NOTICE_ICONS[options.level]
  const painted =
    options.level === 'error'
      ? styleText(['red'], options.message)
      : options.level === 'warn'
        ? style.warn(options.message)
        : style.muted(options.message)

  return `${icon} ${painted}`
}

/**
 * 渲染一行提示并附上多行细节（如错误堆栈、修复步骤）。
 *
 * 细节行统一缩进，与正文形成视觉从属关系。
 *
 * @param options - 级别、正文与细节行。
 * @returns 待输出的多行文本（不含结尾换行）。
 * @throws 不抛出异常。
 */
export function renderNoticeBlock(options: {
  level: TNoticeLevel
  message: string
  details: string[]
}): string {
  const style = createPanelStyle()
  const lines = [
    renderNoticeLine({ level: options.level, message: options.message }),
  ]

  for (const detail of options.details) {
    lines.push(style.muted(`   ${detail}`))
  }

  return lines.join('\n')
}
