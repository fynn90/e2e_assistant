/**
 * browser_list_frames 工具：枚举当前页面的主文档与 iframe 元数据。
 *
 * Agent 遇到主文档快照缺少预期元素时，先用本工具发现 iframe，
 * 再把返回的 frameId 传给 browser_snapshot / browser_query / browser_click 等
 * 既有浏览器工具，即可读取和操作 iframe 内部的页面内容。
 *
 * frameId 是短生命周期句柄：导航后立即失效，必须重新调用本工具获取最新清单。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { IFrameInfo } from '@authine-e2e-agent/types'
import type { IBrowserSessionHost } from './Browser_session'

/** browser_list_frames 工具接受的参数 Schema。 */
const listFramesParameters = Type.Object({
  /** 是否包含不可见的 iframe；缺省只返回可见的。 */
  includeHidden: Type.Optional(
    Type.Boolean({
      description: '是否包含不可见的 iframe；缺省只返回可见的。',
    }),
  ),
  /** 最大返回 frame 数量；缺省由引擎的有界策略决定。 */
  maxFrames: Type.Optional(
    Type.Number({
      description: '最大返回 frame 数量；页面 iframe 较多时可调高。',
    }),
  ),
})

/** browser_list_frames 工具返回的结构化执行详情。 */
export interface BrowserListFramesDetails {
  /** 主文档的 frameId。 */
  mainFrameId: string
  /** 返回的 frame 数量。 */
  frameCount: number
  /** 是否因超出上限而被截断。 */
  truncated: boolean
}

/**
 * 把单个 frame 元数据格式化为模型易读的一行。
 *
 * @param frame - 引擎返回的 frame 元信息。
 * @param index - 显示序号（从 1 开始）。
 * @returns 一行描述文本。
 * @throws 不抛出异常。
 */
function formatFrame(frame: IFrameInfo, index: number): string {
  const parts = [
    `frameId=${frame.frameId}`,
    `父=${frame.parentFrameId ?? '无'}`,
    `url=${frame.url}`,
    `sameOrigin=${frame.sameOrigin ? 'yes' : 'no'}`,
    `operationAllowed=${frame.operationAllowed ? 'yes' : 'no'}`,
    `locatorChain=[${frame.locatorChain.join(' → ')}]`,
  ].filter(Boolean)
  return `${index + 1}. ${parts.join(' | ')}`
}

/**
 * 创建枚举当前页面 frame 清单的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_list_frames 工具。
 * @throws 不在创建阶段抛出异常；页面不可用时由宿主抛出结构化错误。
 */
export function createBrowserListFramesTool(
  host: IBrowserSessionHost,
): AgentTool<typeof listFramesParameters, BrowserListFramesDetails> {
  return {
    name: 'browser_list_frames',
    label: '列出页面 iframe',
    description:
      '枚举当前页面的主文档与所有 iframe 元数据。返回每个 frame 的 frameId、URL、嵌套关系和 locatorChain。'
      + '主文档 browser_snapshot 看不到预期元素时，先调用本工具发现 iframe，'
      + '再把 frameId 传给 browser_snapshot / browser_query / browser_click 等工具即可操作 iframe 内部。'
      + 'frameId 是短生命周期句柄，导航后立即失效，必须重新调用本工具。'
      + 'operationAllowed=no 的跨源 iframe 当前策略禁止操作。',
    parameters: listFramesParameters,
    // 读操作，可并行执行。
    executionMode: 'parallel',
    /**
     * 枚举 frame 并格式化为模型可读文本。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的参数。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；单次枚举无中间进度。
     * @returns 包含 frame 清单的工具结果。
     * @throws 由宿主抛出的结构化浏览器错误透传，由运行器记为工具失败。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const inventory = await host.listFrames({
        ...(parameters.includeHidden !== undefined
          ? { includeHidden: parameters.includeHidden }
          : {}),
        ...(parameters.maxFrames !== undefined
          ? { maxFrames: parameters.maxFrames }
          : {}),
      })

      const lines = inventory.frames.map((frame, i) => formatFrame(frame, i))
      const usageNote = [
        '',
        '后续操作：把 frameId 传给 browser_snapshot / browser_query / browser_click /',
        'browser_fill / browser_select / browser_waitFor / browser_screenshot 即可操作对应 iframe。',
        '不要把 frameId 写入最终 Playwright 脚本；生成脚本时使用 locatorChain 生成 page.frameLocator()。',
      ].join('\n')

      const text = [
        `当前页面共有 ${inventory.frames.length} 个 frame：`,
        '',
        ...lines,
        ...(inventory.truncated ? ['', '注意：iframe 数量超出上限，清单已截断。'] : []),
        usageNote,
      ].join('\n')

      return {
        content: [{ type: 'text', text }],
        details: {
          mainFrameId: inventory.mainFrameId,
          frameCount: inventory.frames.length,
          truncated: inventory.truncated,
        },
      }
    },
  }
}
