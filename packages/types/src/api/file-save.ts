/**
 * 定义文件保存（即时保存 / 实时编辑）共用的校验诊断契约。
 *
 * 该契约被 SKILL.md 与 Playwright 脚本两类产物共享：服务端只产出诊断、
 * 不再因内容质量阻断写入；安全边界问题仍按 `isBlockingDiagnostic` 阻断。
 * 归一化为同一形状后，前端实时保存编排与错误条组件无需区分产物类型（单一职责）。
 */
import { z } from 'zod'

/**
 * 保存模式：
 *   - `generation`：生成完成首次落盘；
 *   - `edit`：用户实时编辑。
 *
 * v15 起两者的**校验语义已统一**（都只产出诊断、都不因内容质量阻断写入）。
 * 仍保留该字段是因为两者在**写入形态**上不同：`generation` 在无任何诊断时写入
 * 格式化后的代码，`edit` 一律写入用户原文——格式化会重排用户正在编辑的代码、
 * 移动光标，让每次防抖保存都覆盖输入。
 */
export const fileSaveModeSchema = z.enum(['generation', 'edit'])
export type TFileSaveMode = z.infer<typeof fileSaveModeSchema>

/** 诊断的展现级别。 */
export type TDiagnosticSeverity = 'error' | 'warning'

/**
 * 文件保存的校验诊断。
 *
 * v15 起**写入不再因内容质量被阻断**：诊断一律随保存响应回传，由界面提示用户。
 * 是否阻断写入由 `diagnostic-policy` 的 `isBlockingDiagnostic` 按诊断码的族别判定
 * （安全边界仍阻断），**不再由 `severity` 单独决定**——`severity` 只表达展现级别。
 */
export interface IFileSaveDiagnostic {
  /** 稳定的诊断码（如 `SKILL_DOCUMENT_SECTION_MISSING`、`FORBIDDEN_API`）。 */
  code: string
  /** 面向用户的说明，已脱敏。 */
  message: string
  /** 展现级别；是否阻断写入见 `isBlockingDiagnostic`。 */
  severity: TDiagnosticSeverity
  /** 关联网格位置（可选，用于编辑器内定位）。 */
  line?: number
}
