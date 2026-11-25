/**
 * 组合 E2E 编辑器、领域校验和模型状态，生成可直接渲染的保存/生成动作模型。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type {
  IE2ETestCase,
  IE2EValidationIssue,
} from '@fynn90-e2e_assistant/types'
import type { TE2ETestCaseEditorStatus } from './useE2ETestCase'
import {
  issuesToValidationSummaries,
  type IE2EValidationSummary,
} from '../validation/test-case-form-validator'

export interface IE2EActionReason {
  key: string
  message: string
  label?: string
  path?: string
  targetId?: string
}

export interface IE2EActionReadiness {
  enabled: boolean
  label: string
  reasons: IE2EActionReason[]
}

export interface IE2ETestCaseReadiness {
  save: ComputedRef<IE2EActionReadiness>
  generate: ComputedRef<IE2EActionReadiness & { requiresSave: boolean }>
  /** 生成 Playwright 脚本动作（v7）：仅在 SKILL.md 已基于当前用例时可用。 */
  generateScript: ComputedRef<IE2EActionReadiness>
}

/**
 * 派生保存和生成动作的标签、可用状态及用户可理解的阻塞原因。
 * @param options 编辑器、领域校验、模型配置、生成状态与 env 引用校验的只读输入。
 * @returns 响应式保存、SKILL.md 生成与 Playwright 脚本生成动作模型。
 * @throws 不抛出异常。
 */
export function useE2ETestCaseReadiness (options: {
  draft: Ref<IE2ETestCase | null>
  status: Ref<TE2ETestCaseEditorStatus>
  dirty: ComputedRef<boolean>
  saveIssues: ComputedRef<IE2EValidationIssue[]>
  generationIssues: ComputedRef<IE2EValidationIssue[]>
  /**
   * env 引用就绪问题（v10，PRD 6.3 / 7.3 J1–J3）。
   *
   * 仅注入 generate 与 generateScript 两个动作，**save 不注入**——
   * 保存用例不因引用失效被阻断（草稿允许未完成状态）。
   */
  envReferenceIssues: ComputedRef<IE2EValidationIssue[]>
  chatReady: ComputedRef<boolean>
  readOnly: ComputedRef<boolean>
  generationRunning: ComputedRef<boolean>
  skillDocumentExists: ComputedRef<boolean>
  /** SKILL.md 是否已基于当前用例（status 为 current）；决定脚本生成入口是否可用。 */
  skillDocumentCurrent: ComputedRef<boolean>
  /** Playwright 脚本生成是否正在运行；运行时禁用重复提交。 */
  scriptGenerationRunning: ComputedRef<boolean>
}): IE2ETestCaseReadiness {
  const save = computed<IE2EActionReadiness>(() => {
    const reasons = editorStateReasons(options.status.value)

    if (options.readOnly.value) {
      reasons.push({
        key: 'read-only',
        message: '当前 Skill 只读，无法保存用例。',
      })
    }

    if (options.generationRunning.value) {
      reasons.push({
        key: 'generation-running',
        message: '请先等待当前生成流程结束。',
      })
    }

    reasons.push(...validationReasons(options.saveIssues.value))

    if (!options.dirty.value && reasons.length === 0) {
      reasons.push({ key: 'clean', message: '当前用例没有未保存修改。' })
    }

    return {
      enabled: Boolean(options.draft.value) && reasons.length === 0,
      label: '保存用例',
      reasons,
    }
  })

  const generate = computed<IE2EActionReadiness & { requiresSave: boolean }>(
    () => {
      const requiresSave = options.dirty.value
      const reasons = editorStateReasons(options.status.value)

      if (options.readOnly.value) {
        reasons.push({
          key: 'read-only',
          message: '当前 Skill 只读，无法保存或生成 SKILL.md。',
        })
      }

      if (!options.chatReady.value) {
        reasons.push({
          key: 'model-unavailable',
          message:
            '模型配置尚未就绪。请先在配置页检查 API 地址、模型名称和凭证。',
        })
      }

      if (options.generationRunning.value) {
        reasons.push({
          key: 'generation-running',
          message: 'SKILL.md 正在生成，请等待当前流程结束。',
        })
      }

      reasons.push(...validationReasons(options.generationIssues.value))
      // v10：env 引用就绪问题仅参与生成动作，不参与保存（PRD 6.3）。
      reasons.push(...validationReasons(options.envReferenceIssues.value))

      // 仅当 SKILL.md **已基于当前用例**且用例没有新变更时，才视为“无需更新”；
      // 首次生成、以及已过期（stale / untracked）的文档都可以重新生成。
      //
      // 不能用 `!requiresSave`（仅看草稿是否 dirty）代替：用户点「保存用例」后
      // dirty 立即变 false，但 SKILL.md 可能正是被这次修改变成过期的——
      // 那样按钮会在用户最需要它的时候变灰（保存后无法再更新文档）。
      if (
        options.skillDocumentExists.value &&
        options.skillDocumentCurrent.value &&
        !requiresSave &&
        reasons.length === 0
      ) {
        reasons.push({
          key: 'skill-document-current',
          message: 'e2e_schema.json 没有变更，无需更新 Skill 文档。',
        })
      }

      return {
        enabled: Boolean(options.draft.value) && reasons.length === 0,
        label: generateLabel(requiresSave, options.skillDocumentExists.value),
        reasons,
        requiresSave,
      }
    },
  )

  /**
   * Playwright 脚本生成动作（v7，PRD 7.1 就绪条件）。
   *
   * 与 SKILL.md 生成的关键差异：本动作**必须先有基于当前用例的 SKILL.md**。
   * 因此它不提供「保存并生成」的合并语义——用户需先完成 SKILL.md 流程，
   * 这也正是把入口放在这里的原因：SKILL.md 已就绪时，用户不必重走一遍文档生成。
   */
  const generateScript = computed<IE2EActionReadiness>(() => {
    const reasons = editorStateReasons(options.status.value)

    if (options.readOnly.value) {
      reasons.push({
        key: 'read-only',
        message: '当前 Skill 只读，无法生成 Playwright 脚本。',
      })
    }

    if (!options.chatReady.value) {
      reasons.push({
        key: 'model-unavailable',
        message:
          '模型配置尚未就绪。请先在配置页检查 API 地址、模型名称和凭证。',
      })
    }

    if (!options.skillDocumentCurrent.value) {
      reasons.push({
        key: 'skill-document-missing',
        message:
          '请先生成并确认 SKILL.md，且确保它基于当前用例，再生成 Playwright 脚本。',
      })
    }

    if (options.dirty.value) {
      reasons.push({
        key: 'dirty',
        message: '请先保存最新的结构化用例，再生成 Playwright 脚本。',
      })
    }

    if (options.generationRunning.value) {
      reasons.push({
        key: 'generation-running',
        message: 'SKILL.md 正在生成，请等待当前流程结束。',
      })
    }

    if (options.scriptGenerationRunning.value) {
      reasons.push({
        key: 'script-generation-running',
        message: 'Playwright 脚本正在生成，请等待当前流程结束。',
      })
    }

    reasons.push(...validationReasons(options.generationIssues.value))
    // v10：env 引用就绪问题同样阻断脚本生成（J1–J3，与服务端入口一致）。
    reasons.push(...validationReasons(options.envReferenceIssues.value))

    return {
      enabled: Boolean(options.draft.value) && reasons.length === 0,
      label: '生成 Playwright 脚本',
      reasons,
    }
  })

  return { save, generate, generateScript }
}

/**
 * 派生生成动作的按钮文案：首次生成时为“生成”，已存在 SKILL.md 时改为“更新”。
 * @param requiresSave 是否需要先保存结构化用例。
 * @param exists 是否已创建过 SKILL.md 文档。
 * @returns 生成动作按钮文案。
 * @throws 不抛出异常。
 */
function generateLabel (requiresSave: boolean, exists: boolean): string {
  if (exists) {
    return requiresSave ? '保存并更新 Skill 文档' : '更新 Skill 文档'
  }
  return requiresSave ? '保存并生成 Skill 文档' : '生成 Skill 文档'
}

/**
 * 将编辑器生命周期状态转换为动作阻塞原因。
 * @param status 当前结构化编辑器状态。
 * @returns 当前状态对应的阻塞原因；就绪状态返回空数组。
 * @throws 不抛出异常。
 */
function editorStateReasons (
  status: TE2ETestCaseEditorStatus,
): IE2EActionReason[] {
  const statusMessages: Partial<Record<TE2ETestCaseEditorStatus, string>> = {
    idle: '用例尚未加载完成。',
    loading: '正在加载结构化用例，请稍候。',
    saving: '正在保存结构化用例，请稍候。',
    invalid: '当前 e2e_schema.json 无法由结构化编辑器读取。',
    conflicted: '磁盘文件已发生变化，请先处理版本冲突。',
    missing: '源文件已被删除，请先恢复文件或复制当前草稿。',
    error: '结构化用例当前处于错误状态，请重试或重新加载。',
  }
  const message = statusMessages[status]
  return message ? [{ key: `editor-${status}`, message }] : []
}

/**
 * 将领域问题转换为动作阻塞原因，并保留可聚焦字段目标。
 * @param issues 有序领域校验问题。
 * @returns 可供就绪面板展示和导航的阻塞原因。
 * @throws 不抛出异常。
 */
function validationReasons (issues: IE2EValidationIssue[]): IE2EActionReason[] {
  return issuesToValidationSummaries(issues).map(validationSummaryToReason)
}

/**
 * 将校验摘要转换为通用动作原因。
 * @param summary 含字段标签和 DOM 目标的校验摘要。
 * @returns 通用动作阻塞原因。
 * @throws 不抛出异常。
 */
function validationSummaryToReason (
  summary: IE2EValidationSummary,
): IE2EActionReason {
  return {
    key: summary.key,
    message: summary.message,
    label: summary.label,
    path: summary.path,
    targetId: summary.targetId,
  }
}
