/**
 * browser_query 工具：按 selector 查询页面元素并返回结构化信息。
 *
 * 供「页面元素核对」阶段使用（PRD 9.2）。当 Agent 需要用具体 selector
 * 确认某个元素是否存在、其文本或属性是否符合用例预期时调用本工具。
 * 返回值经引擎脱敏，不包含输入框中的真实值。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { IElementInfo } from '@charlie_deng/e2e-assistant-types'
import type { IBrowserSessionHost } from './Browser_session'

/** browser_query 工具接受的参数 Schema。 */
const queryParameters = Type.Object({
  /** 目标 iframe 的 frameId（由 browser_list_frames 返回）；缺省表示主文档。 */
  frameId: Type.Optional(
    Type.String({
      description:
        '目标 iframe 的 frameId（由 browser_list_frames 返回）。缺省或不传时操作主文档。',
    }),
  ),  /** 页面内的 CSS 或 Playwright selector。 */
  selector: Type.String({
    description:
      '页面内的 CSS 或 Playwright selector，例如 input[name=email]、[data-testid=submit]、text=登录。',
  }),
})

/** browser_query 工具返回的结构化执行详情。 */
export interface BrowserQueryDetails {
  /** 本次查询使用的 selector。 */
  selector: string
  /** 命中的元素数量。 */
  matched: number
}

/**
 * 把元素信息格式化为模型易读的紧凑文本。
 *
 * @param elements - 引擎返回的结构化元素信息列表。
 * @param selector - 本次查询使用的 selector，用于空结果说明。
 * @returns 每行一个元素的文本；无命中时返回明确的未命中说明。
 * @throws 不抛出异常。
 */
function formatElements (elements: IElementInfo[], selector: string): string {
  if (elements.length === 0) {
    // 未命中是重要的核对结论：必须明确告知，不能让模型误以为页面元素存在。
    return `selector「${selector}」在当前页面没有匹配到任何元素。请核对页面结构后调整定位方式。`
  }

  return elements
    .map((element, index) => {
      const parts = [
        element.tagName ? `标签=${element.tagName}` : '',
        element.role ? `role=${element.role}` : '',
        element.name ? `name=${element.name}` : '',
        element.text ? `文本=${element.text}` : '',
        element.value !== undefined ? `值=${element.value}` : '',
      ].filter(Boolean)

      const attributes = element.attributes
        ? Object.entries(element.attributes)
          .map(([key, value]) => `${key}="${value}"`)
          .join(' ')
        : ''

      return `${index + 1}. ${parts.join(' | ')}${attributes ? `\n   属性：${attributes}` : ''
        }`
    })
    .join('\n')
}

/**
 * 创建按 selector 查询页面元素的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_query 工具。
 * @throws 不在创建阶段抛出异常；页面不可用、取消或浏览器断连时由宿主抛出结构化错误。
 */
export function createBrowserQueryTool (
  host: IBrowserSessionHost,
): AgentTool<typeof queryParameters, BrowserQueryDetails> {
  return {
    name: 'browser_query',
    label: '查询页面元素',
    description:
      '按 CSS 或 Playwright selector 查询当前页面元素，返回标签、角色、文本和属性等结构化信息。用于核对用例步骤涉及的元素是否真实存在及其定位方式。',
    parameters: queryParameters,
    executionMode: 'sequential',
    /**
     * 查询元素并格式化为模型可读文本。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的 selector。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；单次查询无中间进度。
     * @returns 包含命中元素结构化信息的工具结果。
     * @throws 由宿主抛出的结构化浏览器错误透传，由运行器记为工具失败。
     */
    async execute (toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const elements = await host.queryElements(parameters.selector, parameters.frameId ? { frameId: parameters.frameId } : undefined)

      return {
        content: [
          {
            type: 'text',
            text: `命中 ${elements.length} 个元素：\n${formatElements(
              elements,
              parameters.selector,
            )}`,
          },
        ],
        details: { selector: parameters.selector, matched: elements.length },
      }
    },
  }
}
