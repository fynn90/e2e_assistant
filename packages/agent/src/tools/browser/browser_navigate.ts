/**
 * browser_navigate 工具：让生成 Agent 在用例同源范围内打开目标页面。
 *
 * 供「页面元素核对」阶段使用（PRD 9.2）。导航范围由注入的浏览器宿主
 * 依据用例 baseUrl 与同源网络策略限制，工具本身不解析或放宽任何 URL。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { IBrowserSessionHost } from './Browser_session'

/** browser_navigate 工具接受的参数 Schema。 */
const navigateParameters = Type.Object({
  /** 目标页面 URL；缺省导航到用例 baseUrl 对应的登录/入口页面。 */
  url: Type.Optional(
    Type.String({
      description:
        '要打开的页面 URL，必须是当前用例 baseUrl 的同源地址。缺省时打开用例 baseUrl。',
    }),
  ),
})

/** browser_navigate 工具返回的结构化执行详情。 */
export interface BrowserNavigateDetails {
  /** 导航完成后的实际页面地址（可能因页面重定向而变化）。 */
  url: string
  /** 导航完成后的页面标题。 */
  title: string
}

/**
 * 创建在用例同源范围内导航页面的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_navigate 工具。
 * @throws 不在创建阶段抛出异常；导航越权、页面不可访问、取消或浏览器断连时
 * 由宿主抛出结构化错误，并由工具作为失败结果返回给模型。
 */
export function createBrowserNavigateTool(
  host: IBrowserSessionHost,
): AgentTool<typeof navigateParameters, BrowserNavigateDetails> {
  return {
    name: 'browser_navigate',
    label: '打开目标页面',
    description:
      '在浏览器中打开目标页面，用于核对页面真实元素。只能访问当前用例 baseUrl 及其同源地址；页面正常加载所需的重定向和 CDN 子资源会被自动放行。',
    parameters: navigateParameters,
    // 导航会改变共享页面的当前地址，必须串行执行，避免并发导航互相覆盖。
    executionMode: 'sequential',
    /**
     * 打开页面并返回实际地址与标题。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的目标 URL。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；导航为单次等待，无中间进度。
     * @returns 包含页面地址与标题的工具结果。
     * @throws 由宿主抛出的结构化浏览器错误透传，由运行器记为工具失败。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const page = await host.openPage(parameters.url)

      return {
        content: [
          {
            type: 'text',
            text: `已打开页面：${page.url}\n页面标题：${page.title || '（无标题）'}`,
          },
        ],
        details: { url: page.url, title: page.title },
      }
    },
  }
}
