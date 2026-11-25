/**
 * 只读视图卡载荷的窄化读取（v17 Q1–Q7 / R3 / H2）。
 *
 * 为什么单独成模块：事件契约把 `workbench_view.payload` 声明为
 * `Record<string, unknown>`（与既有 `IAgentWorkBlock.payload` 的约定一致，
 * 技术方案 §4.1），**窄化必须找一个唯一的落点**。若让五个子组件各自从
 * 裸对象里取字段，字段名写错、类型判断方式不一致都会成为静默故障
 * （渲染出 undefined 却不报错）。
 *
 * 本模块为纯函数、无 Vue 依赖，可独立单测；缺失或类型不符的字段一律
 * **降级为空值**（空数组 / undefined），使卡片渲染出「没有数据」而不是抛错
 * ——C9 要求「不得出现点了没反应」，读数是同一个道理。
 */
import type {
  ICapabilityViewPayload,
  IRunHistoryViewPayload,
  IReadinessViewPayload,
  ISkillDetailViewPayload,
  ISkillListViewPayload,
  IWorkbenchSkillRow,
  TWorkbenchSkillListStatus,
} from '@charlie_deng/e2e-assistant-types'

/** 读取为数组；非数组时给空数组。 */
function asArray<T> (value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** 读取为字符串；非字符串时给空串。 */
function asText (value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 读取为可选字符串；非字符串时给 undefined。 */
function asOptionalText (value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 读取为布尔；非布尔时给 false。 */
function asFlag (value: unknown): boolean {
  return value === true
}

/** 读取为数字；非数字时给 undefined。 */
function asOptionalNumber (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读取清单卡载荷（Q1–Q3）。
 *
 * @param payload - 视图事件或物化块的原始载荷。
 * @returns 归一化后的清单数据；字段缺失时降级为空清单。
 * @throws 不抛出异常。
 */
export function readSkillListPayload (
  payload: Record<string, unknown>,
): ISkillListViewPayload {
  const filter = payload.filter as Record<string, unknown> | undefined
  const overallTotal = asOptionalNumber(payload.overallTotal)
  const keyword = filter ? asOptionalText(filter.keyword) : undefined
  const tag = filter ? asOptionalText(filter.tag) : undefined
  const status = filter ? asOptionalText(filter.status) : undefined
  return {
    rows: asArray<IWorkbenchSkillRow>(payload.rows).map(normalizeSkillRow),
    total: asOptionalNumber(payload.total) ?? 0,
    ...(overallTotal !== undefined ? { overallTotal } : {}),
    ...(filter
      ? {
        filter: {
          ...(keyword ? { keyword } : {}),
          ...(tag ? { tag } : {}),
          ...(status ? { status: status as TWorkbenchSkillListStatus } : {}),
        },
      }
      : {}),
  }
}

/**
 * 归一化清单行：逐字段兜底，避免组件在模板里判空。
 *
 * @param row - 原始行对象。
 * @returns 字段完备的清单行。
 * @throws 不抛出异常。
 */
function normalizeSkillRow (row: IWorkbenchSkillRow): IWorkbenchSkillRow {
  const latestRun = row.latestRun
  const baseUrl = asOptionalText(row.baseUrl)
  const inlineActionId = asOptionalText(row.inlineActionId)
  return {
    skillId: asText(row.skillId),
    title: asText(row.title),
    description: asText(row.description),
    hasSkillDocument: asFlag(row.hasSkillDocument),
    hasPlaywrightScript: asFlag(row.hasPlaywrightScript),
    ...(baseUrl ? { baseUrl } : {}),
    ...(Array.isArray(row.tags) ? { tags: row.tags } : {}),
    ...(latestRun && typeof latestRun === 'object'
      ? {
        latestRun: {
          runId: asText(latestRun.runId),
          at: asText(latestRun.at),
          passed: asOptionalNumber(latestRun.passed) ?? 0,
          failed: asOptionalNumber(latestRun.failed) ?? 0,
          interrupted: asOptionalNumber(latestRun.interrupted) ?? 0,
          skipped: asOptionalNumber(latestRun.skipped) ?? 0,
          durationMs: asOptionalNumber(latestRun.durationMs) ?? 0,
        },
      }
      : {}),
    ...(inlineActionId ? { inlineActionId } : {}),
    ...(row.inlineAction ? { inlineAction: row.inlineAction } : {}),
  }
}

/**
 * 读取详情卡载荷（Q4/Q5）。
 *
 * @param payload - 视图事件或物化块的原始载荷。
 * @returns 归一化后的详情数据。
 * @throws 不抛出异常。
 */
export function readSkillDetailPayload (
  payload: Record<string, unknown>,
): ISkillDetailViewPayload {
  const baseUrl = asOptionalText(payload.baseUrl)
  const documentContent = asOptionalText(payload.documentContent)
  return {
    skillId: asText(payload.skillId),
    title: asText(payload.title),
    description: asText(payload.description),
    ...(baseUrl ? { baseUrl } : {}),
    ...(Array.isArray(payload.tags) ? { tags: payload.tags } : {}),
    preconditions: asArray<ISkillDetailViewPayload['preconditions'][number]>(
      payload.preconditions,
    ).map((item) => ({
      id: asText(item?.id),
      description: asText(item?.description),
    })),
    steps: asArray<ISkillDetailViewPayload['steps'][number]>(payload.steps).map(
      (step) => ({
        id: asText(step?.id),
        order: asOptionalNumber(step?.order) ?? 0,
        description: asText(step?.description),
        action: asText(step?.action),
        expectedResult: asText(step?.expectedResult),
        enabled: !(step?.enabled === false),
      }),
    ),
    hasSkillDocument: asFlag(payload.hasSkillDocument),
    hasPlaywrightScript: asFlag(payload.hasPlaywrightScript),
    envKeys: asArray<string>(payload.envKeys).filter(
      (key): key is string => typeof key === 'string',
    ),
    missingEnvKeys: asArray<string>(payload.missingEnvKeys).filter(
      (key): key is string => typeof key === 'string',
    ),
    ...(documentContent ? { documentContent } : {}),
  }
}

/**
 * 读取执行历史卡载荷（Q7）。
 *
 * @param payload - 视图事件或物化块的原始载荷。
 * @returns 归一化后的历史数据。
 * @throws 不抛出异常。
 */
export function readRunHistoryPayload (
  payload: Record<string, unknown>,
): IRunHistoryViewPayload {
  const runs = asArray<IRunHistoryViewPayload['runs'][number]>(
    payload.runs,
  ).map((run) => {
    const baseUrl = asOptionalText(run?.baseUrl)
    return {
      runId: asText(run?.runId),
      startedAt: asText(run?.startedAt),
      passed: asOptionalNumber(run?.passed) ?? 0,
      failed: asOptionalNumber(run?.failed) ?? 0,
      interrupted: asOptionalNumber(run?.interrupted) ?? 0,
      skipped: asOptionalNumber(run?.skipped) ?? 0,
      total: asOptionalNumber(run?.total) ?? 0,
      durationMs: asOptionalNumber(run?.durationMs) ?? 0,
      ...(baseUrl ? { baseUrl } : {}),
    }
  })
  return {
    skillId: asText(payload.skillId),
    skillTitle: asText(payload.skillTitle),
    runs,
    // 截断位缺失时按「未截断」处理：runs.length 不小于自身，提示不会显示。
    truncatedAt: asOptionalNumber(payload.truncatedAt) ?? runs.length,
    neverExecuted: asFlag(payload.neverExecuted) || runs.length === 0,
  }
}

/**
 * 读取体检卡载荷（R3）。
 *
 * @param payload - 视图事件或物化块的原始载荷。
 * @returns 归一化后的体检数据。
 * @throws 不抛出异常。
 */
export function readReadinessPayload (
  payload: Record<string, unknown>,
): IReadinessViewPayload {
  const checks = asArray<IReadinessViewPayload['checks'][number]>(
    payload.checks,
  ).map((check) => {
    const message = asOptionalText(check?.message)
    return {
      code: asText(check?.code),
      label: asText(check?.label),
      ok: asFlag(check?.ok),
      ...(message ? { message } : {}),
      // fixAction 是动作身份（渲染按钮的文案依据）；fixActionId 是宿主预先
      // 登记的动作记录 ID——**只有两者齐备才渲染按钮**（与清单卡行内按钮
      // 同一机制：登记与呈现解耦，没有 ID 就没有可点的入口）。
      ...(check?.fixAction ? { fixAction: check.fixAction } : {}),
      ...(check?.fixActionId ? { fixActionId: asText(check.fixActionId) } : {}),
    }
  })

  // 「全部通过」的执行入口同样由宿主登记后下发（R3 ③ 的闭环）。
  const executeActionId = asOptionalText(payload.executeActionId)

  return {
    skillId: asText(payload.skillId),
    skillTitle: asText(payload.skillTitle),
    ok: asFlag(payload.ok) || checks.every((check) => check.ok),
    checks,
    ...(executeActionId ? { executeActionId } : {}),
  }
}

/**
 * 读取能力卡载荷（H2/H3）。
 *
 * @param payload - 视图事件或物化块的原始载荷。
 * @returns 归一化后的能力清单。
 * @throws 不抛出异常。
 */
export function readCapabilityPayload (
  payload: Record<string, unknown>,
): ICapabilityViewPayload {
  return {
    domains: asArray<ICapabilityViewPayload['domains'][number]>(
      payload.domains,
    ).map((domain) => ({
      key: asText(domain?.key),
      label: asText(domain?.label),
      examples: asArray<string>(domain?.examples).filter(
        (item): item is string => typeof item === 'string',
      ),
    })),
    notSupported: asArray<ICapabilityViewPayload['notSupported'][number]>(
      payload.notSupported,
    ).map((item) => ({
      label: asText(item?.label),
      alternative: asText(item?.alternative),
    })),
  }
}

/** 清单筛选条件的展示文案（Q3：一句话说明筛选条件与命中数量）。 */
const SKILL_LIST_STATUS_LABELS: Record<TWorkbenchSkillListStatus, string> = {
  'missing-document': '缺文档',
  'missing-script': '缺脚本',
  'never-executed': '未执行过',
  'last-failed': '最近失败',
}

/**
 * 生成清单卡顶部的筛选说明（Q3）。
 *
 * @param filter - 当前生效的筛选条件。
 * @param total - 命中数量。
 * @returns 形如「按「最近失败」筛出 3 个用例」的说明；无筛选条件时返回空串。
 * @throws 不抛出异常。
 */
export function describeSkillListFilter (
  filter: ISkillListViewPayload['filter'],
  total: number,
): string {
  if (!filter) return ''
  const parts: string[] = []
  if (filter.keyword) parts.push(`关键词「${filter.keyword}」`)
  if (filter.tag) parts.push(`标签「${filter.tag}」`)
  if (filter.status) {
    parts.push(
      `状态「${SKILL_LIST_STATUS_LABELS[filter.status] ?? filter.status}」`,
    )
  }
  if (parts.length === 0) return ''
  return `按${parts.join(' + ')}筛出 ${total} 个用例`
}
