/**
 * todo_write 工具：让 Agent 为多步骤任务维护一份可视化的核对清单。
 *
 * 为什么需要它（v12-pre）：多步骤用例的页面信息必须在**每一步交互之后**才存在，
 * Agent 只能一步步推进。若清单只存在于模型的推理文本里，用户在界面上看不到
 * 「打算做几步、当前做到哪一步」，过程不可观测，也无法判断 Agent 是否偏离用例。
 *
 * 与 Claude Code / Cursor 等工具的同名能力语义一致：清单是**当前状态**而非日志，
 * 每次调用提交完整清单并整体替换，由客户端原位重渲染。
 *
 * 副作用：本工具不读写任何文件、不访问页面，因此不需要工作区上下文，
 * 也不受生成守卫的写路径约束（但仍需在守卫白名单中放行）。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** 单次清单允许的最大条目数：超过时拒绝，避免清单本身变成噪声。 */
const MAX_TODO_ITEMS = 50

/** 单条待办内容的最大字符数：超出截断，避免长文本撑爆时间线。 */
const MAX_TODO_CONTENT_CHARACTERS = 200

/** todo_write 工具接受的参数 Schema。 */
const todoWriteParameters = Type.Object({
  /** 完整待办清单（每次调用提交全量，整体替换上一次）。 */
  items: Type.Array(
    Type.Object({
      /** 待办项标识：同一清单内保持稳定，用于原位更新。 */
      id: Type.String({
        description:
          '待办项标识，同一份清单内必须保持稳定（更新状态时沿用原 id），例如 step_1。',
      }),
      /** 待办内容。 */
      content: Type.String({
        description: '该待办要做什么，一句话，例如「登录并确认跳转到首页」。',
      }),
      /** 当前状态。 */
      status: Type.Union(
        [
          Type.Literal('pending'),
          Type.Literal('in_progress'),
          Type.Literal('completed'),
        ],
        {
          description:
            '状态：pending=待开始；in_progress=进行中（同一时刻最多一项）；completed=已完成。',
        },
      ),
      /** 进行中的补充说明。 */
      activeForm: Type.Optional(
        Type.String({
          description: '进行中时的补充说明，例如「正在核对第 3 个元素」。',
        }),
      ),
    }),
    {
      description:
        '完整待办清单，按执行顺序排列；每次调用都要提交全量清单（不是增量）。',
    },
  ),
})

/** 待办项状态。 */
export type TTodoItemStatus = 'pending' | 'in_progress' | 'completed'

/** 待办项。 */
export interface ITodoItem {
  /** 待办项标识。 */
  id: string
  /** 待办内容。 */
  content: string
  /** 当前状态。 */
  status: TTodoItemStatus
  /** 进行中的补充说明。 */
  activeForm?: string
}

/** todo_write 工具返回的结构化执行详情。 */
export interface TodoWriteDetails {
  /** 清单总条数。 */
  total: number
  /** 已完成条数。 */
  completed: number
  /** 进行中条数。 */
  inProgress: number
}

/**
 * 规范化单条待办：截断超长内容并丢弃空条目。
 *
 * @param item - 模型提交的待办项。
 * @returns 规范化后的待办项；内容为空时返回 undefined。
 * @throws 不抛出异常。
 */
function normalizeItem(item: {
  id: string
  content: string
  status: TTodoItemStatus
  activeForm?: string
}): ITodoItem | undefined {
  const content = item.content.trim().slice(0, MAX_TODO_CONTENT_CHARACTERS)
  if (content.length === 0) return undefined

  const activeForm = item.activeForm
    ?.trim()
    .slice(0, MAX_TODO_CONTENT_CHARACTERS)

  return {
    id: item.id.trim() || content,
    content,
    status: item.status,
    ...(activeForm ? { activeForm } : {}),
  }
}

/**
 * 把清单渲染为模型与用户都易读的文本。
 *
 * @param items - 规范化后的清单。
 * @returns 每行一条的清单文本。
 * @throws 不抛出异常。
 */
function formatItems(items: ITodoItem[]): string {
  const marks: Record<TTodoItemStatus, string> = {
    pending: '[ ]',
    in_progress: '[~]',
    completed: '[x]',
  }

  return items
    .map((item) => {
      const suffix =
        item.status === 'in_progress' && item.activeForm
          ? `（${item.activeForm}）`
          : ''
      return `${marks[item.status]} ${item.content}${suffix}`
    })
    .join('\n')
}

/**
 * 创建维护多步骤核对清单的 Agent 工具。
 *
 * @returns 可直接配置到 AgentTool[] 的 todo_write 工具。
 * @throws 不在创建阶段抛出异常；参数超限时在 execute 内抛出，由运行器记为工具失败。
 */
export function createTodoWriteTool(): AgentTool<
  typeof todoWriteParameters,
  TodoWriteDetails
> {
  return {
    name: 'todo_write',
    label: '更新任务清单',
    description:
      '为多步骤任务维护一份核对清单，让用户看到你打算做几步、当前做到哪一步。每完成一项更新状态，当整个任务完成时检查当前todo是否都完成。当用例包含多个有先后依赖的步骤（如：登录 → 进入列表 → 打开详情 → 提交）时必须先用本工具列出清单，每推进一步就更新一次状态。每次调用提交**完整清单**（不是增量）；同一时刻最多一项 in_progress。',
    parameters: todoWriteParameters,
    // 清单是整体替换语义，并发写入会让状态互相覆盖。
    executionMode: 'sequential',
    /**
     * 提交完整清单并回显当前进度。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的完整待办清单。
     * @param signal - 取消信号；本工具不执行耗时操作，不检查该信号。
     * @param onUpdate - 进度回调；本工具为瞬时操作，不产生中间进度。
     * @returns 包含清单文本与进度统计的工具结果。
     * @throws {Error} 清单条数超过上限或全部条目为空时抛出，错误消息面向模型说明如何修正。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      if (parameters.items.length > MAX_TODO_ITEMS) {
        throw new Error(
          `待办清单最多 ${MAX_TODO_ITEMS} 条，当前 ${parameters.items.length} 条；请合并或精简后再提交。`,
        )
      }

      const items = parameters.items
        .map((item) => normalizeItem(item))
        .filter((item): item is ITodoItem => item !== undefined)

      if (items.length === 0) {
        throw new Error('待办清单不能为空，且每条内容不能为空白。')
      }

      const inProgressCount = items.filter(
        (item) => item.status === 'in_progress',
      ).length
      const completedCount = items.filter(
        (item) => item.status === 'completed',
      ).length

      return {
        content: [
          {
            type: 'text',
            text: `任务清单已更新（${completedCount}/${items.length} 已完成）：\n${formatItems(items)}`,
          },
        ],
        details: {
          total: items.length,
          completed: completedCount,
          inProgress: inProgressCount,
        },
      }
    },
  }
}

/**
 * 判断工具名是否为待办清单工具。
 *
 * 翻译层据此把工具调用翻译为 todo 块而不是普通 tool 块（与 bash → command 同构）。
 *
 * @param toolName - 工具机器名。
 * @returns 待办工具返回 true。
 * @throws 不抛出异常。
 */
export function isTodoTool(toolName: string): boolean {
  return toolName === 'todo_write'
}

/** 暴露清单与内容的边界，供提示词与测试引用，避免多处硬编码。 */
export const todoWriteLimits = {
  maxItems: MAX_TODO_ITEMS,
  maxContentCharacters: MAX_TODO_CONTENT_CHARACTERS,
} as const
