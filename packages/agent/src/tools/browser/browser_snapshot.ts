/**
 * browser_snapshot 工具：采集当前页面的有界可访问性树与候选定位器。
 *
 * 供「页面元素核对」阶段使用（PRD 9.2）。快照让 Agent 在不知道具体 selector 时
 * 也能了解页面结构，并优先选择稳定、可理解的定位方式；返回值已由引擎脱敏。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  ICandidateLocator,
  IPageSnapshot,
} from '@fynn90-e2e_assistant/types'
import type { IBrowserSessionHost } from './Browser_session'

/** browser_snapshot 工具接受的参数 Schema。 */
const snapshotParameters = Type.Object({
  /** 目标 iframe 的 frameId（由 browser_list_frames 返回）；缺省表示主文档。 */
  frameId: Type.Optional(
    Type.String({
      description:
        '目标 iframe 的 frameId（由 browser_list_frames 返回）。缺省或不传时操作主文档。',
    }),
  ),  /** 可访问性树的最大字符数；缺省由引擎的有界策略决定。 */
  maxA11yLength: Type.Optional(
    Type.Number({
      description:
        '可访问性树快照的最大字符数上限。页面较大时可调低以避免输出过长。',
    }),
  ),
  /** 候选定位器的最大返回数量；缺省由引擎的有界策略决定。 */
  maxLocators: Type.Optional(
    Type.Number({
      description: '候选定位器（role、label、testId 等）的最大返回数量。',
    }),
  ),
})

/** browser_snapshot 工具返回的结构化执行详情。 */
export interface BrowserSnapshotDetails {
  /** 采集快照时的页面地址。 */
  url: string
  /** 页面标题。 */
  title: string
  /** 快照是否因超出上限而被截断。 */
  truncated: boolean
  /** 候选定位器数量，便于模型判断是否还需补充查询。 */
  candidateCount: number
}

/**
 * 把候选定位器格式化为模型易读的紧凑文本。
 *
 * @param locators - 引擎采集的候选定位器列表。
 * @returns 每行一个候选定位器的文本；无候选时返回占位说明。
 * @throws 不抛出异常。
 */
function formatCandidateLocators (locators: ICandidateLocator[]): string {
  if (locators.length === 0) {
    return '（未采集到候选定位器，可使用 browser_query 按 selector 精确查询）'
  }

  return locators
    .map((locator, index) => {
      // 只输出引擎实际提供的字段，缺失字段跳过，避免出现 "undefined" 干扰模型。
      const parts = [
        locator.role ? `role=${locator.role}` : '',
        locator.name ? `name=${locator.name}` : '',
        locator.label ? `label=${locator.label}` : '',
        locator.placeholder ? `placeholder=${locator.placeholder}` : '',
        locator.testId ? `testId=${locator.testId}` : '',
        locator.text ? `text=${locator.text}` : '',
        locator.css ? `css=${locator.css}` : '',
      ].filter(Boolean)

      return `${index + 1}. ${parts.join(' | ') || '（无定位信息）'}`
    })
    .join('\n')
}

/**
 * 创建采集当前页面快照的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_snapshot 工具。
 * @throws 不在创建阶段抛出异常；页面不可用、取消或浏览器断连时由宿主抛出结构化错误。
 */
export function createBrowserSnapshotTool (
  host: IBrowserSessionHost,
): AgentTool<typeof snapshotParameters, BrowserSnapshotDetails> {
  return {
    name: 'browser_snapshot',
    label: '采集页面快照',
    description:
      '采集当前页面的可访问性树和候选定位器，用于核对页面真实元素、选择稳定的定位方式。建议在 browser_navigate 之后调用。',
    parameters: snapshotParameters,
    executionMode: 'sequential',
    /**
     * 采集页面快照并格式化为模型可读文本。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的快照长度与候选数量上限。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；快照为单次采集，无中间进度。
     * @returns 包含可访问性树文本与候选定位器清单的工具结果。
     * @throws 由宿主抛出的结构化浏览器错误透传，由运行器记为工具失败。
     */
    async execute (toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const snapshot: IPageSnapshot = await host.snapshotPage({
        ...(parameters.frameId ? { frameId: parameters.frameId } : {}),
        ...(parameters.maxA11yLength !== undefined
          ? { maxA11yLength: parameters.maxA11yLength }
          : {}),
        ...(parameters.maxLocators !== undefined
          ? { maxLocators: parameters.maxLocators }
          : {}),
      })

      const text = [
        `页面地址：${snapshot.url}`,
        `页面标题：${snapshot.title || '（无标题）'}`,
        snapshot.truncated
          ? '注意：快照内容过长已截断，未展示的页面区域需要时请用 browser_query 精确查询。'
          : '',
        '',
        '候选定位器（优先使用 role / label / testId 等稳定定位）：',
        formatCandidateLocators(snapshot.candidateLocators),
        '',
        '可访问性树：',
        snapshot.a11yTree,
      ]
        .filter((line) => line !== '')
        .join('\n')

      return {
        content: [{ type: 'text', text }],
        details: {
          url: snapshot.url,
          title: snapshot.title,
          truncated: snapshot.truncated,
          candidateCount: snapshot.candidateLocators.length,
        },
      }
    },
  }
}
