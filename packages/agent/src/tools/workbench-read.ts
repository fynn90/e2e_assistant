/**
 * 工作台读取工具集（v17）：read_test_case / read_run_history / check_readiness。
 *
 * 为什么从 `skill-catalog.ts` 拆出来独立成模块：那个模块回答的是「工作区里有哪些
 * 用例、某个用例的文档是什么」（定位能力），本模块回答的是「某个用例长什么样、
 * 跑过几次、现在能不能跑」（诊断能力）。两者的宿主端口虽同属检索族，
 * 但职责不同、消费者不同（前者服务于「定位目标」，后者服务于「回答问询」），
 * 合在一起会让该文件同时承担两种变化的理由（单一职责）。
 *
 * 三个工具都是**只读的**：不改盘、不发卡片、不启动运行。要展示卡片时由
 * `render_view` 负责（协议传选择不传数据，见 `render-view.ts`）。
 *
 * 安全边界：`read_test_case` 只回 env **key 清单**，值永不出现在任何字段里
 * （D7 / SEC-4，与 v10 的敏感值隔离同源）。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ISkillCatalogHost, IReadinessHost } from './skill-catalog'

/** SKILL 唯一 ID 的形状：9 位 [a-z0-9]（与 skill-manager 的判定一致）。 */
const SKILL_ID_PATTERN = /^[a-z0-9]{9}$/

/** 非法 ID 的统一提示（可自修复：模型应先检索再重试）。 */
const INVALID_ID_HINT =
  'Skill ID 必须是九位小写字母或数字（如 abc123456）。请先用 list_skills 取得候选，再用候选的 ID 调用本工具。'

/** 三个工具共用的单 ID 参数 Schema。 */
const singleSkillIdParameters = Type.Object({
  skillId: Type.String({
    description:
      '目标用例的九位唯一 ID（[a-z0-9]）。先用 list_skills 获得候选，不要用标题或目录名代替。',
  }),
})

/** read_test_case 工具返回的结构化详情。 */
export interface ReadTestCaseDetails {
  ok: boolean
  skillId: string
  /** 是否已有 test.spec.ts（决定下一步是执行还是生成脚本）。 */
  hasPlaywrightScript?: boolean
}

/** read_run_history 工具返回的结构化详情。 */
export interface ReadRunHistoryDetails {
  ok: boolean
  skillId: string
  /** 本次返回的次数。 */
  count?: number
  /** 该用例从未执行过。 */
  neverExecuted?: boolean
}

/** check_readiness 工具返回的结构化详情。 */
export interface CheckReadinessDetails {
  ok: boolean
  skillId: string
  /** 体检是否全部通过。 */
  ready?: boolean
}

/**
 * 创建读取用例详情的工具（v17 Q4）。
 *
 * 与 `read_skill_document` 的分工：文档工具读的是 SKILL.md 的**自然人文本**，
 * 本工具读的是**结构化用例**（步骤 / 前置条件 / 目标地址 / 引用的 env key）——
 * 模型要改用例时，判据必须是结构化数据本身，而不是文档里的一段话。
 *
 * @param host - CLI 组合根注入的检索宿主。
 * @returns 可直接配置到 AgentTool[] 的 read_test_case 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createReadTestCaseTool(
  host: ISkillCatalogHost,
): AgentTool<typeof singleSkillIdParameters, ReadTestCaseDetails> {
  return {
    name: 'read_test_case',
    label: '读取用例详情',
    description:
      '读取某个 e2e 测试用例的**结构化内容**：标题、描述、目标地址、标签、前置条件、全部步骤（含预期结果与启用状态）、产物完备性，以及用例引用的环境变量 key 清单（只列 key，不含值）。用户问「这个用例是怎么写的」或你要改用例前核对现状时用它。**本工具只回数据，不发卡片**——用户要看详情卡时改用 render_view({viewKind:"skill-detail"})。',
    parameters: singleSkillIdParameters,
    executionMode: 'sequential',
    /**
     * 经宿主读取结构化用例并格式化给模型。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId 必填）。
     * @param _signal - 取消信号；本工具不使用（宿主调用为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含用例详情的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute(_toolCallId, parameters, _signal, _onUpdate) {
      void _toolCallId
      void _signal
      void _onUpdate

      const skillId = parameters.skillId?.trim() ?? ''
      if (!SKILL_ID_PATTERN.test(skillId)) {
        return {
          content: [{ type: 'text', text: INVALID_ID_HINT }],
          details: { ok: false, skillId },
        }
      }

      const result = await host.readTestCase(skillId)
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `${result.message}\n请先用 list_skills 确认目标是否存在，不要猜测 ID。`,
            },
          ],
          details: { ok: false, skillId },
        }
      }

      const detail = result.detail
      const steps = detail.steps
        .map((step) => {
          // 停用步骤必须显式标注：模型据此判断「用例里写了什么」，漏标注会让它
          // 在改动时误判步骤集合（v17 §6.1 的易错点之一）。
          const enabledMark = step.enabled ? '' : '（已停用）'
          return `${step.order}. ${step.description}${enabledMark}\n   操作：${step.action}\n   预期：${step.expectedResult}`
        })
        .join('\n')

      const preconditions = detail.preconditions
        .map((item) => `- ${item.description}`)
        .join('\n')

      const lines = [
        `用例 ${detail.skillId} 的结构化内容：`,
        `标题：${detail.title}`,
        `描述：${detail.description}`,
        `目标地址：${detail.baseUrl || '（未配置）'}`,
        `标签：${detail.tags && detail.tags.length > 0 ? detail.tags.join('、') : '（无）'}`,
        `产物：${detail.hasSkillDocument ? '已有 SKILL.md' : '缺 SKILL.md'}、${
          detail.hasPlaywrightScript ? '已有脚本' : '缺脚本'
        }`,
        '',
        '前置条件：',
        preconditions || '（无）',
        '',
        '步骤：',
        steps || '（无）',
        '',
        `引用的环境变量 key：${
          detail.envKeys.length > 0 ? detail.envKeys.join('、') : '（无）'
        }`,
      ]

      if (detail.missingEnvKeys.length > 0) {
        // 与体检卡的 J4 判定**不同源且可能不一致**：这里是「用例写了但 env 没定义」，
        // 体检卡是「脚本要读但 env 没定义」。两者都如实呈现，不做统一
        //（技术方案 §6.1 的易错点）。
        lines.push(
          `**用例中提到、但 env.json 里没有的 key**：${detail.missingEnvKeys.join('、')}`,
        )
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          ok: true,
          skillId,
          hasPlaywrightScript: detail.hasPlaywrightScript,
        },
      }
    },
  }
}

/**
 * 创建读取执行历史的工具（v17 Q7）。
 *
 * 历史以**持久化报告**为准：凡生成了报告的执行，即使服务重启后仍可见；
 * 未生成报告的执行（就绪不通过、启动失败）不在历史里——这一点必须如实转述，
 * 否则用户会困惑「我明明跑过」。
 *
 * @param host - CLI 组合根注入的检索宿主。
 * @returns 可直接配置到 AgentTool[] 的 read_run_history 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createReadRunHistoryTool(
  host: ISkillCatalogHost,
): AgentTool<typeof singleSkillIdParameters, ReadRunHistoryDetails> {
  return {
    name: 'read_run_history',
    label: '读取执行历史',
    description:
      '读取某个 e2e 测试用例最近的执行历史（默认 10 次）：每次的时间、通过 / 失败 / 中断 / 跳过数、耗时与报告编号。用户问「这个用例最近跑得怎么样」「上次跑成什么样」时用它。历史以持久化的测试报告为准——未生成报告的执行（就绪不通过、启动失败）不在其中，如实说明这一区别。**本工具只回数据，不发卡片**——用户要看历史卡时改用 render_view({viewKind:"run-history"})。',
    parameters: singleSkillIdParameters,
    executionMode: 'sequential',
    /**
     * 经宿主读取历史并格式化给模型。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId 必填）。
     * @param _signal - 取消信号；本工具不使用（宿主调用为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含执行历史的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute(_toolCallId, parameters, _signal, _onUpdate) {
      void _toolCallId
      void _signal
      void _onUpdate

      const skillId = parameters.skillId?.trim() ?? ''
      if (!SKILL_ID_PATTERN.test(skillId)) {
        return {
          content: [{ type: 'text', text: INVALID_ID_HINT }],
          details: { ok: false, skillId },
        }
      }

      const result = await host.readRunHistory(skillId)
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `${result.message}\n请先用 list_skills 确认目标是否存在，不要猜测 ID。`,
            },
          ],
          details: { ok: false, skillId },
        }
      }

      const history = result.history
      if (history.neverExecuted) {
        return {
          content: [
            {
              type: 'text',
              text: `用例「${history.skillTitle}」还没有执行过（没有任何测试报告）。可以询问用户是否现在跑一次。`,
            },
          ],
          details: { ok: true, skillId, count: 0, neverExecuted: true },
        }
      }

      const lines = history.runs.map((run) => {
        const counts = [
          `通过 ${run.passed}`,
          run.failed > 0 ? `失败 ${run.failed}` : '',
          run.interrupted > 0 ? `中断 ${run.interrupted}` : '',
          run.skipped > 0 ? `跳过 ${run.skipped}` : '',
        ]
          .filter((part) => part.length > 0)
          .join('、')
        return `- ${run.startedAt}｜${counts}｜共 ${run.total} 条｜耗时 ${Math.round(
          run.durationMs / 1000,
        )}s｜运行编号 ${run.runId}`
      })

      const lines2 = [
        `用例「${history.skillTitle}」最近 ${history.runs.length} 次带报告的执行：`,
        ...lines,
      ]
      if (history.truncatedAt > history.runs.length) {
        lines2.push(
          `（更早的 ${history.truncatedAt - history.runs.length} 次报告未列出，可在该用例的开发页查看。）`,
        )
      }
      lines2.push(
        '',
        '注意：未生成报告的执行（就绪不通过、启动失败）不在本历史中，但对话流里的执行卡片仍保留了那一次。',
      )

      return {
        content: [{ type: 'text', text: lines2.join('\n') }],
        details: { ok: true, skillId, count: history.runs.length },
      }
    },
  }
}

/**
 * 创建就绪体检工具（v17 R3）。
 *
 * 体检**不启动浏览器、不产生执行记录、不占用执行通道**——这是它与
 * `execute_test` 的全部区别，也是用户在「这个能跑吗」时的真实诉求。
 *
 * @param host - CLI 组合根注入的体检宿主。
 * @returns 可直接配置到 AgentTool[] 的 check_readiness 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createCheckReadinessTool(
  host: IReadinessHost,
): AgentTool<typeof singleSkillIdParameters, CheckReadinessDetails> {
  return {
    name: 'check_readiness',
    label: '执行前体检',
    description:
      '对指定用例做执行前就绪检查（不启动浏览器、不产生执行记录、不占用执行通道），逐项给出就绪检查的结果与未通过项的原因。用户问「这个能跑吗」「还缺什么」「检查一下」时用它。**本工具只回数据，不发卡片**——用户要看体检卡时改用 render_view({viewKind:"readiness"})。',
    parameters: singleSkillIdParameters,
    executionMode: 'sequential',
    /**
     * 经宿主体检并格式化给模型。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId 必填）。
     * @param _signal - 取消信号；本工具不使用（宿主调用为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含体检结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute(_toolCallId, parameters, _signal, _onUpdate) {
      void _toolCallId
      void _signal
      void _onUpdate

      const skillId = parameters.skillId?.trim() ?? ''
      if (!SKILL_ID_PATTERN.test(skillId)) {
        return {
          content: [{ type: 'text', text: INVALID_ID_HINT }],
          details: { ok: false, skillId },
        }
      }

      const result = await host.checkReadiness(skillId)
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `${result.message}\n请先用 list_skills 确认目标是否存在，不要猜测 ID。`,
            },
          ],
          details: { ok: false, skillId },
        }
      }

      const readiness = result.readiness
      const checks = readiness.checks.map(
        (check) =>
          `- ${check.ok ? '✓' : '✗'} ${check.label}${
            check.message ? `：${check.message}` : ''
          }`,
      )

      return {
        content: [
          {
            type: 'text',
            text: [
              `用例「${readiness.skillTitle}」的就绪体检结果：${
                readiness.ok
                  ? '全部通过，可以执行。'
                  : '存在未通过项，暂不能执行。'
              }`,
              ...checks,
              '',
              readiness.ok
                ? '用户若确认要跑，直接调用 execute_test（不要仅为展示再从头发起体检）。'
                : '请把未通过项如实告知用户，并给出对应的修复入口（环境变量补齐卡 / 变更提案 / 生成动作卡片），不要替用户改数据。',
            ].join('\n'),
          },
        ],
        details: { ok: true, skillId, ready: readiness.ok },
      }
    },
  }
}
