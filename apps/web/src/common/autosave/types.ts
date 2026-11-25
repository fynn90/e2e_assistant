/**
 * 实时保存能力的公共契约：保存目标端口与对外状态。
 *
 * 本模块**不感知业务**——不知道 SKILL.md 是什么，只认「保存目标」。
 * 业务差异（写到哪、怎么校验、冲突码是什么）全部由各适配器吸收，
 * 使同一套编排逻辑可被产物卡片与文件树任意文本文件复用（依赖倒转）。
 */
import type { IFileSaveDiagnostic } from '@charlie_deng/e2e-assistant-types'

/** 保存目标返回结果。 */
export interface ISaveTargetResult {
  /** 写入后的文件版本（sha256 hex），用于下一次保存的乐观并发校验。 */
  version: string
  /** 校验诊断（edit 模式下用于提示，不阻断写入）。 */
  diagnostics: IFileSaveDiagnostic[]
}

/**
 * 保存目标：一次实时保存的写入端点。
 *
 * 调用方（`useAutoSave`）只负责编排时机（防抖 / 串行 / 重试 / flush），
 * 不关心目标文件、校验规则与冲突码。
 */
export interface ISaveTarget {
  /** 目标标识，用于诊断与去重（如 `SKILL.md`、`test.spec.ts`、`src/a.ts`）。 */
  readonly key: string
  /**
   * 写入内容。
   *
   * @param content - 待写入的完整正文（调用方保证已是最新）。
   * @param signal - 取消信号；组件卸载或关闭时中止在途请求。
   * @returns 保存结果：新版本与可选诊断。
   * @throws ApiClientError - 业务失败（含冲突码）时抛出，由编排层分流。
   */
  save (content: string, signal: AbortSignal): Promise<ISaveTargetResult>
}

/**
 * 实时保存的对外状态。
 *
 * `conflict`、`failed` 与 `blocked` 都不会回滚编辑器内容——本地输入永远保留在屏幕上。
 */
export type TAutoSaveState =
  /** 磁盘与本地一致。 */
  | 'saved'
  /** 本地有改动，防抖窗口内。 */
  | 'pending'
  /** 请求在途。 */
  | 'saving'
  /** 保存失败（本地内容保留）。 */
  | 'failed'
  /** 版本冲突（文件被外部修改）。 */
  | 'conflict'
  /** 校验阻断（内容非法，落盘被拒绝；v10 PRD 5.3）。 */
  | 'blocked'

/** 保存状态徽标文案表（PRD 7.4）。 */
export const AUTO_SAVE_STATE_LABELS: Record<TAutoSaveState, string> = {
  saved: '已保存',
  pending: '有未保存改动',
  saving: '保存中…',
  failed: '保存失败',
  conflict: '保存冲突',
  blocked: '保存被阻止',
}

/**
 * 判断失败是否为版本冲突。
 *
 * 冲突不做退避重试而交给用户决策：重试必然再次失败，
 * 只有用户「重新加载」或「覆盖保存」才能推进。
 *
 * @param error - 待判断的异常。
 * @returns 错误码为文件/来源冲突时返回 true。
 */
export function isConflictError (error: unknown): boolean {
  const code = extractErrorCode(error)
  return code === 'FILE_VERSION_CONFLICT' || code === 'SOURCE_HASH_CONFLICT'
}

/**
 * 判断失败是否为校验阻断（v10 PRD 5.3）。
 *
 * 与冲突同类：内容校验失败时重试必然再次失败，只有用户修改内容才能推进。
 * 编排层不感知「env.json」概念，只感知「校验阻断」这一类别；
 * 具体问题明细由保存目标适配器以异常载荷携带。
 *
 * @param error - 待判断的异常。
 * @returns 错误码为 ENV_FILE_INVALID 时返回 true。
 */
export function isBlockedError (error: unknown): boolean {
  return extractErrorCode(error) === 'ENV_FILE_INVALID'
}

/**
 * 提取 ApiClientError 风格的错误码。
 *
 * @param error - 待判断的异常。
 * @returns 错误码文本；不存在时返回 undefined。
 */
function extractErrorCode (error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? ((error as { code?: string }).code ?? undefined)
    : undefined
}
