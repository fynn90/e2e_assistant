/**
 * 客户端事件翻译的运行期状态。
 *
 * 翻译器本体（translator.ts）尽量保持单事件纯函数翻译；必须跨事件记忆的信息
 * （文本/思考增量游标、打开中的块、工具调用开始时间等）统一收敛到本模块的
 * 小状态机，便于测试与每轮运行开始时重置。
 */

import { uuidv7 } from '@earendil-works/pi-agent-core'

/**
 * 打开中的流式块（thinking / content）：记录 blockId 与已流出文本长度游标。
 */
export interface IOpenStreamBlock {
  /** 工作块 ID。 */
  blockId: string
  /** 已流出的文本长度（下次增量 = 全量.slice(cursor)）。 */
  cursor: number
  /** 块开始毫秒时间戳（计算耗时用）。 */
  startedAt: number
}

/**
 * 进行中的工具调用状态。
 */
export interface IOpenToolCall {
  /** 工作块 ID。 */
  blockId: string
  /** 工具机器名。 */
  toolName: string
  /** 工具开始毫秒时间戳。 */
  startedAt: number
  /** 是否为命令执行类工具（翻译为 command 事件）。 */
  isCommand: boolean
  /** 工具调用参数（tool_execution_end 事件不携带参数，需在 start 时留存）。 */
  args: unknown
  /** 文件变更类工具的目标路径在执行前是否已存在（write 区分新建/更新）。 */
  pathExistedBefore?: boolean
}

/**
 * 一次运行（run / continue）的翻译状态。
 */
export class ClientEventBlockState {
  /** 当前轮次块 ID。 */
  turnBlockId = ''

  /** 当前运行 ID。 */
  runId = ''

  /** 打开中的思考块；无流式思考时为 undefined。 */
  thinking: IOpenStreamBlock | undefined

  /** 打开中的内容输出块；无流式文本时为 undefined。 */
  content: IOpenStreamBlock | undefined

  /** 进行中的工具调用：toolCallId → 状态。 */
  readonly tools = new Map<string, IOpenToolCall>()

  /**
   * 开始一轮新运行：重置全部游标与打开中的块。
   *
   * @param runId - 本次运行的唯一标识。
   */
  beginRun(runId: string): void {
    this.runId = runId
    this.turnBlockId = newBlockId()
    this.thinking = undefined
    this.content = undefined
    this.tools.clear()
  }

  /**
   * 打开一个流式块。
   *
   * @returns 新块的可变状态（含分配的 blockId）。
   */
  openStreamBlock(): IOpenStreamBlock {
    return { blockId: newBlockId(), cursor: 0, startedAt: Date.now() }
  }

  /**
   * 登记一个开始执行的工具调用。
   *
   * @param toolCallId - 模型分配的工具调用 ID。
   * @param toolName - 工具机器名。
   * @param isCommand - 是否为命令执行类工具。
   * @param args - 工具调用参数（end 事件不携带，start 时留存）。
   * @param pathExistedBefore - 文件变更类工具目标路径执行前是否已存在。
   * @returns 登记后的工具调用状态（含分配的 blockId）。
   */
  openToolCall(
    toolCallId: string,
    toolName: string,
    isCommand: boolean,
    args: unknown,
    pathExistedBefore?: boolean,
  ): IOpenToolCall {
    const call: IOpenToolCall = {
      blockId: newBlockId(),
      toolName,
      startedAt: Date.now(),
      isCommand,
      args,
      pathExistedBefore,
    }
    this.tools.set(toolCallId, call)
    return call
  }

  /**
   * 登记一次待办清单更新（todo_write）。
   *
   * 清单是整体替换语义：同一 run 内每次调用都分配**新的** blockId，
   * 使时间线保留「当时的计划」这一历史痕迹；若复用同一 blockId，
   * 用户只能看到最后一次清单，无法回看任务是如何演进的。
   *
   * @param toolCallId - 模型分配的工具调用 ID。
   * @param toolName - 工具机器名。
   * @param args - 工具调用参数（含完整清单）。
   * @returns 登记后的调用状态（含分配的 blockId）。
   */
  openTodoCall(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): IOpenToolCall {
    const call: IOpenToolCall = {
      blockId: newBlockId(),
      toolName,
      startedAt: Date.now(),
      isCommand: false,
      args,
    }
    this.tools.set(toolCallId, call)
    return call
  }

  /**
   * 取出并移除一个已结束的工具调用。
   *
   * @param toolCallId - 模型分配的工具调用 ID。
   * @returns 调用状态；不存在返回 undefined。
   */
  closeToolCall(toolCallId: string): IOpenToolCall | undefined {
    const call = this.tools.get(toolCallId)
    if (call) {
      this.tools.delete(toolCallId)
    }
    return call
  }
}

/**
 * 分配一个工作块 ID。
 *
 * @returns 带 blk_ 前缀的唯一块 ID（uuidv7，时间有序便于排查）。
 */
export function newBlockId(): string {
  return `blk_${uuidv7()}`
}
