/**
 * browser_click 工具：在页面元素上执行真实点击。
 *
 * 供「页面元素核对」阶段使用：部分关键元素（弹框、展开项、切换后的画布）
 * 只在交互后才出现，只读快照看不到它们，必须先点击触发再核对。
 * 点击可能触发同源导航，工具会返回点击后的页面地址与标题。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { IBrowserSessionHost } from './Browser_session'

/** browser_click 工具接受的参数 Schema。 */
const clickParameters = Type.Object({
  /** 目标 iframe 的 frameId（由 browser_list_frames 返回）；缺省表示主文档。 */
  frameId: Type.Optional(
    Type.String({
      description:
        '目标 iframe 的 frameId（由 browser_list_frames 返回）。缺省或不传时操作主文档。',
    }),
  ),  /** 目标元素的 CSS 或 Playwright selector。 */
  selector: Type.String({
    description:
      "要点击元素的 CSS 或 Playwright selector，例如 [data-testid=preview]、text=实际预览、button:has-text('确定')。",
  }),
  /** 单次点击的超时时间（毫秒）。 */
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        '点击操作的超时时间（毫秒）；元素等待较久时可调大，缺省沿用会话默认超时。',
    }),
  ),
})

/** browser_click 工具返回的结构化执行详情。 */
export interface BrowserClickDetails {
  /** 点击使用的 selector。 */
  selector: string
  /** 点击完成后的页面地址（点击可能触发同源导航）。 */
  url: string
  /** 点击完成后的页面标题。 */
  title: string
}

/**
 * 创建点击页面元素的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_click 工具。
 * @throws 不在创建阶段抛出异常；selector 为空、元素不存在、取消或浏览器断连时
 * 由宿主抛出结构化错误，并由运行器记为工具失败。
 */
export function createBrowserClickTool(
  host: IBrowserSessionHost,
): AgentTool<typeof clickParameters, BrowserClickDetails> {
  return {
    name: 'browser_click',
    label: '点击页面元素',
    description:
      '点击页面上的一个元素。用于核对「点击后才出现」的元素：先用本工具触发交互（如点开弹框、展开下拉），再用 browser_snapshot 或 browser_query 核对新出现的元素。点击后返回当前页面地址与标题。',
    parameters: clickParameters,
    // 点击会改变共享页面的状态甚至地址，必须串行执行，避免并发点击互相干扰。
    executionMode: 'sequential',
    /**
     * 点击元素并返回操作后的页面引用。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的 selector 与超时。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；单次点击无中间进度。
     * @returns 包含点击后页面地址与标题的工具结果。
     * @throws 由宿主抛出的结构化浏览器错误透传，由运行器记为工具失败。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const result = await host.clickElement(parameters.selector, {

          ...(parameters.frameId ? { frameId: parameters.frameId } : {}),        ...(parameters.timeoutMs !== undefined
          ? { timeoutMs: parameters.timeoutMs }
          : {}),
      })

      return {
        content: [
          {
            type: 'text',
            text: `已点击「${parameters.selector}」。\n当前页面地址：${result.url}\n页面标题：${result.title || '（无标题）'}\n如该元素触发了新内容（弹框、展开项），请继续用 browser_snapshot 或 browser_query 核对。`,
          },
        ],
        details: {
          selector: parameters.selector,
          url: result.url,
          title: result.title,
        },
      }
    },
  }
}
