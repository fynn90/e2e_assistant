/**
 * browser_select 工具：在下拉框（select）中选中指定选项。
 *
 * 供「页面元素核对」阶段使用：切换下拉框后会更新的区域（画布、表格、联动表单）
 * 只在选择动作发生后才有真实内容，只读快照看不到，必须先选择再核对。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { IBrowserSessionHost } from './Browser_session'

/** browser_select 工具接受的参数 Schema。 */
const selectParameters = Type.Object({
  /** 目标 iframe 的 frameId（由 browser_list_frames 返回）；缺省表示主文档。 */
  frameId: Type.Optional(
    Type.String({
      description:
        '目标 iframe 的 frameId（由 browser_list_frames 返回）。缺省或不传时操作主文档。',
    }),
  ),  /** 目标 select 元素的 CSS 或 Playwright selector。 */
  selector: Type.String({
    description:
      '目标下拉框的 CSS 或 Playwright selector，例如 select[name=template]、#print-mode。',
  }),
  /** 要选中的选项值。 */
  value: Type.String({
    description:
      '要选中的选项 value（对应 option 标签的 value 属性，不是显示文本）。若页面按显示文本匹配，请先用 browser_query 查询该 select 的候选值。',
  }),
  /** 单次选择的超时时间（毫秒）。 */
  timeoutMs: Type.Optional(
    Type.Number({
      description: '选择操作的超时时间（毫秒）；缺省沿用会话默认超时。',
    }),
  ),
})

/** browser_select 工具返回的结构化执行详情。 */
export interface BrowserSelectDetails {
  /** 目标 select 的 selector。 */
  selector: string
  /** 已选中的选项值。 */
  value: string
  /** 选择完成后的页面地址。 */
  url: string
  /** 选择完成后的页面标题。 */
  title: string
}

/**
 * 创建在下拉框中选中选项的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_select 工具。
 * @throws 不在创建阶段抛出异常；selector 或值非法、元素不存在、取消或浏览器断连时
 * 由宿主抛出结构化错误，并由运行器记为工具失败。
 */
export function createBrowserSelectTool(
  host: IBrowserSessionHost,
): AgentTool<typeof selectParameters, BrowserSelectDetails> {
  return {
    name: 'browser_select',
    label: '选择下拉项',
    description:
      '在页面下拉框（select 元素）中选中一个选项。用于核对「切换选项后才更新」的区域：先用本工具完成切换，再用 browser_snapshot 或 browser_query 核对更新后的内容。value 必须是 option 的 value 属性值。',
    parameters: selectParameters,
    // 选择会改变共享页面状态，必须串行执行，避免并发操作互相覆盖。
    executionMode: 'sequential',
    /**
     * 选中下拉项并返回操作后的页面引用。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的 selector、选项值与超时。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；单次选择无中间进度。
     * @returns 包含选中结果与页面地址的工具结果。
     * @throws 由宿主抛出的结构化浏览器错误透传，由运行器记为工具失败。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const result = await host.selectElementOption(
        parameters.selector,
        parameters.value,
        {
          ...(parameters.frameId ? { frameId: parameters.frameId } : {}),
          ...(parameters.timeoutMs !== undefined
            ? { timeoutMs: parameters.timeoutMs }
            : {}),
        },
      )

      return {
        content: [
          {
            type: 'text',
            text: `已在「${parameters.selector}」中选中「${parameters.value}」。\n当前页面地址：${result.url}\n页面标题：${result.title || '（无标题）'}\n请继续用 browser_snapshot 或 browser_query 核对切换后更新的区域。`,
          },
        ],
        details: {
          selector: parameters.selector,
          value: parameters.value,
          url: result.url,
          title: result.title,
        },
      }
    },
  }
}
