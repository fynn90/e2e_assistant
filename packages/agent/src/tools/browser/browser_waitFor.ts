/**
 * browser_waitFor 工具：按条件等待页面状态。
 *
 * 供「页面元素核对」阶段使用。引擎自身的脚本校验器反对固定等待
 * （`playwright-structure-validator.ts` 明确禁止 waitForTimeout），因此本工具
 * 以条件式等待为主：元素出现 / 加载完成 / URL 变化；`timeout` 类型是显式的
 * 固定等待兜底，仅在无法表达条件时使用。
 *
 * Schema 形态说明：条件用「扁平对象 + kind 判别」表达，而非 Type.Union 判别联合。
 * 原因是工具参数由 pi-agent-core 真校验（Value.Convert + Value.Check），校验失败会
 * 作为工具错误结果进入模型上下文；判别联合生成的 anyOf 会让失败信息变成多分支噪声，
 * 扁平对象只产生一条清晰错误。execute 按 kind 分支取值，忽略其他字段。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { IWaitCondition } from '@authine-e2e-agent/types'
import type { IBrowserSessionHost } from './Browser_session'

/** 等待条件的类型标识取值。 */
const WAIT_KINDS = ['selector', 'loadState', 'url', 'timeout'] as const

/** 元素等待状态取值。 */
const SELECTOR_STATES = ['attached', 'detached', 'visible', 'hidden'] as const

/** 页面加载状态取值。 */
const LOAD_STATES = ['load', 'domcontentloaded', 'networkidle'] as const

/** browser_waitFor 工具接受的参数 Schema（扁平对象 + kind 判别）。 */
const waitForParameters = Type.Object({
  /** 目标 iframe 的 frameId（由 browser_list_frames 返回）；缺省表示主文档。 */
  frameId: Type.Optional(
    Type.String({
      description:
        '目标 iframe 的 frameId（由 browser_list_frames 返回）。缺省或不传时操作主文档。',
    }),
  ),  /** 等待条件类型。 */
  kind: Type.Union(
    WAIT_KINDS.map((kind) => Type.Literal(kind)),
    {
      description:
        '等待条件类型：selector=等待元素状态；loadState=等待页面加载状态；url=等待地址匹配；timeout=固定等待（不推荐，仅在无法表达条件时使用）。',
    },
  ),
  /** kind=selector 时的目标元素 selector。 */
  selector: Type.Optional(
    Type.String({
      description: 'kind=selector 时必填：要等待的元素 selector。',
    }),
  ),
  /** kind=selector 时的目标状态。 */
  state: Type.Optional(
    Type.Union(
      SELECTOR_STATES.map((state) => Type.Literal(state)),
      {
        description:
          'kind=selector 时可选：等待的元素状态，缺省 visible（可见）。attached=已挂载到 DOM；detached=已从 DOM 移除；visible=可见；hidden=不可见或已移除。',
      },
    ),
  ),
  /** kind=loadState 时的加载状态。 */
  loadState: Type.Optional(
    Type.Union(
      LOAD_STATES.map((state) => Type.Literal(state)),
      {
        description:
          'kind=loadState 时必填：等待的页面加载状态。load=load 事件触发；domcontentloaded=DOM 解析完成；networkidle=网络空闲。',
      },
    ),
  ),
  /** kind=url 时的地址匹配模式。 */
  urlPattern: Type.Optional(
    Type.String({
      description:
        'kind=url 时必填：等待的地址匹配模式，支持通配符（如 **/print/**）或用 / 包裹的正则（如 /\\/preview\\?id=/）。',
    }),
  ),
  /** kind=timeout 时的等待毫秒数。 */
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        '固定等待的毫秒数（kind=timeout 时必填，其他类型下作为本次等待的超时上限）：长耗时的页面操作可调大，缺省沿用会话默认超时。',
    }),
  ),
})

/** browser_waitFor 工具返回的结构化执行详情。 */
export interface BrowserWaitForDetails {
  /** 实际生效的等待条件类型。 */
  kind: string
  /** 条件是否在超时前满足。 */
  matched: boolean
  /** 实际等待耗时（毫秒）。 */
  elapsedMs: number
}

/**
 * 把扁平参数收敛为引擎的等待条件。
 *
 * @param parameters - 已校验的工具参数。
 * @returns 引擎可执行的等待条件。
 * @throws {Error} 当 kind 与必填字段不匹配时抛出，错误消息面向模型说明缺哪个字段。
 */
function toWaitCondition(parameters: {
  kind: (typeof WAIT_KINDS)[number]
  selector?: string
  state?: (typeof SELECTOR_STATES)[number]
  loadState?: (typeof LOAD_STATES)[number]
  urlPattern?: string
  timeoutMs?: number
}): IWaitCondition {
  switch (parameters.kind) {
    case 'selector':
      if (!parameters.selector?.trim()) {
        throw new Error('kind=selector 时必须提供 selector。')
      }
      return {
        kind: 'selector',
        selector: parameters.selector,
        ...(parameters.state ? { state: parameters.state } : {}),
      }
    case 'loadState':
      if (!parameters.loadState) {
        throw new Error('kind=loadState 时必须提供 loadState。')
      }
      return { kind: 'loadState', state: parameters.loadState }
    case 'url':
      if (!parameters.urlPattern?.trim()) {
        throw new Error('kind=url 时必须提供 urlPattern。')
      }
      return { kind: 'url', pattern: parameters.urlPattern }
    case 'timeout':
      if (parameters.timeoutMs === undefined) {
        throw new Error('kind=timeout 时必须提供 timeoutMs。')
      }
      return { kind: 'timeout', ms: parameters.timeoutMs }
  }
}

/**
 * 生成条件的人类可读描述，用于工具结果说明。
 *
 * @param condition - 已收敛的等待条件。
 * @returns 一句话条件描述。
 * @throws 不抛出异常。
 */
function describeCondition(condition: IWaitCondition): string {
  switch (condition.kind) {
    case 'selector':
      return `元素「${condition.selector}」达到状态 ${condition.state ?? 'visible'}`
    case 'loadState':
      return `页面加载状态达到 ${condition.state}`
    case 'url':
      return `页面地址匹配 ${condition.pattern}`
    case 'timeout':
      return `固定等待 ${condition.ms} 毫秒`
  }
}

/**
 * 创建按条件等待页面状态的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_waitFor 工具。
 * @throws 不在创建阶段抛出异常；条件非法、取消或浏览器断连时由宿主抛出结构化错误。
 */
export function createBrowserWaitForTool(
  host: IBrowserSessionHost,
): AgentTool<typeof waitForParameters, BrowserWaitForDetails> {
  return {
    name: 'browser_waitFor',
    label: '等待页面状态',
    description:
      '等待页面达到指定状态后再继续核对，避免页面尚未更新就读取内容。优先使用条件式等待：kind=selector（等元素出现/消失）、kind=loadState（等加载完成）、kind=url（等地址变化）。kind=timeout 是固定等待，不推荐使用。等待超时会返回 matched=false 并说明条件未满足，而不是报错。',
    parameters: waitForParameters,
    executionMode: 'sequential',
    /**
     * 等待条件满足并返回等待结果。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的扁平等待参数。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；等待过程无中间进度。
     * @returns 包含条件是否满足与实际耗时的工具结果。
     * @throws {Error} 当必填字段缺失时抛出；其余结构化浏览器错误由宿主透传。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const condition = toWaitCondition(parameters)
      const result = await host.waitForPage(condition, {

        ...(parameters.frameId ? { frameId: parameters.frameId } : {}),        ...(parameters.timeoutMs !== undefined
          ? { timeoutMs: parameters.timeoutMs }
          : {}),
      })
      const summary = describeCondition(condition)

      return {
        content: [
          {
            type: 'text',
            text: result.matched
              ? `等待成功：${summary}（耗时 ${result.elapsedMs}ms）。`
              : `等待超时：${summary} 在 ${result.elapsedMs}ms 内未满足。请确认该元素或状态是否真的会出现，不要据此假设元素已存在。`,
          },
        ],
        details: {
          kind: condition.kind,
          matched: result.matched,
          elapsedMs: result.elapsedMs,
        },
      }
    },
  }
}
