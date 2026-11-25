/**
 * 工作台提案工具集（v17）：四类「用户确认后才生效」的动作的 Agent 侧入口。
 *
 * 四类提案（用例变更 / 环境变量补齐 / 报告清理 / 用例删除）在用户视角是四件事，
 * 在实现上却是同一个形状：「Agent 提议 → 落盘登记 → 用户在前端操作 → 平台应用 →
 * 卡片定格」。因此**一个状态机、一个 apply 落点**（`IProposalService`），
 * 本模块只是它的四个工具外壳（技术方案 §6.3）。
 *
 * ## 两条通道的区分（本模块最重要的一条）
 *
 * E 组（用户主动要求改用例）与 G5（Agent 分析页面后提出改用例）**共用同一个
 * `case-change` 提案通道，但断言层红线只对 G5 生效**（PRD G5c）：
 *   - `propose_case_change`：`origin: 'user'`——用户有权改自己的用例，红线不适用；
 *   - `propose_case_repair`：`origin: 'agent-analysis'`——**红线适用**，
 *     且必须携带 `evidence`（没证据不得提案）。
 *
 * `origin` **不由模型传**，而是由这两个**独立工具**的宿主在调用点写死（R15）——
 * 若模型能自己声明 `origin: 'user'`，红线就被绕开了。两个工具的存在本身就是
 * 给模型的强信号：「修复」与「用户要求的变更」是两回事。
 *
 * ## 值不经过模型（D7 / PRD V3）
 *
 * `propose_env_fill` 只传 key，**永不传值**——值由用户在卡片里填写后随 apply
 * 请求直达平台。这是结构性的：本模块的参数里根本没有放值的字段。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  ICaseChangeTargets,
  IEnvKeyOperation,
  TCaseChangeOrigin,
} from '@fynn90-e2e_assistant/types'

/** SKILL 唯一 ID 的形状：9 位 [a-z0-9]（与 skill-manager 的判定一致）。 */
const SKILL_ID_PATTERN = /^[a-z0-9]{9}$/

/** 非法 ID 的统一提示（可自修复：模型应先检索再重试）。 */
const INVALID_ID_HINT =
  'Skill ID 必须是九位小写字母或数字（如 abc123456）。请先用 list_skills 取得候选，再用候选的 ID 调用本工具。'

/**
 * 提案宿主端口：由 CLI 组合根注入。
 *
 * 实现方职责：校验目标存在性、按 `kind` 读取磁盘现状并算出人话对照（diff
 * **由服务端计算，不由模型生成**——这样「从什么改成什么」一定与磁盘一致）、
 * 发布 `workbench_proposal` 块并把结果归一化返回。
 */
export interface IProposalHost {
  /**
   * 创建一份提案（Agent 工具调用时）。**不执行任何写操作**。
   *
   * @param input - 提案种类、目标与按种类区分的载荷。
   * @returns 提案 ID；被拒绝时 message 说明原因。
   * @throws 不抛出异常——失败以 ok:false 归一，由工具转述给模型。
   */
  createProposal (input: {
    kind: 'case-change' | 'env-fill' | 'report-cleanup' | 'case-delete'
    skillId: string
    /** 提案来源（**由工具置位，模型无从传入**）。 */
    origin?: TCaseChangeOrigin
    /** case-change：模型给出的目标值（不是 diff）。 */
    caseChange?: ICaseChangeTargets
    /** env-fill：缺失的 key 与用途摘要（**只含 key，永不含值**）。 */
    envKeys?: Array<{ key: string; usage: string }>
    /** env-fill：key 级维护（新增 / 删除 key 名，不涉及值）。 */
    envKeyOps?: IEnvKeyOperation[]
    /** report-cleanup：待清理的 runId 列表。 */
    runIds?: string[]
  }): Promise<{ ok: true; message: string } | { ok: false; message: string }>
}

/** 四类提案工具共用的返回详情。 */
export interface ProposalToolDetails {
  ok: boolean
  skillId: string
}

/**
 * 用例变更的目标值参数 Schema（`propose_case_change` 用）。
 *
 * 步骤给**全量**而非增量：给全量则「漏步骤」的风险由卡片上显式列出的 `remove`
 * 项兜住（用户看得见）；给增量则要模型自己定位目标步骤，定位错时更隐蔽
 *（技术方案 §6.3 / R3）。
 */
const caseChangeTargetsSchema = Type.Object({
  title: Type.Optional(
    Type.String({ description: '目标标题。用户明确要求改标题时才传。' }),
  ),
  description: Type.Optional(
    Type.String({ description: '目标描述。用户明确要求改描述时才传。' }),
  ),
  baseUrl: Type.Optional(
    Type.String({
      description: '目标地址（完整 URL）。用户明确要求改地址时才传。',
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: '目标标签集合（全量，不是增量）。',
    }),
  ),
  preconditions: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ description: '前置条件稳定 ID。' }),
        description: Type.String({ description: '前置条件描述。' }),
      }),
      { description: '目标前置条件集合（全量）。' },
    ),
  ),
  steps: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({
          description: '步骤稳定 ID（改已有步骤时沿用原 ID）。',
        }),
        order: Type.Number({ description: '步骤顺序（从 1 连续递增）。' }),
        description: Type.String({ description: '步骤描述。' }),
        action: Type.String({ description: '操作动作。' }),
        expectedResult: Type.String({ description: '预期结果。' }),
        enabled: Type.Boolean({ description: '是否启用。' }),
      }),
      {
        description:
          '**完整的目标步骤数组**（不是增量）。改已有步骤前必须先 read_test_case 拿到现状，再把改完的完整数组传进来；漏掉的步骤会在提案卡上显示为「将删除」，用户看得到。',
      },
    ),
  ),
})

/** propose_case_change 工具参数。 */
const proposeCaseChangeParameters = Type.Object({
  skillId: Type.String({
    description: '目标用例的九位唯一 ID。先用 list_skills 取得候选。',
  }),
  targets: caseChangeTargetsSchema,
  summary: Type.Optional(
    Type.String({
      description: '一句话说明这次要改什么（给用户看，放在卡片标题下）。',
    }),
  ),
})

/** propose_case_repair 工具参数（G5：多一个必填的 evidence）。 */
const proposeCaseRepairParameters = Type.Object({
  skillId: Type.String({
    description: '目标用例的九位唯一 ID。先用 list_skills 取得候选。',
  }),
  targets: caseChangeTargetsSchema,
  evidence: Type.Object(
    {
      actual: Type.String({
        description: '页面实际情况（如「按钮文本为『保存』」）。必填。',
      }),
      expected: Type.String({
        description:
          '用例所写的内容（如「步骤 2 期望点击『提交』按钮」）。必填。',
      }),
      verifiedBy: Type.String({
        description:
          '**核对方式与位置**（如「browser_snapshot 于 http://…/login，ref=e12」）。必填。',
      }),
    },
    {
      description:
        '页面核对证据。**必须已通过浏览器核对过页面**才能填写——没核对就提案等于「按脚本失败反推用例错了」，那是猜测，不是把握（G5a）。',
    },
  ),
})

/** propose_env_fill 工具参数。 */
const proposeEnvFillParameters = Type.Object({
  skillId: Type.String({
    description: '目标用例的九位唯一 ID。先用 list_skills 取得候选。',
  }),
  envKeys: Type.Array(
    Type.Object({
      key: Type.String({ description: '缺失的环境变量 key（只写 key 名）。' }),
      usage: Type.String({
        description: '这个 key 用在哪里（用途摘要，给用户看）。',
      }),
    }),
    {
      description:
        '待补齐的 key 与用途。**永远不要在这里写值**——值由用户在卡片里填写，不经过你。',
    },
  ),
  keyOps: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String({ description: '环境变量 key 名。' }),
        op: Type.Union([Type.Literal('add'), Type.Literal('remove')], {
          description:
            'add 为新增一个无引用的 key，remove 为删除一个已无引用的 key。',
        }),
        usage: Type.Optional(
          Type.String({ description: '用途摘要（可选，给用户看）。' }),
        ),
      }),
      {
        description:
          'key 级维护（V6）：新增 / 删除键名，不涉及值。仅当用户明确要求维护键名时使用。',
      },
    ),
  ),
})

/** propose_report_cleanup 工具参数。 */
const proposeReportCleanupParameters = Type.Object({
  skillId: Type.String({
    description: '目标用例的九位唯一 ID。先用 list_skills 取得候选。',
  }),
  runIds: Type.Array(Type.String(), {
    description:
      '**指定要清理的运行编号**（yyyyMMdd-HHmmss）。先用 render_view({viewKind:"run-history"}) 或 read_run_history 看到有哪些，再按用户说的范围挑。用户没说范围时不要自己决定——先给建议范围让用户确认。',
  }),
})

/** propose_case_deletion 工具参数（D8：只接受单个 skillId）。 */
const proposeCaseDeletionParameters = Type.Object({
  skillId: Type.String({
    description:
      '要删除的用例的九位唯一 ID。**本工具一次只接受一个用例**——用户说「把没用的都删了」时，先 list_skills 列出候选让用户指定，再逐个提案（不提供批量入口）。',
  }),
})

/**
 * 创建「用例变更提案」工具（v17 E 组）。
 *
 * `origin: 'user'` 由宿主在调用点写死：用户主动要求改自己的用例，
 * **断言层红线不适用**（用户有权改）。
 *
 * @param host - CLI 组合根注入的提案宿主。
 * @returns 可直接配置到 AgentTool[] 的 propose_case_change 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createProposeCaseChangeTool (
  host: IProposalHost,
): AgentTool<typeof proposeCaseChangeParameters, ProposalToolDetails> {
  return {
    name: 'propose_case_change',
    label: '发起用例变更提案',
    description:
      '用户明确要求修改用例数据（标题 / 描述 / 目标地址 / 标签 / 前置条件 / 步骤的新增、修改、删除、启用停用、排序）时，用它发起一份变更提案。提案**不会立即写入**——用户在对话流的卡片上确认后平台才写。传的是**目标值**（改完是什么样），不是「改了什么」——平台自己读盘算对照，所以你不需要、也不要描述原值。**先 read_test_case 拿到现状再改成完整的目标值**（尤其是 steps：给完整数组，不是增量）。用户没说清改成什么就先问，不要猜。',
    parameters: proposeCaseChangeParameters,
    executionMode: 'sequential',
    /**
     * 组装载荷并交给宿主建提案。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId 与 targets 必填）。
     * @param _signal - 取消信号；本工具不使用（建提案为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含提案结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute (_toolCallId, parameters, _signal, _onUpdate) {
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

      const result = await host.createProposal({
        kind: 'case-change',
        skillId,
        // origin 由本工具的宿主在调用点写死，模型无从传入（R15）。
        origin: 'user',
        caseChange: toCaseChangeTargets(parameters.targets),
      })

      return proposalToolResult(result, skillId)
    },
  }
}

/**
 * 创建「用例修复提案」工具（v17 G5 组）。
 *
 * `origin: 'agent-analysis'` 由宿主写死——**断言层红线因此对这份提案生效**。
 * 这是「修复」与「用户要求的变更」的分界点，也是红线不可绕过的结构性保证。
 *
 * @param host - CLI 组合根注入的提案宿主。
 * @returns 可直接配置到 AgentTool[] 的 propose_case_repair 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createProposeCaseRepairTool (
  host: IProposalHost,
): AgentTool<typeof proposeCaseRepairParameters, ProposalToolDetails> {
  return {
    name: 'propose_case_repair',
    label: '发起用例修复提案',
    description:
      '当你在核对页面后确认「用例描述的操作方式与页面实际不符」（如按钮名不同、元素在弹框里）时，用它发起用例修复提案。**必须先通过浏览器核对页面**（browser_snapshot / browser_query），并把「页面实际是什么、用例写的是什么、怎么核对的」写进 evidence——没有证据，本工具会直接失败（不许「脚本失败就反推用例错了」）。\n\n**红线（会由平台强制）**：预期结果（expectedResult）与用例标题 / 描述里的预期行为**一律不得修改**；也不得通过删除或停用断言步骤来绕过失败。若核对发现「预期与实际不符」，那不是用例写错，**可能是被测系统的缺陷**——不要提案，改为如实报告并建议人工确认（给「查看报告」与「在开发页打开用例」入口）。\n\n**一次只改与失败相关的最小范围**，不要顺手优化其它步骤。',
    parameters: proposeCaseRepairParameters,
    executionMode: 'sequential',
    /**
     * 组装载荷（含证据）并交给宿主建提案。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId、targets、evidence 必填）。
     * @param _signal - 取消信号；本工具不使用（建提案为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含提案结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute (_toolCallId, parameters, _signal, _onUpdate) {
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

      // evidence 的三段都必须非空——工具侧先兜一道，宿主再兜一道
      //（G5a 的结构性强制：没有证据，工具调用直接失败）。
      const actual = parameters.evidence?.actual?.trim() ?? ''
      const expected = parameters.evidence?.expected?.trim() ?? ''
      const verifiedBy = parameters.evidence?.verifiedBy?.trim() ?? ''
      if (!actual || !expected || !verifiedBy) {
        return {
          content: [
            {
              type: 'text',
              text: '用例修复提案必须携带完整的页面核对证据（页面实际是什么 / 用例写的是什么 / 怎么核对的）。请先用浏览器核对页面（browser_snapshot / browser_query），补齐 evidence 后重试；**没有核对就不要提案**——按脚本失败反推用例写错是猜测，不是把握。',
            },
          ],
          details: { ok: false, skillId },
        }
      }

      const result = await host.createProposal({
        kind: 'case-change',
        skillId,
        // origin 由本工具写死为 agent-analysis：红线对这份提案生效。
        origin: 'agent-analysis',
        caseChange: {
          ...toCaseChangeTargets(parameters.targets),
          evidence: { actual, expected, verifiedBy },
        },
      })

      return proposalToolResult(result, skillId, true)
    },
  }
}

/**
 * 创建「环境变量补齐提案」工具（v17 V 组）。
 *
 * 值不经过模型：本工具的签名里根本没有放值的字段（D7 的结构性保证）。
 *
 * @param host - CLI 组合根注入的提案宿主。
 * @returns 可直接配置到 AgentTool[] 的 propose_env_fill 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createProposeEnvFillTool (
  host: IProposalHost,
): AgentTool<typeof proposeEnvFillParameters, ProposalToolDetails> {
  return {
    name: 'propose_env_fill',
    label: '发起环境变量补齐',
    description:
      '当用例引用的环境变量在 env.json 中缺失时，用它发起补齐提案：列出缺失的 key 与用途，**由用户在卡片里直接填写值**——值由用户直接交给平台，不会经过你，你也不要接收、不要复述、不要在任何地方写值。若用户只是在对话里说出敏感值，不要接收，改为引导他使用补齐卡。',
    parameters: proposeEnvFillParameters,
    executionMode: 'sequential',
    /**
     * 组装载荷并交给宿主建提案。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId 与 envKeys 必填）。
     * @param _signal - 取消信号；本工具不使用（建提案为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含提案结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute (_toolCallId, parameters, _signal, _onUpdate) {
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

      const envKeys = (parameters.envKeys ?? []).map((item) => ({
        key: item.key.trim(),
        usage: item.usage.trim(),
      }))
      const envKeyOps = (parameters.keyOps ?? []).map((item) => ({
        key: item.key.trim(),
        op: item.op,
        ...(item.usage ? { usage: item.usage } : {}),
      }))

      if (envKeys.length === 0 && envKeyOps.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '补齐提案至少要给出一个缺失的 key（或一次 key 级维护）。请先 read_test_case 取得该用例引用的 key 清单，再调用本工具。',
            },
          ],
          details: { ok: false, skillId },
        }
      }

      const result = await host.createProposal({
        kind: 'env-fill',
        skillId,
        ...(envKeys.length > 0 ? { envKeys } : {}),
        ...(envKeyOps.length > 0 ? { envKeyOps } : {}),
      })

      return proposalToolResult(result, skillId)
    },
  }
}

/**
 * 创建「报告清理提案」工具（v17 L1）。
 *
 * 卡片按钮不直接删除——服务端会把 `requiresModalConfirm` 置为 true，
 * 用户必须在二次弹框里再确认一次（L1a / D2）。
 *
 * @param host - CLI 组合根注入的提案宿主。
 * @returns 可直接配置到 AgentTool[] 的 propose_report_cleanup 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createProposeReportCleanupTool (
  host: IProposalHost,
): AgentTool<typeof proposeReportCleanupParameters, ProposalToolDetails> {
  return {
    name: 'propose_report_cleanup',
    label: '发起报告清理提案',
    description:
      '用户表达清理报告的意图时，用它发起清理提案。**必须明确指定要删哪些运行编号**——用户没说范围时（如「把报告清一下」）不要自己决定，先给出建议范围（如「8 月之前的 6 份」）让用户确认。提案不会立即删除：用户在卡片上点按钮后会再弹出二次确认框，弹框内确认后才真正删除。',
    parameters: proposeReportCleanupParameters,
    executionMode: 'sequential',
    /**
     * 组装载荷并交给宿主建提案。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId 与 runIds 必填）。
     * @param _signal - 取消信号；本工具不使用（建提案为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含提案结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute (_toolCallId, parameters, _signal, _onUpdate) {
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

      const runIds = (parameters.runIds ?? [])
        .map((runId) => runId.trim())
        .filter((runId) => runId.length > 0)

      if (runIds.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '清理提案必须给出要删除的运行编号。请先用 read_run_history（或 render_view 的历史卡）看到有哪些报告，再按用户说明的范围挑出目标。',
            },
          ],
          details: { ok: false, skillId },
        }
      }

      const result = await host.createProposal({
        kind: 'report-cleanup',
        skillId,
        runIds,
      })

      return proposalToolResult(result, skillId)
    },
  }
}

/**
 * 创建「用例删除提案」工具（v17 L2）。
 *
 * 签名层面只接受一个 `skillId`——**不给批量入口**（D8 / L2b）：
 * 用户说「把没用的都删了」时，模型必须先列出候选让用户指定，再逐个提案。
 *
 * @param host - CLI 组合根注入的提案宿主。
 * @returns 可直接配置到 AgentTool[] 的 propose_case_deletion 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createProposeCaseDeletionTool (
  host: IProposalHost,
): AgentTool<typeof proposeCaseDeletionParameters, ProposalToolDetails> {
  return {
    name: 'propose_case_deletion',
    label: '发起用例删除提案',
    description:
      '用户要求删除某个用例时，用它发起删除提案。**一次只能针对一个用例**——用户说「把没用的用例都删了」时，不要自行判断哪些「没用」，先 list_skills 列出候选让用户指定，再对指定的每个用例**逐个**发提案、逐个确认（没有「全部删除」入口）。提案不会立即删除：用户在卡片上点按钮后会再弹出二次确认框，弹框内确认后才执行。若该用例正在执行或有生成任务，删除会被拒绝并给出停止入口。',
    parameters: proposeCaseDeletionParameters,
    executionMode: 'sequential',
    /**
     * 组装载荷并交给宿主建提案。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId 必填）。
     * @param _signal - 取消信号；本工具不使用（建提案为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含提案结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute (_toolCallId, parameters, _signal, _onUpdate) {
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

      const result = await host.createProposal({
        kind: 'case-delete',
        skillId,
      })

      return proposalToolResult(result, skillId)
    },
  }
}

/**
 * 把工具参数收窄为目标值（剔掉 undefined，避免把空字段当成「改成空」）。
 *
 * @param targets - 已通过 schema 校验的工具参数。
 * @returns 用例变更的目标值。
 * @throws 不抛出异常。
 */
function toCaseChangeTargets (targets: {
  title?: string
  description?: string
  baseUrl?: string
  tags?: string[]
  preconditions?: Array<{ id: string; description: string }>
  steps?: Array<{
    id: string
    order: number
    description: string
    action: string
    expectedResult: string
    enabled: boolean
  }>
}): ICaseChangeTargets {
  return {
    ...(targets.title !== undefined ? { title: targets.title } : {}),
    ...(targets.description !== undefined
      ? { description: targets.description }
      : {}),
    ...(targets.baseUrl !== undefined ? { baseUrl: targets.baseUrl } : {}),
    ...(targets.tags !== undefined ? { tags: targets.tags } : {}),
    ...(targets.preconditions !== undefined
      ? { preconditions: targets.preconditions }
      : {}),
    ...(targets.steps !== undefined
      ? {
        steps: targets.steps.map((step) => ({
          ...step,
          testData: {},
        })),
      }
      : {}),
  }
}

/**
 * 把宿主的提案结果归一为工具结果。
 *
 * @param result - 宿主返回的提案结果。
 * @param skillId - 目标用例 ID（结构化详情用）。
 * @param repair - 是否为用例修复提案（决定失败文案的引导方向）。
 * @returns 工具结果（模型可见文本 + 结构化详情）。
 * @throws 不抛出异常。
 */
function proposalToolResult (
  result: { ok: true; message: string } | { ok: false; message: string },
  skillId: string,
  repair = false,
): {
  content: Array<{ type: 'text'; text: string }>
  details: ProposalToolDetails
} {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: result.message }],
      details: { ok: true, skillId },
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: repair
          ? `${result.message}\n\n若拒绝原因是断言层红线：**这不是死路**。请改为如实报告——把「用例预期什么、页面实际什么」告知用户，说明这可能**是被测系统的缺陷**，建议人工确认这是预期变更还是缺陷，并提供「查看报告」与「在开发页打开用例」入口。不要试图用别的工具绕过这条线。`
          : `${result.message}\n请如实告知用户，并调整做法后重试；不要编造一个已经出现的卡片。`,
      },
    ],
    details: { ok: false, skillId },
  }
}
