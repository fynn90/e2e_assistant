/**
 * 检索工具（v16）：让 /agent 中的 Agent 能以受控方式定位工作区内的 e2e SKILL。
 *
 * PRD ID-3 明确要求「不得让 Agent 通过遍历目录、拼接路径或猜测目录名来定位目标」
 * ——那既撑不住规模（每次定位要遍历整棵目录树、逐个读文档），也把路径构造
 * 与越界判断暴露给模型。因此本模块提供两个有边界的一次性调用：
 *   - `list_skills`：列出工作区内全部 e2e SKILL 及其产物完备性；
 *   - `read_skill_document`：读取指定 SKILL 的 SKILL.md 全文。
 *
 * 两者与 `execute_test` 同构：本包只定义端口（`ISkillCatalogHost`）并消费返回值，
 * 「什么是 e2e SKILL」「产物是否存在」这类知识属于 skill-manager 与平台，
 * 由 CLI 组合根注入的适配器回答（依赖倒转，agent 包不依赖 skill-manager）。
 *
 * 安全边界：两个工具都不接受路径参与——目标只能是 9 位唯一 ID，
 * 由宿主在自身边界内解析为目录（PRD ID-4 / SEC-2）。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  IAgentSkillCandidate,
  IReadinessViewPayload,
  IRunHistoryViewPayload,
  ISkillDetailViewPayload,
  IWorkbenchSkillRow,
} from '@authine-e2e-agent/types'

/** SKILL 唯一 ID 的形状：9 位 [a-z0-9]（与 skill-manager 的判定一致）。 */
const SKILL_ID_PATTERN = /^[a-z0-9]{9}$/

/** 清单筛选状态的四种取值（v17 Q3）。 */
export type TSkillListStatusFilter =
  'missing-document' | 'missing-script' | 'never-executed' | 'last-failed'

/** 用例详情读取结果（v17 Q4）。 */
export type TReadTestCaseHostResult =
  | { ok: true; detail: ISkillDetailViewPayload }
  | { ok: false; kind: TSkillCatalogHostErrorKind; message: string }

/** 执行历史读取结果（v17 Q7）。 */
export type TReadRunHistoryHostResult =
  | { ok: true; history: IRunHistoryViewPayload }
  | { ok: false; kind: TSkillCatalogHostErrorKind; message: string }

/** 宿主返回的错误类别：决定工具把哪一类说明交给模型。 */
export type TSkillCatalogHostErrorKind = 'not-found' | 'unavailable'

/** 读取 SKILL.md 的宿主结果。 */
export type TReadSkillDocumentHostResult =
  | { ok: true; content: string; hasPlaywrightScript: boolean }
  | { ok: false; kind: TSkillCatalogHostErrorKind; message: string }

/**
 * SKILL 检索宿主端口：由 CLI 组合根注入。
 *
 * 实现方职责：解析工作区、枚举 e2e SKILL、判定产物存在性、读取 SKILL.md，
 * 并对越界与不存在的目标返回归一化错误（不抛异常）。
 */
export interface ISkillCatalogHost {
  /**
   * 列出工作区内全部 e2e SKILL（含产物完备性）。
   *
   * @returns 候选列表；工作区内无 SKILL 时为空数组。
   * @throws 实现方可抛出结构化错误，由工具作为失败结果返回给模型。
   */
  listSkills(): Promise<IAgentSkillCandidate[]>

  /**
   * 带筛选的用例盘点（v17 Q1/Q3）。
   *
   * 筛选在**服务端**做而不是交给模型：① 命中数量要准确（Q3 要求说明「筛出几个」）；
   * ② 工作区规模上限无保证，模型端过滤撑不住规模；③ 同一份判定要同时供卡片与
   * 工具文本使用，两处各算一次必然分叉。
   *
   * @param filter - 关键词 / 标签 / 状态筛选；三者可同时生效（取交集）。
   * @returns 命中行与总数（`total` 为筛选后的命中数）。
   * @throws 实现方可抛出结构化错误，由工具作为失败结果返回给模型。
   */
  listFiltered(filter: {
    keyword?: string
    tag?: string
    status?: TSkillListStatusFilter
  }): Promise<{ rows: IWorkbenchSkillRow[]; total: number }>

  /**
   * 读取指定 SKILL 的 SKILL.md 全文。
   *
   * @param skillId - SKILL 唯一 ID（9 位 [a-z0-9]）。
   * @returns SKILL.md 内容与脚本存在性；目标不存在/不可读时返回归一化失败。
   * @throws 实现方可抛出结构化错误，由工具作为失败结果返回给模型。
   */
  readSkillDocument(skillId: string): Promise<TReadSkillDocumentHostResult>

  /**
   * 读取用例详情（v17 Q4）：结构化用例 + env key 清单 + 产物完备性。
   *
   * @param skillId - SKILL 唯一 ID。
   * @returns 详情；目标不存在或数据不可读时返回归一化失败。
   * @throws 实现方可抛出结构化错误，由工具作为失败结果返回给模型。
   */
  readTestCase(skillId: string): Promise<TReadTestCaseHostResult>

  /**
   * 读取执行历史（v17 Q7）：以**持久化报告**为准，最近 N 次。
   *
   * @param skillId - SKILL 唯一 ID。
   * @param limit - 返回的最近次数上限（缺省 10）。
   * @returns 历史；目标不存在时返回归一化失败。
   * @throws 实现方可抛出结构化错误，由工具作为失败结果返回给模型。
   */
  readRunHistory(
    skillId: string,
    limit?: number,
  ): Promise<TReadRunHistoryHostResult>
}

/**
 * 就绪体检宿主端口（v17 R3）：由 CLI 组合根注入。
 *
 * 与执行宿主分开的原因：体检**不启动浏览器、不产生执行记录、不占用执行通道**，
 * 它只是复用 J1–J8 的**只读判定**。合成一个端口会让「体检」有机会被误接成
 * 「跑一遍」——分开后在类型层面就不可能。
 */
export interface IReadinessHost {
  /**
   * 对指定用例做执行前就绪体检（不启动运行）。
   *
   * @param skillId - SKILL 唯一 ID。
   * @returns 逐项检查结果；目标不存在时返回归一化失败。
   * @throws 不抛出异常——失败以 ok:false 归一，由工具转述给模型。
   */
  checkReadiness(
    skillId: string,
  ): Promise<
    | { ok: true; readiness: IReadinessViewPayload }
    | { ok: false; message: string }
  >
}

/** list_skills 工具返回的结构化详情。 */
export interface ListSkillsDetails {
  /** 候选数量。 */
  count: number
  /** 候选列表（供模型读取结构化字段）。 */
  candidates: IAgentSkillCandidate[]
}

/** read_skill_document 工具返回的结构化详情。 */
export interface ReadSkillDocumentDetails {
  ok: boolean
  skillId: string
  /** 是否已有 test.spec.ts（决定下一步是执行还是生成脚本）。 */
  hasPlaywrightScript?: boolean
}

/** list_skills 工具接受的参数 Schema（v17 Q3 起支持筛选）。 */
const listSkillsParameters = Type.Object({
  keyword: Type.Optional(
    Type.String({
      description:
        '关键词筛选（匹配标题 / 描述 / 步骤内容）。用户明确说了关键词时才传，不要自己编一个。',
    }),
  ),
  tag: Type.Optional(
    Type.String({ description: '标签筛选。用户明确说了标签时才传。' }),
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
          '状态筛选：缺文档 / 缺脚本 / 未执行过 / 最近失败。用户按状态提问时（如「哪些还没生成脚本」）传对应值。',
      },
    ),
  ),
})

/** read_skill_document 工具接受的参数 Schema。 */
const readSkillDocumentParameters = Type.Object({
  skillId: Type.String({
    description:
      '目标 Skill 的九位唯一 ID（[a-z0-9]）。先用 list_skills 获得候选，不要用标题或目录名代替。',
  }),
})

/**
 * 创建列出工作区 e2e SKILL 的工具。
 *
 * @param host - CLI 组合根注入的检索宿主。
 * @returns 可直接配置到 AgentTool[] 的 list_skills 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createListSkillsTool(
  host: ISkillCatalogHost,
): AgentTool<typeof listSkillsParameters, ListSkillsDetails> {
  return {
    name: 'list_skills',
    label: '列出工作区用例',
    description:
      '列出当前工作区内的 e2e 测试用例：每项给出唯一 ID、标题、描述、产物完备性、最近一次执行结果与时间。可用 keyword / tag / status 筛选（如「哪些还没生成脚本」用 status=missing-script）。当用户提到要执行、生成或查找某个测试用例时，先用本工具拿到候选，不要遍历目录或猜测路径。**本工具只把数据回给你做判断，不发卡片**——用户要看清单时改用 render_view({viewKind:"skill-list"})。',
    parameters: listSkillsParameters,
    executionMode: 'sequential',
    /**
     * 经宿主列出候选并格式化给模型。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（筛选条件均可选）。
     * @param _signal - 取消信号；本工具不使用（宿主调用为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含候选列表的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute(_toolCallId, parameters, _signal, _onUpdate) {
      void _toolCallId
      void _signal
      void _onUpdate

      const keyword = parameters.keyword?.trim()
      const tag = parameters.tag?.trim()
      const filter = {
        ...(keyword ? { keyword } : {}),
        ...(tag ? { tag } : {}),
        ...(parameters.status ? { status: parameters.status } : {}),
      }

      // 无筛选走原有的完整清单；有筛选时走服务端过滤（命中数与卡片同源）。
      const hasFilter =
        filter.keyword !== undefined ||
        filter.tag !== undefined ||
        filter.status !== undefined

      if (!hasFilter) {
        const candidates = await host.listSkills()

        if (candidates.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: '当前工作区内没有任何 e2e 测试用例。请如实告知用户，并询问是否需要创建一个。',
              },
            ],
            details: { count: 0, candidates: [] },
          }
        }

        const lines = candidates.map((candidate) => {
          const artifacts = [
            candidate.hasSkillDocument ? '已有 SKILL.md' : '缺 SKILL.md',
            candidate.hasPlaywrightScript ? '已有脚本' : '缺脚本',
          ].join('、')
          const baseUrl = candidate.baseUrl
            ? `｜目标地址 ${candidate.baseUrl}`
            : ''
          return `- ${candidate.id}｜${candidate.title}｜${candidate.description || '（无描述）'}｜${artifacts}${baseUrl}`
        })

        return {
          content: [
            {
              type: 'text',
              text: [
                `工作区内共有 ${candidates.length} 个 e2e 测试用例：`,
                ...lines,
                '',
                '请依据标题与描述判断用户指的是哪一个；多个都符合时必须先向用户确认，不要自行挑选。',
              ].join('\n'),
            },
          ],
          details: { count: candidates.length, candidates },
        }
      }

      const { rows, total } = await host.listFiltered(filter)

      if (total === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `按当前筛选条件没有命中任何用例（筛选：${describeFilter(filter)}）。请如实告知用户，并提示可以放宽条件。`,
            },
          ],
          details: { count: 0, candidates: [] },
        }
      }

      const lines = rows.map((row) => {
        const artifacts = [
          row.hasSkillDocument ? '已有 SKILL.md' : '缺 SKILL.md',
          row.hasPlaywrightScript ? '已有脚本' : '缺脚本',
        ].join('、')
        const latest = row.latestRun
          ? `｜最近执行 ${row.latestRun.at}（通过 ${row.latestRun.passed} / 失败 ${row.latestRun.failed}）`
          : '｜未执行过'
        return `- ${row.skillId}｜${row.title}｜${row.description || '（无描述）'}｜${artifacts}${row.baseUrl ? `｜目标地址 ${row.baseUrl}` : ''}${latest}`
      })

      return {
        content: [
          {
            type: 'text',
            text: [
              `按「${describeFilter(filter)}」筛出 ${total} 个用例：`,
              ...lines,
              '',
              '请依据标题与描述判断用户指的是哪一个；多个都符合时必须先向用户确认，不要自行挑选。',
            ].join('\n'),
          },
        ],
        details: {
          count: total,
          candidates: rows.map((row) => ({
            id: row.skillId,
            title: row.title,
            description: row.description,
            hasSkillDocument: row.hasSkillDocument,
            hasPlaywrightScript: row.hasPlaywrightScript,
            ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
          })),
        },
      }
    },
  }
}

/**
 * 把筛选条件渲染成人话（Q3 要求向用户说明「筛出几个、按什么筛的」）。
 *
 * @param filter - 生效的筛选条件。
 * @returns 中文描述，如「最近失败」「关键词『登录』」。
 * @throws 不抛出异常。
 */
function describeFilter(filter: {
  keyword?: string
  tag?: string
  status?: TSkillListStatusFilter
}): string {
  const parts: string[] = []
  if (filter.status) {
    parts.push(
      {
        'missing-document': '缺文档',
        'missing-script': '缺脚本',
        'never-executed': '未执行过',
        'last-failed': '最近失败',
      }[filter.status],
    )
  }
  if (filter.tag) parts.push(`标签『${filter.tag}』`)
  if (filter.keyword) parts.push(`关键词『${filter.keyword}』`)
  return parts.join(' + ') || '全部'
}

/**
 * 创建读取 SKILL.md 的工具。
 *
 * @param host - CLI 组合根注入的检索宿主。
 * @returns 可直接配置到 AgentTool[] 的 read_skill_document 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createReadSkillDocumentTool(
  host: ISkillCatalogHost,
): AgentTool<typeof readSkillDocumentParameters, ReadSkillDocumentDetails> {
  return {
    name: 'read_skill_document',
    label: '读取用例文档',
    description:
      '读取指定 e2e 测试用例（SKILL）的 SKILL.md 全文，并告知该用例是否已有 test.spec.ts。用于确认「用户说的到底是不是这一个用例」——判据是文档内容，不是标题或目录名。',
    parameters: readSkillDocumentParameters,
    executionMode: 'sequential',
    /**
     * 经宿主读取 SKILL.md 并返回全文。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillId 必填）。
     * @param _signal - 取消信号；本工具不使用（宿主调用为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含文档内容的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute(_toolCallId, parameters, _signal, _onUpdate) {
      void _toolCallId
      void _signal
      void _onUpdate

      const skillId = parameters.skillId?.trim() ?? ''

      // 格式先于宿主校验：非法 ID 不值得打一次磁盘，且提示要能自修复。
      if (!SKILL_ID_PATTERN.test(skillId)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Skill ID 必须是九位小写字母或数字（如 abc123456）。请先用 list_skills 取得候选，再用候选的 ID 调用本工具。',
            },
          ],
          details: { ok: false, skillId },
        }
      }

      const result = await host.readSkillDocument(skillId)

      if (!result.ok) {
        const guidance =
          result.kind === 'not-found'
            ? '请先用 list_skills 确认目标是否存在，不要猜测 ID。'
            : '请如实告知用户该用例暂时无法读取，不要编造内容。'
        return {
          content: [{ type: 'text', text: `${result.message}\n${guidance}` }],
          details: { ok: false, skillId },
        }
      }

      const scriptLine = result.hasPlaywrightScript
        ? '该用例已有 test.spec.ts。'
        : '该用例还没有 test.spec.ts，如需执行请先引导用户生成脚本。'

      return {
        content: [
          {
            type: 'text',
            text: `以下是 Skill ${skillId} 的 SKILL.md 全文：\n\n${result.content}\n\n(${scriptLine})`,
          },
        ],
        details: {
          ok: true,
          skillId,
          hasPlaywrightScript: result.hasPlaywrightScript,
        },
      }
    },
  }
}
