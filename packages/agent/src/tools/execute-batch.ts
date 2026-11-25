/**
 * execute_batch 工具（v17 R4）：让 /agent 中的 Agent 发起一次**连续执行**。
 *
 * ## 边界：这不是平台级批量执行（PRD §2.2 第 1 条）
 *
 * 连续执行是**会话内的编排**：每个条目都走标准单次执行（同一套 J1–J8、快照、
 * 报告与互斥判定），不新增任务种类、不产生批次报告、不新增批次互斥维度。
 * 由一张卡片承载进度与汇总（`workbench_task` 的 `batch` 分支）。
 *
 * ## 待确认 → 执行中 → 已完成
 *
 * 本工具**不启动任何执行**，只创建一批「待确认」的条目清单（含逐条就绪预判）；
 * 用户在前端确认后才开始。停止语义（停止 = 终止整个批次，剩余标「未执行」）
 * 必须在待确认态的卡片文案里写明——服务端负责渲染该文案，本工具只负责把
 * 用户明确列出的用例交给平台。
 *
 * 上限由服务端判定（`BATCH_MAX_ITEMS = 10`）：超限时 `ok: false` 并说明上限，
 * **不截断**——悄悄只跑前 10 个是最坏的一种失败（用户以为全跑了）。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** SKILL 唯一 ID 的形状：9 位 [a-z0-9]（与 skill-manager 的判定一致）。 */
const SKILL_ID_PATTERN = /^[a-z0-9]{9}$/

/**
 * 连续执行宿主端口：由 CLI 组合根注入。
 *
 * 实现方职责：校验条目（ID 格式、存在性、数量上限）、逐条做**只读**就绪预判、
 * 发布 `workbench_task`（batch，`awaiting-confirmation`）块。
 */
export interface IBatchRunnerHost {
  /**
   * 创建一批连续执行（待确认态）。**不启动任何执行**。
   *
   * @param options - 目标用例 ID 清单（顺序即执行顺序）。
   * @returns 批次 ID；超上限或目标不合法时返回失败并说明原因。
   * @throws 不抛出异常——失败以 ok:false 归一，由工具转述给模型。
   */
  startBatch(options: {
    skillIds: string[]
  }): Promise<
    | { ok: true; batchId: string; message: string }
    | { ok: false; message: string }
  >
}

/** execute_batch 工具接受的参数 Schema。 */
const executeBatchParameters = Type.Object({
  skillIds: Type.Array(Type.String(), {
    description:
      '要**按顺序串行执行**的用例 ID 数组（九位 [a-z0-9]）。必须是用户明确指出的那些用例——用户按条件说的（如「最近失败的那几个」）也要你先检索出具体清单；不要自行扩大范围。',
  }),
})

/** execute_batch 工具返回的结构化详情。 */
export interface ExecuteBatchDetails {
  ok: boolean
  batchId?: string
}

/**
 * 创建发起连续执行的工具。
 *
 * @param host - CLI 组合根注入的批次宿主。
 * @returns 可直接配置到 AgentTool[] 的 execute_batch 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createExecuteBatchTool(
  host: IBatchRunnerHost,
): AgentTool<typeof executeBatchParameters, ExecuteBatchDetails> {
  return {
    name: 'execute_batch',
    label: '连续执行多个用例',
    description:
      '用户一次要求跑多个用例（明确列举，或按条件筛选如「把最近失败的那几个都跑一遍」）时用它发起**连续执行**：平台会先给出一张「待确认」卡片（列出用例与逐条就绪状态），用户确认后才按顺序**串行**执行，每个条目都是一次标准单次执行。单批上限 10 个——超过时平台会拒绝并要求缩小范围，**不会自行截断**，你要如实转述。未就绪的条目会被跳过（不阻断其余），单个条目失败也不中断批次。不要用它代替 execute_test 跑单个用例。',
    parameters: executeBatchParameters,
    executionMode: 'sequential',
    /**
     * 校验 ID 形态后交给宿主创建批次。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（skillIds 必填）。
     * @param _signal - 取消信号；本工具不使用（创建批次为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含批次创建结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute(_toolCallId, parameters, _signal, _onUpdate) {
      void _toolCallId
      void _signal
      void _onUpdate

      const skillIds = (parameters.skillIds ?? [])
        .map((skillId) => skillId.trim())
        .filter((skillId) => skillId.length > 0)

      if (skillIds.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '连续执行至少要给出一个用例 ID。请先用 list_skills 检索出具体清单，再调用本工具；用户按条件说的（如「最近失败的」）也要先落成具体清单。',
            },
          ],
          details: { ok: false },
        }
      }

      // 形态先于宿主：非法 ID 不值得打一次磁盘，且提示要能自修复。
      const invalid = skillIds.find(
        (skillId) => !SKILL_ID_PATTERN.test(skillId),
      )
      if (invalid) {
        return {
          content: [
            {
              type: 'text',
              text: `「${invalid}」不是合法的用例 ID（应为九位小写字母或数字）。请先用 list_skills 取得候选，再用候选 ID 的数组重试；不要传标题、目录名或路径。`,
            },
          ],
          details: { ok: false },
        }
      }

      const result = await host.startBatch({ skillIds })

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `${result.message}\n请如实告知用户，并调整做法后重试；不要编造一个已经出现的批次卡片，也不要自行截断清单。`,
            },
          ],
          details: { ok: false },
        }
      }

      return {
        content: [{ type: 'text', text: result.message }],
        details: { ok: true, batchId: result.batchId },
      }
    },
  }
}
