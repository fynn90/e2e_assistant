/**
 * render_view 工具（v17）：让 /agent 中的 Agent 请求平台渲染一张**只读视图卡**。
 *
 * 本协议的核心接缝（技术方案 §5.1）：**协议传的是「选择」，不是「数据」**。
 * 参数里没有数据字段，只有「渲染哪种视图 + 什么范围 + 哪个用例」这类小参数；
 * 宿主拿到参数后**自己检索一遍**再渲染。
 *
 * 为什么不让模型传数据（初稿的反例）：
 *   ① 模型要把它刚读到的清单原样复述一遍，token 翻倍；
 *   ② 复述 20 行时可能悄悄漏字段、改数字——而**卡片是「结论」，出错用户看不出来**；
 *   ③ 未来若卡片要含敏感字段，值就会经过模型。
 * 宿主自取一次性消掉三者。
 *
 * 「类型」是平台拥有的**封闭枚举**（`TAgentWorkbenchViewKind`）：Agent 只能从枚举里选，
 * 不能自造。新增一种视图 = 前端加一个组件 + 枚举加一个值，**成对发生**——这是协议
 * 能成立的前提（Agent 自造的类型前端没有对应组件，渲染不出来）。
 *
 * 与读取工具（list_skills / read_test_case / read_run_history / check_readiness）
 * 的分工：读取工具**只回数据给模型**，用于它做判断；本工具**只发卡片给用户**，
 * 用于呈现结论。两者不总是一起发生——模型问「用户说的是哪个用例」时只需数据，
 * 不该在对话流里留下一个多余的清单卡。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  TAgentWorkbenchViewKind,
  TWorkbenchRenderParams,
} from '@fynn90-e2e_assistant/types'

/**
 * 视图渲染宿主端口：由 CLI 组合根注入。
 *
 * 实现方职责有**两件**，缺一不可：
 *   ① **按 params 自取数据**——宿主持有检索/体检能力的引用，自己查一遍；
 *   ② 填进 payload 并发布为 `workbench_view` 块。
 *
 * 参数指向的目标不存在时返回 `ok: false` 并说明（不抛出，由工具转述给模型）。
 */
export interface IViewHost {
  /**
   * 渲染并发布一张只读视图卡。
   *
   * @param params - 模型给出的渲染参数（视图种类 + 范围，不含数据）。
   * @returns 发布结果；目标不存在或参数不合法时为 ok:false 并说明。
   * @throws 不抛出异常——失败以 ok:false 归一，由工具转述给模型。
   */
  renderView (
    params: TWorkbenchRenderParams,
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }>
}

/** render_view 工具接受的参数 Schema。 */
const renderViewParameters = Type.Object({
  viewKind: Type.Union(
    [
      Type.Literal('skill-list'),
      Type.Literal('skill-detail'),
      Type.Literal('run-history'),
      Type.Literal('readiness'),
      Type.Literal('capability'),
    ],
    {
      description:
        '要渲染的视图种类：skill-list（用例清单卡）、skill-detail（用例详情卡）、run-history（执行历史卡）、readiness（体检卡）、capability（你能做什么的能力卡）。',
    },
  ),
  skillId: Type.Optional(
    Type.String({
      description:
        '目标用例的九位唯一 ID。skill-detail / run-history / readiness 必填；skill-list 与 capability 不要传。',
    }),
  ),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal('missing-document'),
        Type.Literal('missing-script'),
        Type.Literal('never-executed'),
        Type.Literal('last-failed'),
      ],
      {
        description:
          'skill-list 的筛选：缺文档 / 缺脚本 / 未执行过 / 最近失败。用户明确说了筛选条件时才传。',
      },
    ),
  ),
  keyword: Type.Optional(
    Type.String({
      description:
        'skill-list 的关键词筛选（匹配标题 / 描述 / 步骤内容）。用户说了关键词时才传，不要自己编。',
    }),
  ),
  tag: Type.Optional(
    Type.String({ description: 'skill-list 的标签筛选。用户说了标签时才传。' }),
  ),
})

/** render_view 工具返回的结构化详情。 */
export interface RenderViewDetails {
  ok: boolean
  viewKind: TAgentWorkbenchViewKind
  skillId?: string
}

/**
 * 创建请求平台渲染只读视图卡的工具。
 *
 * @param host - CLI 组合根注入的视图宿主。
 * @returns 可直接配置到 AgentTool[] 的 render_view 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createRenderViewTool (
  host: IViewHost,
): AgentTool<typeof renderViewParameters, RenderViewDetails> {
  return {
    name: 'render_view',
    label: '渲染视图卡',
    description:
      '在对话流中渲染一张结构化卡片：用例清单（skill-list，可按状态 / 关键词 / 标签筛选）、用例详情（skill-detail，需 skillId）、执行历史（run-history，需 skillId）、执行前体检（readiness，需 skillId）、能力说明（capability）。**凡是能结构化的内容都用它回答，而不是写成一大段文字**（清单、步骤、统计、历史、体检结果、能力清单）。本工具只给「渲染哪种视图、什么范围」，数据由平台自己取——所以你不需要、也不要把读到的内容复述进来。',
    parameters: renderViewParameters,
    executionMode: 'sequential',
    /**
     * 组装参数并交给宿主渲染。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数。
     * @param _signal - 取消信号；本工具不使用（渲染是本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含渲染结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute (_toolCallId, parameters, _signal, _onUpdate) {
      void _toolCallId
      void _signal
      void _onUpdate

      const skillId = parameters.skillId?.trim() ?? ''
      const needsSkill =
        parameters.viewKind !== 'skill-list' &&
        parameters.viewKind !== 'capability'

      // 参数校验先于宿主：缺 ID 时给出可自修复的说明，不打一次无谓的磁盘。
      if (needsSkill && skillId.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `渲染 ${parameters.viewKind} 视图需要目标用例的九位唯一 ID。请先用 list_skills 取得候选 ID，再带上 skillId 重试。`,
            },
          ],
          details: { ok: false, viewKind: parameters.viewKind },
        }
      }

      if (!needsSkill && skillId.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${parameters.viewKind} 视图不接受 skillId（它是跨用例的视图）。请去掉 skillId 后重试。`,
            },
          ],
          details: { ok: false, viewKind: parameters.viewKind },
        }
      }

      const params = buildRenderParams(parameters, skillId)
      const result = await host.renderView(params)

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `${result.message}\n请如实告知用户，并调整做法后重试；不要编造一个已经出现的卡片。`,
            },
          ],
          details: {
            ok: false,
            viewKind: parameters.viewKind,
            ...(skillId ? { skillId } : {}),
          },
        }
      }

      return {
        content: [{ type: 'text', text: result.message }],
        details: {
          ok: true,
          viewKind: parameters.viewKind,
          ...(skillId ? { skillId } : {}),
        },
      }
    },
  }
}

/**
 * 把已校验的工具参数收窄为渲染参数联合（按 viewKind 取其一）。
 *
 * 收窄而不是断言：TypeBox 的 schema 只保证「形状合法」，而联合类型要求
 * 「按 viewKind 分的字段组合合法」——两者之间的差距必须由显式构造补齐，
 * 顺带把 `undefined` 字段剔掉，避免下游把空字符串当成有效筛选条件。
 *
 * @param parameters - 已通过 schema 校验的工具参数。
 * @param skillId - 已 trim 的 skillId（无则为空串）。
 * @returns 可交给宿主的渲染参数。
 * @throws 不抛出异常。
 */
function buildRenderParams (
  parameters: {
    viewKind: TAgentWorkbenchViewKind
    status?: string
    keyword?: string
    tag?: string
  },
  skillId: string,
): TWorkbenchRenderParams {
  if (parameters.viewKind === 'capability') {
    return { viewKind: 'capability' }
  }

  if (parameters.viewKind === 'skill-list') {
    const keyword = parameters.keyword?.trim()
    const tag = parameters.tag?.trim()
    return {
      viewKind: 'skill-list',
      ...(isListStatus(parameters.status) ? { status: parameters.status } : {}),
      ...(keyword ? { keyword } : {}),
      ...(tag ? { tag } : {}),
    }
  }

  return { viewKind: parameters.viewKind, skillId }
}

/**
 * 判定筛选状态是否为合法枚举值。
 *
 * @param status - 工具参数里的原始值。
 * @returns 是四种合法筛选状态之一时返回 true。
 * @throws 不抛出异常。
 */
function isListStatus (
  status: string | undefined,
): status is
  'missing-document' | 'missing-script' | 'never-executed' | 'last-failed' {
  return (
    status === 'missing-document' ||
    status === 'missing-script' ||
    status === 'never-executed' ||
    status === 'last-failed'
  )
}
