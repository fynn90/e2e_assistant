/**
 * 面板渲染器：把结构化的面板内容渲染成待打印的文本。
 *
 * 纯函数，不做任何 I/O、不读全局状态——同样的输入恒得同样的输出，
 * 因此边框对齐、超宽截断、窄终端降级都能以单测锁定。
 *
 * 两条硬约束：
 *   1. **补齐空格必须按可见宽度算，绝不能用 `String.length`**。中文、emoji、
 *      ANSI 转义序列都会让码元数与列数不一致，按长度补齐会让右边框锯齿状错位
 *      （宽度计算见 text-width.ts）。
 *   2. **先补齐、后上色**。ANSI 序列占字符但零宽，先上色会污染测量结果。
 *
 * 内容装配与装潢的分离：`headline` / `fields` / `notes` / `actions` 是与层级
 * 无关的「一份内容」，`card` 与 `flat` 只是两种呈现。任何层级都必须原样包含
 * `headline` 全文——它是 e2e 断言的载体，也是用户一眼要看到的关键信息。
 */
import {
  measureTextWidth,
  padToWidth,
  truncateToWidth,
  wrapTextToWidth,
} from './text-width'
import type { IPanelStyle } from './ansi-style'
import type { TTerminalOutputMode } from './terminal-output-mode'

/** 卡片最大总宽度（含左右边框）：80 列以内不触发终端换行。 */
const CARD_MAX_WIDTH = 78

/** 卡片内左右各留的空白列数。 */
const CARD_HORIZONTAL_PADDING = 2

/** 动作行中相邻两个命令之间的间隔列数。 */
const ACTION_GAP = 4

/** 卡片下方吉祥物台词的缩进。 */
const MASCOT_INDENT = '   '

/**
 * 面板中的一个字段行。
 */
export interface IPanelField {
  /** 行首图标（emoji，通常占 2 列）。 */
  icon: string
  /** 字段名，如「地址」「端口」；同一面板内会被补齐到等宽。 */
  label: string
  /** 字段值。 */
  value: string
  /** 值的语气：正常（绿）/ 需注意（黄）；缺省用普通值色。 */
  tone?: 'ok' | 'warn'
}

/**
 * 面板底部的一条命令提示。
 */
export interface IPanelAction {
  /** 行首图标。 */
  icon: string
  /** 可执行命令，须原样呈现以便用户复制。 */
  command: string
  /** 右侧的中文说明。 */
  hint: string
}

/**
 * 面板内容（与装潢无关的「一份内容」）。
 *
 * 三种渲染层级共用本结构，避免内容装配被复制多份。
 */
export interface IPanelContent {
  /** 卡片标题（不含机器人图标，图标由渲染器加）。 */
  title: string
  /**
   * 概述行：一句话说清本次操作的结果。
   *
   * 这里是**断言载体**——`started in the background`、`already running`
   * 等关键短语必须出现在本行，且在所有层级下原样输出（不截断、不折行拆词）。
   */
  headline: string
  /** 字段行列表；某字段不适用时**不要填占位**，直接不放进数组。 */
  fields: IPanelField[]
  /** 补充说明行（如陈旧记录提示）；无则传空数组。 */
  notes: string[]
  /** 命令提示行。 */
  actions: IPanelAction[]
  /** 卡片下方的小机器人台词。 */
  mascot: string
}

export interface IRenderPanelOptions {
  content: IPanelContent
  mode: TTerminalOutputMode
  style: IPanelStyle
  /** 终端列数，用于自适应卡片宽度；缺省按最大宽度渲染。 */
  columns?: number
}

/**
 * 按指定层级渲染面板。
 *
 * @param options - 面板内容、渲染层级、配色与终端列数。
 * @returns 待打印的完整文本（含结尾换行）。
 * @throws 不抛出异常。
 */
export function renderPanel (options: IRenderPanelOptions): string {
  const lines =
    options.mode === 'card'
      ? renderCardLines(options)
      : renderFlatLines(options)

  return `${lines.join('\n')}\n`
}

/**
 * 解析卡片的实际总宽度。
 *
 * 终端比上限窄时收窄（避免换行破坏边框），但低于 `CARD_MAX_WIDTH` 时不再压缩——
 * 更窄的终端在 `resolveTerminalOutputMode` 已降到 `colored` 层，走的是无边框路径。
 *
 * @param columns - 终端列数；不可得时返回上限。
 * @returns 卡片总宽度（含左右边框）。
 * @throws 不抛出异常。
 */
function resolveCardWidth (columns: number | undefined): number {
  if (typeof columns !== 'number' || !Number.isFinite(columns)) {
    return CARD_MAX_WIDTH
  }

  return Math.min(CARD_MAX_WIDTH, Math.max(columns, 0))
}

/**
 * 卡片的布局尺寸。
 *
 * 三个宽度层层收窄：总宽 → 内宽（扣边框）→ 正文宽（再扣内边距）。
 * 抽成结构体是为了让各渲染函数只取自己需要的那一个，避免到处重算。
 */
interface ICardLayout {
  style: IPanelStyle
  /** 边框之间的宽度。 */
  innerWidth: number
  /** 正文可占用的宽度（已扣两侧内边距）。 */
  bodyWidth: number
  /** 字段名补齐目标：本面板内最长的字段名宽度。 */
  labelWidth: number
}

/**
 * 计算卡片的布局尺寸。
 *
 * @param options - 面板内容、配色与终端列数。
 * @returns 布局尺寸。
 * @throws 不抛出异常。
 */
function resolveCardLayout (options: IRenderPanelOptions): ICardLayout {
  const { content, style, columns } = options
  const innerWidth = resolveCardWidth(columns) - 2

  return {
    style,
    innerWidth,
    bodyWidth: Math.max(1, innerWidth - CARD_HORIZONTAL_PADDING * 2),
    labelWidth: Math.max(
      0,
      ...content.fields.map((field) => measureTextWidth(field.label)),
    ),
  }
}

/**
 * 渲染完整卡片（TTY 且终端足够宽）。
 *
 * @param options - 面板内容、配色与终端列数。
 * @returns 卡片各行文本。
 * @throws 不抛出异常。
 */
function renderCardLines (options: IRenderPanelOptions): string[] {
  const { content } = options
  const layout = resolveCardLayout(options)
  const lines: string[] = [
    renderCardTopBorder({
      title: content.title,
      style: layout.style,
      innerWidth: layout.innerWidth,
    }),
    renderCardBlankLine(layout),
    // 概述行优先于字段：它承载结论，超宽时折行也不截断（截断会破坏断言短语）。
    ...renderWrappedBodyLines({ text: content.headline, tone: 'ok', layout }),
    renderCardBlankLine(layout),
  ]

  for (const field of content.fields) {
    lines.push(renderCardFieldLine({ field, layout }))
  }

  for (const note of content.notes) {
    lines.push(...renderWrappedBodyLines({ text: note, tone: 'warn', layout }))
  }

  if (content.actions.length > 0) {
    lines.push(renderCardBlankLine(layout))
    lines.push(...renderCardActionLines({ actions: content.actions, layout }))
  }

  lines.push(renderCardBottomBorder(layout))

  if (content.mascot) {
    lines.push(`${MASCOT_INDENT}${layout.style.muted(content.mascot)}`)
  }

  return lines
}

interface IRenderWrappedBodyLinesOptions {
  text: string
  tone: 'ok' | 'warn'
  layout: ICardLayout
}

/**
 * 渲染一段可折行的正文（概述行与说明行共用）。
 *
 * 折行而非截断：这些文本承载结论与提示，截断会丢信息、也会破坏断言短语。
 *
 * @param options - 文本、语气与布局。
 * @returns 该段文本占用的各行。
 * @throws 不抛出异常。
 */
function renderWrappedBodyLines (
  options: IRenderWrappedBodyLinesOptions,
): string[] {
  const { text, tone, layout } = options

  return wrapTextToWidth(text, layout.bodyWidth).map((line) =>
    renderCardBodyLine({
      layout,
      plainBody: line,
      styledBody:
        tone === 'ok' ? layout.style.ok(line) : layout.style.warn(line),
    }),
  )
}

interface IRenderCardTopBorderOptions {
  title: string
  style: IPanelStyle
  innerWidth: number
}

/**
 * 渲染卡片顶边：`╭─ 🤖 标题 ───╮`。
 *
 * @param options - 标题、配色与卡片内宽。
 * @returns 顶边文本。
 * @throws 不抛出异常。
 */
function renderCardTopBorder (options: IRenderCardTopBorderOptions): string {
  const { title, style, innerWidth } = options
  const decoratedTitle = `🤖 ${title}`
  // 顶边总宽须与其它行一致：`╭─ ` 占 3 列，标题后留 1 空格，末尾 `╮` 占 1 列。
  const fillerWidth = Math.max(
    0,
    innerWidth - 3 - measureTextWidth(decoratedTitle),
  )

  return (
    style.border('╭─ ') +
    style.title(decoratedTitle) +
    ' ' +
    style.border('─'.repeat(fillerWidth)) +
    style.border('╮')
  )
}

/**
 * 渲染卡片内的空行（保留左右边框）。
 *
 * @param layout - 卡片布局。
 * @returns 空行文本。
 * @throws 不抛出异常。
 */
function renderCardBlankLine (layout: ICardLayout): string {
  return (
    layout.style.border('│') +
    ' '.repeat(layout.innerWidth) +
    layout.style.border('│')
  )
}

/**
 * 渲染卡片底边：`╰────╯`。
 *
 * @param layout - 卡片布局。
 * @returns 底边文本。
 * @throws 不抛出异常。
 */
function renderCardBottomBorder (layout: ICardLayout): string {
  return layout.style.border(`╰${'─'.repeat(layout.innerWidth)}╯`)
}

interface ICardBodyLineOptions {
  layout: ICardLayout
  /** 未上色的正文，用于测量与补齐。 */
  plainBody: string
  /** 已上色的正文，内容与 plainBody 一致。 */
  styledBody: string
}

/**
 * 把一行正文装进卡片：加左右边框并按可见宽度补齐右侧空白。
 *
 * @param options - 卡片布局与正文的纯文本 / 上色两份表示。
 * @returns 完整的卡片行文本。
 * @throws 不抛出异常。
 */
function renderCardBodyLine (options: ICardBodyLineOptions): string {
  const { layout, plainBody, styledBody } = options
  const paddingWidth = Math.max(
    0,
    layout.innerWidth -
    CARD_HORIZONTAL_PADDING * 2 -
    measureTextWidth(plainBody),
  )
  const leftPadding = ' '.repeat(CARD_HORIZONTAL_PADDING)
  const rightPadding = ' '.repeat(CARD_HORIZONTAL_PADDING + paddingWidth)

  return (
    layout.style.border('│') +
    leftPadding +
    styledBody +
    rightPadding +
    layout.style.border('│')
  )
}

interface IRenderCardFieldLineOptions {
  field: IPanelField
  layout: ICardLayout
}

/**
 * 渲染一个字段行：`图标 字段名  值`。
 *
 * @param options - 字段与卡片布局。
 * @returns 字段行文本。
 * @throws 不抛出异常。
 */
function renderCardFieldLine (options: IRenderCardFieldLineOptions): string {
  const { field, layout } = options
  const { style, bodyWidth, labelWidth } = layout
  // 值可用宽度：扣除「图标 + 空格 + 补齐后的字段名 + 两空格」。
  const prefixWidth = measureTextWidth(field.icon) + 1 + labelWidth + 2
  const value = truncateToWidth(
    field.value,
    Math.max(1, bodyWidth - prefixWidth),
  )
  const paddedLabel = padToWidth(field.label, labelWidth)

  return renderCardBodyLine({
    layout,
    plainBody: `${field.icon} ${paddedLabel}  ${value}`,
    styledBody: `${field.icon} ${style.label(paddedLabel)}  ${applyTone({ value, tone: field.tone, style })}`,
  })
}

interface IApplyToneOptions {
  value: string
  tone: IPanelField['tone']
  style: IPanelStyle
}

/**
 * 按语气给字段值上色。
 *
 * @param options - 值、语气与配色。
 * @returns 上色后的值。
 * @throws 不抛出异常。
 */
function applyTone (options: IApplyToneOptions): string {
  const { value, tone, style } = options

  if (tone === 'ok') {
    return style.ok(value)
  }

  if (tone === 'warn') {
    return style.warn(value)
  }

  return style.value(value)
}

interface IRenderCardActionLinesOptions {
  actions: IPanelAction[]
  layout: ICardLayout
}

/**
 * 渲染命令提示：**每个命令独占一行**，尾部跟一句作用说明。
 *
 * 为什么一行一个而不是并排：并排时三条命令在窄卡片上放不下，渲染器只能整条
 * 让位（命令不能截断，截断就失去可复制价值），于是窄终端上会「少了一条命令」
 * 这种难以解释的现象。一行一个后，每条命令都恒可见，作用说明也终于有位置写。
 *
 * 说明文字按命令宽度**左对齐成一列**：命令长短不一时（`e2e_assistant stop` 比
 * `e2e_assistant log -f` 短），参差的说明会显得杂乱。
 *
 * 命令本身不截断；放不下时让步的是**尾部说明**——说明被省略不影响命令可用，
 * 而命令被截断就废了。
 *
 * @param options - 命令列表与卡片布局。
 * @returns 各命令的提示行。
 * @throws 不抛出异常。
 */
function renderCardActionLines (
  options: IRenderCardActionLinesOptions,
): string[] {
  const { actions, layout } = options
  // 说明列的起点按最长命令对齐，使说明文字成一列。
  const commandColumnWidth = Math.max(
    0,
    ...actions.map((action) => measureTextWidth(toPlainCommand(action))),
  )

  return actions.map((action) =>
    renderCardActionLine({ action, layout, commandColumnWidth }),
  )
}

/** 取命令的纯文本表示（含图标），用于测量与补齐。 */
function toPlainCommand (action: IPanelAction): string {
  return `${action.icon} ${action.command}`
}

interface IRenderCardActionLineOptions {
  action: IPanelAction
  layout: ICardLayout
  /** 说明文字的对齐列宽（按最长命令计）。 */
  commandColumnWidth: number
}

/**
 * 渲染单条命令提示：命令左对齐占固定列宽，其后接说明。
 *
 * @param options - 命令、卡片布局与说明列宽。
 * @returns 该命令的提示行。
 * @throws 不抛出异常。
 */
function renderCardActionLine (options: IRenderCardActionLineOptions): string {
  const { action, layout, commandColumnWidth } = options
  const plainCommand = toPlainCommand(action)
  const paddedCommand = padToWidth(plainCommand, commandColumnWidth)
  const styledCommand = `${action.icon} ${layout.style.command(action.command)}`
  const styledPadding = ' '.repeat(
    Math.max(0, commandColumnWidth - measureTextWidth(plainCommand)),
  )
  // 说明可用宽度：扣掉对齐后的命令列与两者之间的间隔。
  const hintBudget = layout.bodyWidth - commandColumnWidth - ACTION_GAP

  if (hintBudget <= 0 || !action.hint) {
    return renderCardBodyLine({
      layout,
      plainBody: plainCommand,
      styledBody: styledCommand,
    })
  }

  const hint = truncateToWidth(action.hint, hintBudget)

  return renderCardBodyLine({
    layout,
    plainBody: `${paddedCommand}${' '.repeat(ACTION_GAP)}${hint}`,
    styledBody: `${styledCommand}${styledPadding}${' '.repeat(ACTION_GAP)}${layout.style.muted(hint)}`,
  })
}

/**
 * 渲染无边框版本（窄终端，或输出被重定向到管道 / CI）。
 *
 * 信息与卡片完全一致，只是去掉边框与内边距；非 TTY 时配色由 `styleText`
 * 自动降级为纯文本，因此本函数无需区分「窄终端」与「管道」。
 *
 * @param options - 面板内容与配色。
 * @returns 各行文本。
 * @throws 不抛出异常。
 */
function renderFlatLines (options: IRenderPanelOptions): string[] {
  const { content, style } = options
  const labelWidth = Math.max(
    0,
    ...content.fields.map((field) => measureTextWidth(field.label)),
  )
  const lines: string[] = [
    `🤖 ${style.title(content.title)}`,
    style.ok(content.headline),
  ]

  for (const field of content.fields) {
    const paddedLabel = padToWidth(field.label, labelWidth)
    lines.push(
      `   ${field.icon} ${style.label(paddedLabel)}  ${applyTone({ value: field.value, tone: field.tone, style })}`,
    )
  }

  for (const note of content.notes) {
    lines.push(`   ${style.warn(note)}`)
  }

  for (const action of content.actions) {
    lines.push(
      `   ${action.icon} ${style.command(action.command)}  ${style.muted(action.hint)}`,
    )
  }

  return lines
}
