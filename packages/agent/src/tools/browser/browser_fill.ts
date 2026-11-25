/**
 * browser_fill 工具：在输入框中填入文本，支持以 `${ENV:KEY}` 引用敏感数据。
 *
 * 供「页面元素核对」阶段使用。它解决的是多步骤用例的第一道门槛：
 * 登录页需要账号密码，而密码存放在 env.json 中、Agent 不得读取——
 * 本工具让 Agent 填入**引用**而非真值，由引擎在最后一刻换取真值，
 * 从而使登录之后的步骤能够被真实核对，而不是整条链路停在断点上。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { isSensitiveTestDataEntry } from '@fynn90-e2e_assistant/types'
import type { IBrowserSessionHost } from './Browser_session'

/** browser_fill 工具接受的参数 Schema。 */
const fillParameters = Type.Object({
  /** 目标 iframe 的 frameId（由 browser_list_frames 返回）；缺省表示主文档。 */
  frameId: Type.Optional(
    Type.String({
      description:
        '目标 iframe 的 frameId（由 browser_list_frames 返回）。缺省或不传时操作主文档。',
    }),
  ),  /** 目标输入元素的 CSS 或 Playwright selector。 */
  selector: Type.String({
    description:
      "要填入的输入框的 CSS 或 Playwright selector，例如 input[name=username]、[data-testid=password]、getByLabel('登录密码')。",
  }),
  /**
   * 待填入的内容：普通文本，或引用 env.json 的 `${ENV:KEY}` 占位符。
   *
   * description 必须把两种形态与「何时用哪种」讲清楚，否则模型会在需要凭据时
   * 直接编造明文（生成规则明确禁止），或把引用错写成别的语法。
   */
  value: Type.String({
    description:
      '要填入的文本。涉及密码、Token 等敏感数据时必须写成 ${ENV:KEY} 引用形态（例如 ${ENV:E2E_PASSWORD}），' +
      '其中 KEY 必须与用例数据中声明的 env key 完全一致；真实值由平台在填入时注入，你看不到也不需要知道它。' +
      '用户名、验证码等非敏感内容可直接写明文。注意本参数的值必须整体是一个引用，不能与其它文字拼接。',
  }),
  /** 单次填入的超时时间（毫秒）。 */
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        '填入操作的超时时间（毫秒）；输入框出现较慢时可调大，缺省沿用会话默认超时。',
    }),
  ),
})

/** browser_fill 工具返回的结构化执行详情。 */
export interface BrowserFillDetails {
  /** 填入使用的 selector。 */
  selector: string
  /** 本次填入的是否为 env.json 引用（真值不记录）。 */
  fromCredentialReference: boolean
  /** 填入完成后的页面地址。 */
  url: string
  /** 填入完成后的页面标题。 */
  title: string
}

/**
 * 创建填入输入框的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_fill 工具。
 * @throws 不在创建阶段抛出异常；selector 为空、引用解析失败、元素不可编辑、
 * 取消或浏览器断连时由宿主抛出结构化错误，并由运行器记为工具失败。
 */
export function createBrowserFillTool (
  host: IBrowserSessionHost,
): AgentTool<typeof fillParameters, BrowserFillDetails> {
  return {
    name: 'browser_fill',
    label: '填入输入框',
    description:
      '在页面的输入框中填入文本。登录、检索、表单等场景用它输入内容后，再用 browser_click 提交。' +
      '涉及密码、Token 等敏感数据时，value 必须写成 ${ENV:KEY} 引用（与用例数据中声明的 env key 一致），' +
      '真实值由平台注入，不会出现在你的上下文里；切勿自行编造或猜测敏感明文。' +
      '它只负责输入，不负责提交；下拉框请改用 browser_select。',
    parameters: fillParameters,
    // 填入会改变共享页面的状态，必须串行执行，避免与其它页面操作互相干扰。
    executionMode: 'sequential',
    /**
     * 填入输入框并返回操作后的页面引用。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的 selector、待填值与超时。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；单次填入无中间进度。
     * @returns 包含填入后页面地址与标题的工具结果。
     * @throws 由宿主抛出的结构化浏览器错误透传，由运行器记为工具失败。
     */
    async execute (toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const result = await host.fillElement(parameters.selector, parameters.value, {

        ...(parameters.frameId ? { frameId: parameters.frameId } : {}),
        ...(parameters.timeoutMs !== undefined
          ? { timeoutMs: parameters.timeoutMs }
          : {}),
      })

      // 回执只说明「填了什么位置、是否用了凭据」，绝不回显填入的值：
      // 该值可能是从 env.json 解析出的真实密码。
      // 判定复用 types 包的共享契约函数，避免引用语法在两端各写一份而漂移。
      const usedCredential = isSensitiveTestDataEntry(parameters.value)
      const credentialNote = usedCredential
        ? '（已按 env.json 引用填入敏感数据，真实值不会显示）'
        : ''

      return {
        content: [
          {
            type: 'text',
            text: `已在「${parameters.selector}」填入内容${credentialNote}。\n当前页面地址：${result.url}\n页面标题：${result.title || '（无标题）'}\n如需提交，请用 browser_click 点击提交按钮。`,
          },
        ],
        details: {
          selector: parameters.selector,
          fromCredentialReference: usedCredential,
          url: result.url,
          title: result.title,
        },
      }
    },
  }
}
