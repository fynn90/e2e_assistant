/**
 * 工作台检索用的类型别名与本地窄化（v17）。
 *
 * 单一职责：把「types 包导出的契约」与「CLI 侧实现用到的窄化类型」收在一处，
 * 避免 `skill-catalog.ts` / `skill-catalog-query.ts` / 视图宿主各自
 * `import type` 一遍同一批类型而逐渐漂移（一处改名要改三处）。
 */

export type {
  IE2ETestCase,
  IRunHistoryViewPayload,
  IReadinessViewPayload,
  ISkillDetailViewPayload,
  ISkillListViewPayload,
  IWorkbenchSkillRow,
} from '@charlie_deng/e2e-assistant-types'

/** 清单筛选的四种状态（与 `ISkillListViewPayload.filter.status` 同源）。 */
export type TSkillListStatusFilterLike =
  'missing-document' | 'missing-script' | 'never-executed' | 'last-failed'
