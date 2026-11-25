/**
 * 客户端事件翻译器：把 pi-agent-core 的 AgentEvent 翻译为客户端渲染协议事件。
 *
 * 本模块实现 Harness eventAdapter 插件接口，挂进 AgentLoop 现有事件管线，
 * 不改动主循环流程。产出 TAgentClientEventDraft（已带 sessionId / blockId /
 * timestamp，seq 由 CLI 网关统一分配）。
 *
 * 安全约束：凡进入事件的工具参数与结果，一律经 tool-trace 的安全预览
 * （脱敏 + 截断）处理，绝不透出原始值。
 */

import { existsSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  IAgentTodoItem,
  IAgentToolImageRef,
  TAgentClientEventDraft,
  TAgentClientEventPayload,
  TAgentTodoStatus,
  TAgentTurnOutcome,
} from '@charlie_deng/e2e-assistant-types'
import type {
  IEventAdapter,
  IHarnessRunContext,
  IRunEndInfo,
} from '../interfaces'
import { toSafePreview } from '../../tool-trace/safe-value'
import { isTodoTool } from '../../tools/todo_write'
import { ClientEventBlockState, newBlockId } from './block-state'
import {
  extractCommand,
  extractFileChange,
  isCommandTool,
  presentTool,
} from './tool-presenter'

/** 工具结果摘要的最大展示字符数。 */
const MAX_SUMMARY_CHARACTERS = 120
/** 工具增量信息的最大展示字符数。 */
const MAX_APPEND_CHARACTERS = 200
/** 轮次输入预览的最大字符数。 */
const MAX_INPUT_PREVIEW_CHARACTERS = 200

/**
 * 翻译器构造选项。
 */
export interface IClientEventTranslatorOptions {
  /** 会话 ID：写入每条事件草稿的信封。 */
  sessionId: string
  /** 工作区目录：用于把文件类工具的绝对路径参数折算为工作区相对路径。 */
  workspace?: string
  /** 按工具名解析人类可读标签（未收录工具的兜底标题）。 */
  resolveToolLabel?: (toolName: string) => string | undefined
  /**
   * 轮次输入预览覆盖文案。
   *
   * 用于系统发起的任务型会话（如 SKILL.md 生成）：这类会话的首轮输入是
   * 含完整用例数据的长 prompt，直接截断后作为会话标题没有可读性。
   * 配置后覆盖 turn.begin 的输入预览；未配置时沿用输入文本。
   */
  inputPreviewOverride?: string
}

/**
 * 客户端事件翻译器（eventAdapter 插件实现）。
 *
 * 每个会话任务持有一个实例（与该会话的 AgentLoop 同生命周期）；
 * 跨事件记忆的状态收敛在 ClientEventBlockState，每轮运行开始重置。
 */
export class ClientEventTranslator implements IEventAdapter<TAgentClientEventDraft> {
  /** 插件唯一标识。 */
  readonly id = 'client-events-translator'

  private readonly sessionId: string
  private readonly workspace?: string
  private readonly resolveToolLabel?: (toolName: string) => string | undefined
  /** 轮次输入预览覆盖文案（配置时替代输入文本作为会话标题来源）。 */
  private readonly inputPreviewOverride?: string

  /** 当前运行的翻译状态。 */
  private readonly state = new ClientEventBlockState()

  /**
   * @param options - 会话 ID、工作区、工具标签解析器与输入预览覆盖文案。
   */
  constructor(options: IClientEventTranslatorOptions) {
    this.sessionId = options.sessionId
    this.workspace = options.workspace
    this.resolveToolLabel = options.resolveToolLabel
    this.inputPreviewOverride = options.inputPreviewOverride
  }

  /**
   * 翻译单个 pi-agent-core 事件为客户端事件草稿。
   *
   * @param event - pi-agent-core 生命周期事件。
   * @returns 事件草稿、草稿数组，或 null（该事件无可展示内容）。
   */
  translate (event: AgentEvent): TAgentClientEventDraft[] | null {
    try {
      return this.doTranslate(event)
    } catch {
      // 翻译失败绝不阻断工具循环：丢弃该条事件，由运行结束事件保证流可收尾。
      return null
    }
  }

  /**
   * 运行开始：重置状态并产出「轮次开始 + 进入思考」事件。
   *
   * @param context - 本次运行的上下文元信息。
   * @returns 轮次开始与状态事件草稿。
   */
  onRunStart (context: IHarnessRunContext): TAgentClientEventDraft[] {
    this.state.beginRun(context.runId)
    return [
      this.draft(this.state.turnBlockId, {
        type: 'turn',
        phase: 'begin',
        runId: context.runId,
        // 覆盖文案优先：系统任务型会话的长 prompt 不适合作为会话标题
        inputPreview:
          this.inputPreviewOverride ?? inputPreviewOf(context.input),
      }),
      this.draft('status', { type: 'status', activity: 'thinking' }),
    ]
  }

  /**
   * 运行结束：收尾未闭合的块并产出「轮次结束 + 回到空闲」事件。
   *
   * @param run - 运行结束摘要（runId、消息与错误信息）。
   * @returns 收尾事件草稿数组。
   */
  onRunEnd (run: IRunEndInfo): TAgentClientEventDraft[] {
    const events: TAgentClientEventDraft[] = []
    const now = Date.now()

    // 收尾可能因异常/中止而未闭合的流式块，保证客户端组件都能定型。
    if (this.state.thinking) {
      events.push(
        this.draft(this.state.thinking.blockId, {
          type: 'thinking',
          phase: 'end',
          durationMs: now - this.state.thinking.startedAt,
        }),
      )
      this.state.thinking = undefined
    }
    if (this.state.content) {
      events.push(
        this.draft(this.state.content.blockId, {
          type: 'content',
          phase: 'end',
        }),
      )
      this.state.content = undefined
    }
    for (const [toolCallId, call] of this.state.tools) {
      events.push(
        call.isCommand
          ? this.draft(call.blockId, {
            type: 'command',
            phase: 'end',
            exitCode: 1,
            durationMs: now - call.startedAt,
          })
          : this.draft(call.blockId, {
            type: 'tool',
            phase: 'end',
            status: 'failed',
            summary: '工具调用未正常结束',
            durationMs: now - call.startedAt,
          }),
      )
      this.state.tools.delete(toolCallId)
    }

    events.push(
      this.draft(this.state.turnBlockId || newBlockId(), {
        type: 'turn',
        phase: 'end',
        runId: run.runId,
        outcome: outcomeOf(run.errorMessage),
        ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
        ...(extractUsage(run.messages)
          ? { usage: extractUsage(run.messages) }
          : {}),
      }),
      this.draft('status', { type: 'status', activity: 'idle' }),
    )
    return events
  }

  /**
   * 单事件翻译主逻辑（按事件类型分发）。
   *
   * @param event - pi-agent-core 生命周期事件。
   * @returns 事件草稿数组或 null。
   */
  private doTranslate (event: AgentEvent): TAgentClientEventDraft[] | null {
    switch (event.type) {
      case 'message_update':
        return this.translateMessageUpdate(event.message)
      case 'message_end':
        return this.translateMessageEnd(event.message)
      case 'tool_execution_start':
        return this.translateToolStart(event)
      case 'tool_execution_update':
        return this.translateToolUpdate(event)
      case 'tool_execution_end':
        return this.translateToolEnd(event)
      default:
        // agent_start / agent_end / turn_start / turn_end 无可展示内容：
        // 运行级轮次事件由 onRunStart / onRunEnd 自产。
        return null
    }
  }

  /**
   * 翻译助手消息流式更新：按文本块 / 思考块分别维护增量游标。
   *
   * @param message - 当前流式中的助手消息（内容为累计全量）。
   * @returns thinking / content / status 事件草稿。
   */
  private translateMessageUpdate (
    message: AgentMessage,
  ): TAgentClientEventDraft[] | null {
    if (message.role !== 'assistant') return null
    const events: TAgentClientEventDraft[] = []
    const { thinking, text } = splitAssistantContent(message)

    // —— 思考块：首开时发 begin + 状态切换，之后按游标发增量 ——
    if (thinking.length > 0) {
      if (!this.state.thinking) {
        this.state.thinking = this.state.openStreamBlock()
        events.push(
          this.draft(this.state.thinking.blockId, {
            type: 'thinking',
            phase: 'begin',
          }),
          this.draft('status', { type: 'status', activity: 'thinking' }),
        )
      }
      if (thinking.length > this.state.thinking.cursor) {
        events.push(
          this.draft(this.state.thinking.blockId, {
            type: 'thinking',
            phase: 'append',
            text: thinking.slice(this.state.thinking.cursor),
          }),
        )
        this.state.thinking.cursor = thinking.length
      }
    }

    // —— 内容块：首开时发 begin（默认 markdown）+ 状态切换，之后按游标发增量 ——
    if (text.length > 0) {
      if (!this.state.content) {
        this.state.content = this.state.openStreamBlock()
        events.push(
          this.draft(this.state.content.blockId, {
            type: 'content',
            phase: 'begin',
            contentType: 'markdown',
          }),
          this.draft('status', { type: 'status', activity: 'writing' }),
        )
      }
      if (text.length > this.state.content.cursor) {
        events.push(
          this.draft(this.state.content.blockId, {
            type: 'content',
            phase: 'append',
            text: text.slice(this.state.content.cursor),
          }),
        )
        this.state.content.cursor = text.length
      }
    }

    return events.length > 0 ? events : null
  }

  /**
   * 翻译助手消息结束：闭合打开中的思考块与内容块。
   *
   * @param message - 结束的助手消息。
   * @returns 块闭合事件草稿。
   */
  private translateMessageEnd (
    message: AgentMessage,
  ): TAgentClientEventDraft[] | null {
    if (message.role !== 'assistant') return null
    const events: TAgentClientEventDraft[] = []
    if (this.state.thinking) {
      events.push(
        this.draft(this.state.thinking.blockId, {
          type: 'thinking',
          phase: 'end',
          durationMs: Date.now() - this.state.thinking.startedAt,
        }),
      )
      this.state.thinking = undefined
    }
    if (this.state.content) {
      events.push(
        this.draft(this.state.content.blockId, {
          type: 'content',
          phase: 'end',
        }),
      )
      this.state.content = undefined
    }
    return events.length > 0 ? events : null
  }

  /**
   * 翻译工具执行开始：命令类产 command begin，待办类产 todo 块，其余产 tool begin。
   *
   * @param event - 工具执行开始事件。
   * @returns 块开始与状态事件草稿。
   */
  private translateToolStart (
    event: Extract<AgentEvent, { type: 'tool_execution_start' }>,
  ): TAgentClientEventDraft[] {
    // 待办清单（todo_write）翻译为 todo 块而非普通工具卡片：清单是「当前状态」，
    // 用户要看到的是步骤列表与进度，而不是一次工具调用记录。
    // 参数里已带完整清单，因此不需要等工具结束，在 start 即可呈现。
    if (isTodoTool(event.toolName)) {
      const call = this.state.openTodoCall(
        event.toolCallId,
        event.toolName,
        event.args,
      )
      const items = extractTodoItems(event.args)
      return [
        this.draft(call.blockId, { type: 'todo', phase: 'begin', items }),
        this.draft('status', {
          type: 'status',
          activity: 'tool_running',
          label: describeTodoProgress(items),
        }),
      ]
    }

    const isCommand = isCommandTool(event.toolName)
    const call = this.state.openToolCall(
      event.toolCallId,
      event.toolName,
      isCommand,
      event.args,
      this.checkPathExisted(event.toolName, event.args),
    )

    if (isCommand) {
      const { command, cwd } = extractCommand(event.args)
      return [
        this.draft(call.blockId, {
          type: 'command',
          phase: 'begin',
          command,
          ...(cwd ? { cwd } : {}),
        }),
        this.draft('status', {
          type: 'status',
          activity: 'command_running',
          label: command,
        }),
      ]
    }

    const presentation = presentTool(
      event.toolName,
      event.args,
      this.resolveToolLabel?.(event.toolName),
    )
    const argsPreview = toSafePreview(event.args)
    return [
      this.draft(call.blockId, {
        type: 'tool',
        phase: 'begin',
        tool: {
          category: presentation.category,
          action: presentation.action,
          title: presentation.title,
          ...(presentation.subtitle ? { subtitle: presentation.subtitle } : {}),
          toolName: event.toolName,
          argumentsPreview: argsPreview.value,
        },
      }),
      this.draft('status', {
        type: 'status',
        activity: 'tool_running',
        label: presentation.subtitle
          ? `${presentation.title} ${presentation.subtitle}`
          : presentation.title,
      }),
    ]
  }

  /**
   * 翻译工具执行增量：命令类按 stdout 追加，其余产一句话增量描述。
   *
   * @param event - 工具执行增量事件。
   * @returns 块增量事件草稿；未登记或无可展示增量时为 null。
   */
  private translateToolUpdate (
    event: Extract<AgentEvent, { type: 'tool_execution_update' }>,
  ): TAgentClientEventDraft[] | null {
    const call = this.state.tools.get(event.toolCallId)
    if (!call) return null
    const text = truncate(
      extractResultText(event.partialResult),
      MAX_APPEND_CHARACTERS,
    )
    if (text.length === 0) return null
    return [
      call.isCommand
        ? this.draft(call.blockId, {
          type: 'command',
          phase: 'append',
          stream: 'stdout',
          text,
        })
        : this.draft(call.blockId, { type: 'tool', phase: 'append', text }),
    ]
  }

  /**
   * 翻译工具执行结束：产出结束事件；文件类工具成功时附带 file_change。
   *
   * @param event - 工具执行结束事件。
   * @returns 块结束、文件变更与状态事件草稿。
   */
  private translateToolEnd (
    event: Extract<AgentEvent, { type: 'tool_execution_end' }>,
  ): TAgentClientEventDraft[] | null {
    const call = this.state.closeToolCall(event.toolCallId)
    if (!call) return null
    const durationMs = Date.now() - call.startedAt
    const events: TAgentClientEventDraft[] = []

    // 待办清单已在 start 时整体下发，结束时不重复产出块事件：
    // 只有失败需要额外反馈（清单无法正常提交时应当让用户看到原因）。
    if (isTodoTool(event.toolName)) {
      if (event.isError) {
        const summary = truncate(
          extractResultText(event.result),
          MAX_SUMMARY_CHARACTERS,
        )
        events.push(
          this.draft(call.blockId, {
            type: 'todo',
            phase: 'begin',
            items: [],
          }),
          this.draft('status', {
            type: 'status',
            activity: 'idle',
            ...(summary.length > 0 ? { label: summary } : {}),
          }),
        )
      }
      return events
    }

    if (call.isCommand) {
      events.push(
        this.draft(call.blockId, {
          type: 'command',
          phase: 'end',
          exitCode: extractExitCode(event.result, event.isError),
          durationMs,
        }),
      )
    } else {
      const summary = truncate(
        extractResultText(event.result),
        MAX_SUMMARY_CHARACTERS,
      )
      // 截图类工具的图片引用：只带引用不带字节（字节由 CLI 落盘、客户端按 URL 拉取）。
      const image = event.isError
        ? undefined
        : extractToolImageRef(event.result)
      events.push(
        this.draft(call.blockId, {
          type: 'tool',
          phase: 'end',
          status: event.isError ? 'failed' : 'succeeded',
          ...(summary.length > 0 ? { summary } : {}),
          durationMs,
          ...(image ? { image } : {}),
        }),
      )
      // 文件类工具执行成功 → 旁路 file_change 事件（驱动客户端文件树刷新）。
      // 注意：tool_execution_end 不携带参数，使用 start 时留存的 args。
      if (!event.isError) {
        const change = extractFileChange(
          event.toolName,
          call.args,
          call.pathExistedBefore ?? false,
        )
        if (change) {
          events.push(
            this.draft(`file:${change.path}`, {
              type: 'file_change',
              operation: change.operation,
              path: this.toWorkspaceRelative(change.path),
              ...(change.newPath ? { newPath: change.newPath } : {}),
              sourceBlockId: call.blockId,
            }),
          )
        }
      }
    }

    // 工具结束 → 回到等待模型输出状态。
    events.push(this.draft('status', { type: 'status', activity: 'thinking' }))
    return events
  }

  /**
   * 检查文件类工具目标路径在执行前是否已存在（write 区分新建/更新）。
   *
   * @param toolName - 工具机器名。
   * @param args - 工具参数。
   * @returns 路径已存在返回 true；非文件类工具或检查失败返回 undefined/false。
   */
  private checkPathExisted (
    toolName: string,
    args: unknown,
  ): boolean | undefined {
    if (toolName !== 'write') return undefined
    const change = extractFileChange(toolName, args, false)
    if (!change || !this.workspace) return false
    try {
      return existsSync(
        isAbsolute(change.path)
          ? change.path
          : `${this.workspace}/${change.path}`,
      )
    } catch {
      return false
    }
  }

  /**
   * 把工具参数中的路径折算为工作区相对路径。
   *
   * @param path - 工具参数中的路径（绝对或相对）。
   * @returns 工作区相对路径；无法折算时原样返回。
   */
  private toWorkspaceRelative (path: string): string {
    if (!this.workspace || !isAbsolute(path)) return path
    const rel = relative(this.workspace, path)
    return rel.length > 0 && !rel.startsWith('..') ? rel : path
  }

  /**
   * 组装事件草稿（信封 + 载荷）。
   *
   * @param blockId - 工作块 ID。
   * @param payload - 事件载荷。
   * @returns 完整事件草稿。
   */
  private draft (
    blockId: string,
    payload: TAgentClientEventPayload,
  ): TAgentClientEventDraft {
    return {
      sessionId: this.sessionId,
      blockId,
      timestamp: Date.now(),
      ...payload,
    } as TAgentClientEventDraft
  }
}

/**
 * 拆分助手消息内容为思考文本与输出文本（各自累计全量拼接）。
 *
 * @param message - 助手消息。
 * @returns thinking 与 text 两个全量字符串。
 */
function splitAssistantContent (message: AgentMessage): {
  thinking: string
  text: string
} {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return { thinking: '', text: typeof content === 'string' ? content : '' }
  }
  let thinking = ''
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const typed = block as { type?: string; text?: unknown; thinking?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') {
      text += typed.text
    } else if (
      typed.type === 'thinking' &&
      typeof typed.thinking === 'string'
    ) {
      thinking += typed.thinking
    }
  }
  return { thinking, text }
}

/**
 * 从工具结果 / 增量结果中提取可展示文本（经安全预览脱敏截断）。
 *
 * @param result - 工具结果（AgentToolResult 结构或任意值）。
 * @returns 可展示文本；无文本内容返回空串。
 */
function extractResultText (result: unknown): string {
  if (result === null || result === undefined) return ''
  const content = (result as { content?: unknown }).content
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          Boolean(block) &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  // 无文本内容时退化为安全预览的短描述。
  const preview = toSafePreview(result)
  return typeof preview.value === 'string' ? preview.value : ''
}

/**
 * 从 todo_write 参数中提取待办清单。
 *
 * 参数在翻译层一律视为 unknown 逐字段收窄：模型可能提交缺字段或类型不符的结构
 * （虽然工具 Schema 会校验，但翻译层是独立的展示通道，不应假设上游已校验）。
 * 内容经安全预览脱敏，避免把敏感值展示到时间线。
 *
 * @param args - todo_write 的工具参数。
 * @returns 规范化后的待办清单；结构不符时返回空数组。
 * @throws 不抛出异常。
 */
function extractTodoItems (args: unknown): IAgentTodoItem[] {
  const rawItems = (args as { items?: unknown })?.items
  if (!Array.isArray(rawItems)) return []

  const allowedStatuses: readonly TAgentTodoStatus[] = [
    'pending',
    'in_progress',
    'completed',
  ]

  return rawItems
    .map((raw): IAgentTodoItem | undefined => {
      if (!raw || typeof raw !== 'object') return undefined
      const item = raw as {
        id?: unknown
        content?: unknown
        status?: unknown
        activeForm?: unknown
      }
      if (typeof item.content !== 'string') return undefined

      const content = toSafeText(item.content)
      if (content.length === 0) return undefined

      const status = allowedStatuses.includes(item.status as TAgentTodoStatus)
        ? (item.status as TAgentTodoStatus)
        : 'pending'
      const activeForm =
        typeof item.activeForm === 'string' ? toSafeText(item.activeForm) : ''

      return {
        id:
          typeof item.id === 'string' && item.id.length > 0 ? item.id : content,
        content,
        status,
        ...(activeForm.length > 0 ? { activeForm } : {}),
      }
    })
    .filter((item): item is IAgentTodoItem => item !== undefined)
}

/**
 * 生成状态条上的清单进度文案。
 *
 * @param items - 待办清单。
 * @returns 形如「任务清单 3/7」的文案；清单为空时返回通用文案。
 * @throws 不抛出异常。
 */
function describeTodoProgress (items: IAgentTodoItem[]): string {
  if (items.length === 0) return '更新任务清单'
  const completed = items.filter((item) => item.status === 'completed').length
  return `任务清单 ${completed}/${items.length}`
}

/**
 * 对展示文本执行安全预览（脱敏 + 截断）。
 *
 * @param value - 原始文本。
 * @returns 脱敏截断后的文本。
 * @throws 不抛出异常。
 */
function toSafeText (value: string): string {
  const preview = toSafePreview(value)
  return typeof preview.value === 'string' ? preview.value.trim() : ''
}

/**
 * 从工具结果中提取图片引用（v12-pre 截图工具专用）。
 *
 * 只读取 `details.image` 这一**引用**字段，不读取图片字节：
 * 字节既不在工具结果里（引擎不落盘），也不允许进入事件通道
 * （事件会经脱敏器，且会拖累事件总线与断线续传缓冲）。
 *
 * @param result - 工具最终结果（AgentToolResult 结构或任意值）。
 * @returns 图片引用；非截图工具、未归档或结构不符时返回 undefined。
 * @throws 不抛出异常。
 */
function extractToolImageRef (result: unknown): IAgentToolImageRef | undefined {
  const image = (result as { details?: { image?: unknown } })?.details?.image
  if (!image || typeof image !== 'object') return undefined

  const candidate = image as Partial<IAgentToolImageRef>
  if (
    typeof candidate.url !== 'string' ||
    typeof candidate.mimeType !== 'string' ||
    typeof candidate.width !== 'number' ||
    typeof candidate.height !== 'number'
  ) {
    return undefined
  }

  return {
    url: candidate.url,
    mimeType: candidate.mimeType,
    width: candidate.width,
    height: candidate.height,
  }
}

/**
 * 从命令执行结果中提取退出码。
 *
 * @param result - 工具最终结果。
 * @param isError - 结果是否被标记为错误。
 * @returns 退出码；无法提取时按 isError 折算（错误 1 / 成功 0）。
 */
function extractExitCode (result: unknown, isError: boolean): number {
  const details = (result as { details?: unknown })?.details
  const exitCode = (details as { exitCode?: unknown })?.exitCode
  if (typeof exitCode === 'number') return exitCode
  return isError ? 1 : 0
}

/**
 * 由运行错误信息推导轮次结局。
 *
 * @param errorMessage - 运行结束的错误信息。
 * @returns 轮次结局：中止 / 失败 / 成功。
 */
function outcomeOf (errorMessage?: string): TAgentTurnOutcome {
  if (!errorMessage) return 'succeeded'
  return /abort/i.test(errorMessage) ? 'aborted' : 'failed'
}

/**
 * 从运行结束消息中提取最近一次助手消息的 token 用量。
 *
 * @param messages - 会话消息列表。
 * @returns 用量对象；无用量返回 undefined。
 */
function extractUsage (
  messages: AgentMessage[],
): { inputTokens?: number; outputTokens?: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const usage = (message as { usage?: unknown }).usage
    if (message.role === 'assistant' && usage && typeof usage === 'object') {
      const u = usage as { input?: number; output?: number }
      return { inputTokens: u.input, outputTokens: u.output }
    }
  }
  return undefined
}

/**
 * 生成轮次输入预览。
 *
 * @param input - 运行输入（文本或消息数组；continue 续跑为 undefined）。
 * @returns 截断至 200 字符的预览文本；无输入返回 undefined。
 */
function inputPreviewOf (
  input: IHarnessRunContext['input'],
): string | undefined {
  if (input === undefined) return undefined
  if (typeof input === 'string') {
    return truncate(input, MAX_INPUT_PREVIEW_CHARACTERS)
  }
  const lastUser = [...input].reverse().find((m) => m.role === 'user')
  if (!lastUser) return undefined
  const { text } = splitAssistantContent(lastUser)
  return truncate(text, MAX_INPUT_PREVIEW_CHARACTERS)
}

/**
 * 按字符数截断文本。
 *
 * @param text - 原始文本。
 * @param max - 最大字符数。
 * @returns 截断后的文本。
 */
function truncate (text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}
