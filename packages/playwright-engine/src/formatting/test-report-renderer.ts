/**
 * 测试报告渲染器（v11，技术方案 §3.6 / PRD P6–P8）。
 *
 * 把 Playwright JSON 报告 + 平台元数据渲染为**自包含的单文件 HTML**：
 *   - 内联 CSS、零脚本、零外部资源，离线可打开、可单独拷贝分享（P6）；
 *   - 失败截图读附件文件后 base64 内嵌（单图上限 2MB，超出降级为文件名占位，P8/R2）；
 *   - 平台主动写入的元数据不包含 env.json 的任何值（P11——由调用方保证入参纯净，
 *     本模块只做 HTML 转义，不引入任何动态值来源）；
 *   - 步骤展示名优先使用用例步骤描述（`stepTitles` 映射），未映射时显示 stepId 原名
 *     （与执行区块 X8 同源）。
 */

import { readFile, stat } from 'node:fs/promises'
import type { IExecutionTestCaseResult } from '@charlie_deng/e2e-assistant-types'
import type {
  IPlaywrightJsonReport,
  IPlaywrightJsonStep,
  IPlaywrightJsonSuite,
} from '../runner'

/** 单张失败截图内嵌的字节上限（超出降级为文件名占位，防止报告体积失控）。 */
const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024

/** 测试报告的平台元数据（调用方组装，禁止携带 env 值，P11）。 */
export interface ITestReportMetadata {
  /** Skill 标题。 */
  skillTitle: string
  /** Skill ID。 */
  skillId: string
  /** 运行时间戳（yyyyMMdd-HHmmss）。 */
  runId: string
  /** 执行开始时间（ISO 字符串）。 */
  startedAt: string
  /** 目标 URL（baseURL）。 */
  baseUrl: string
  /** 是否有头模式（本期恒为 true，PRD X2）。 */
  headed: boolean
  /** 用例步骤 id → 描述映射（e2e_schema.json 提取；可选）。 */
  stepTitles?: Record<string, string>
}

/** 报告内单条测试的完整展示数据（结果 + 步骤 + 截图）。 */
export interface ITestReportEntry {
  result: IExecutionTestCaseResult
  /** 步骤列表（文档顺序，含嵌套层级）。 */
  steps: Array<{ stepId: string; ok: boolean; depth: number }>
  /** 失败截图（名称 + 运行工作区内来源路径；渲染时读取）。 */
  screenshots: Array<{ name: string; sourcePath?: string }>
}

/** 报告解析产物：摊平的测试条目与汇总统计。 */
export interface ITestReportData {
  /** 按文档顺序摊平的测试条目。 */
  entries: ITestReportEntry[]
  /** 汇总统计。 */
  stats: {
    total: number
    passed: number
    failed: number
    timedOut: number
    interrupted: number
    skipped: number
    durationMs: number
  }
}

/**
 * 解析 Playwright JSON 报告：摊平 suites → specs → tests → results 树。
 *
 * @param report - 已解析的 JSON 报告（允许为空对象：运行被硬终止时报告可能缺失）。
 * @returns 测试条目与统计（不含截图内容；截图由渲染时按需读取）。
 * @throws 不抛出异常。
 */
export function parseTestReportData (
  report: IPlaywrightJsonReport,
): ITestReportData {
  const entries: ITestReportEntry[] = []
  const stats: ITestReportData['stats'] = {
    total: 0,
    passed: 0,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
    skipped: 0,
    durationMs: Math.round(report.stats?.duration ?? 0),
  }

  const walkSuites = (suites: IPlaywrightJsonSuite[] | undefined): void => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        const testCase = spec.tests?.[spec.tests.length - 1]
        const lastResult = testCase?.results?.[testCase.results.length - 1]

        if (!testCase && !lastResult) continue

        const status = normalizeStatus(lastResult?.status ?? testCase?.status)
        const durationMs = Math.round(lastResult?.duration ?? 0)
        const errorMessage = lastResult?.error?.message?.trim() || undefined
        const failedStepId =
          status === 'failed' || status === 'timedOut'
            ? findFailedStepId(lastResult?.steps)
            : undefined

        stats.total += 1
        if (status === 'passed') stats.passed += 1
        else if (status === 'timedOut') stats.timedOut += 1
        else if (status === 'interrupted') stats.interrupted += 1
        else if (status === 'skipped') stats.skipped += 1
        else stats.failed += 1

        entries.push({
          result: {
            title: spec.title ?? '(未命名测试)',
            status,
            durationMs,
            ...(errorMessage ? { errorMessage } : {}),
            ...(failedStepId ? { failedStepId } : {}),
          },
          steps: collectSteps(lastResult?.steps),
          screenshots: collectScreenshotNames(lastResult?.attachments),
        })
      }

      walkSuites(suite.suites)
    }
  }

  walkSuites(report.suites)
  return { entries, stats }
}

/**
 * 渲染自包含单文件 HTML 测试报告。
 *
 * @param report - 已解析的 JSON 报告。
 * @param metadata - 平台元数据（Skill 信息、baseUrl、有头模式与步骤名映射）。
 * @param options - 可选的截图内嵌上限。
 * @returns 完整 HTML 文本（UTF-8），由调用方写盘。
 * @throws 不抛出异常；截图读取失败按占位降级。
 */
export async function renderTestReportHtml (
  report: IPlaywrightJsonReport,
  metadata: ITestReportMetadata,
  options: { maxInlineAttachmentBytes?: number } = {},
): Promise<string> {
  const data = parseTestReportData(report)
  const maxBytes =
    options.maxInlineAttachmentBytes ?? DEFAULT_MAX_INLINE_ATTACHMENT_BYTES

  // 读取失败截图内容（仅失败/超时/中断条目带附件）。
  const screenshotBodies: Array<
    Array<{ name: string; base64: string | null }>
  > = []
  for (const entry of data.entries) {
    const bodies: Array<{ name: string; base64: string | null }> = []
    for (const screenshot of entry.screenshots) {
      bodies.push({
        name: screenshot.name,
        base64: await readScreenshotBase64(screenshot.sourcePath, maxBytes),
      })
    }
    screenshotBodies.push(bodies)
  }

  const stepTitle = (stepId: string): string =>
    metadata.stepTitles?.[stepId] ?? stepId

  const summaryCards = [
    { label: '总数', value: data.stats.total, tone: 'neutral' },
    { label: '通过', value: data.stats.passed, tone: 'pass' },
    {
      label: '失败',
      value: data.stats.failed + data.stats.timedOut,
      tone: data.stats.failed + data.stats.timedOut > 0 ? 'fail' : 'neutral',
    },
    {
      label: '中断',
      value: data.stats.interrupted,
      tone: data.stats.interrupted > 0 ? 'warn' : 'neutral',
    },
    { label: '跳过', value: data.stats.skipped, tone: 'neutral' },
  ]

  const entriesHtml = data.entries
    .map((entry, index) =>
      renderEntry(entry, screenshotBodies[index] ?? [], stepTitle),
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>测试报告 · ${escapeHtml(metadata.skillTitle)} · ${escapeHtml(metadata.runId)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #f5f6f8; color: #1f2329;
    font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif; font-size: 14px; line-height: 1.6; }
  .wrap { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
  .card { background: #fff; border: 1px solid #e4e7ed; border-radius: 10px; padding: 18px 20px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 12px; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 24px; margin-top: 12px; font-size: 13px; }
  .meta-grid b { font-weight: 600; color: #374151; }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
  .stat { min-width: 72px; padding: 8px 14px; border-radius: 8px; background: #f3f4f6; text-align: center; }
  .stat .n { font-size: 20px; font-weight: 700; }
  .stat .t { font-size: 12px; color: #6b7280; }
  .stat.pass .n { color: #15803d; } .stat.fail .n { color: #b91c1c; } .stat.warn .n { color: #b45309; }
  .test { border: 1px solid #e4e7ed; border-radius: 8px; margin-top: 10px; background: #fff; }
  .test-head { padding: 12px 16px; display: flex; align-items: center; gap: 10px; }
  .test.failed .test-head { background: #fef6f6; border-radius: 8px 8px 0 0; }
  .badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.passed { background: #dcfce7; color: #15803d; }
  .badge.failed, .badge.timedOut { background: #fee2e2; color: #b91c1c; }
  .badge.interrupted { background: #fef3c7; color: #b45309; }
  .badge.skipped { background: #e5e7eb; color: #4b5563; }
  .test-body { padding: 0 16px 14px; border-top: 1px solid #f0f1f3; }
  .err { background: #fef2f2; border: 1px solid #fecaca; color: #7f1d1d; border-radius: 8px; padding: 10px 12px;
    white-space: pre-wrap; word-break: break-all; font-size: 13px; }
  .steps { margin: 10px 0 0; padding: 0; list-style: none; }
  .steps li { padding: 3px 0; font-size: 13px; }
  .steps .ok { color: #15803d; } .steps .bad { color: #b91c1c; font-weight: 600; }
  .steps .sid { color: #9ca3af; font-size: 12px; margin-left: 6px; }
  /* 截图卡片：标题栏在上（角色 + 文件名）、图片在下；多张纵向堆叠，便于逐张分辨。 */
  .shot { margin-top: 12px; }
  .shot-stack { display: flex; flex-direction: column; gap: 12px; }
  .shot-card { margin: 0; border: 1px solid #e4e7ed; border-radius: 8px; overflow: hidden; background: #fff; }
  .shot-card-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px;
    padding: 7px 12px; font-size: 12px; }
  .shot-card-label { font-weight: 600; white-space: nowrap; }
  .shot-card-name { color: #6b7280; word-break: break-all; }
  .shot-card-body { padding: 10px 12px; }
  .shot-card-body img { max-width: 100%; border: 1px solid #e4e7ed; border-radius: 6px; display: block; }
  .shot-card-body .missing { color: #9ca3af; font-size: 12px; }
  /* 角色配色：标题栏底色 + 同色系边框，让「哪张是基线」一眼可辨。 */
  .shot-card.diff { border-color: #fecaca; }
  .shot-card.diff .shot-card-head { background: #fef2f2; color: #b91c1c; border-bottom: 1px solid #fecaca; }
  .shot-card.diff .shot-card-name { color: #dc2626; }
  .shot-card.expected { border-color: #bfdbfe; }
  .shot-card.expected .shot-card-head { background: #eff6ff; color: #1d4ed8; border-bottom: 1px solid #bfdbfe; }
  .shot-card.actual { border-color: #fde68a; }
  .shot-card.actual .shot-card-head { background: #fffbeb; color: #b45309; border-bottom: 1px solid #fde68a; }
  .shot-card.screenshot .shot-card-head { background: #f9fafb; color: #4b5563; border-bottom: 1px solid #e4e7ed; }
  .shot-card-body img.visual-diff { border: 2px solid #ef4444; }
  /* v12：视觉比对结果——差异热点图置顶，基线与实际依次对照。 */
  .visual-block { margin-top: 12px; padding: 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; }
  .visual-block .visual-title { font-weight: 600; color: #b91c1c; margin-bottom: 8px; }
  .visual-block .shot-card { border-color: rgba(239, 68, 68, 0.35); }
  .visual-note { color: #991b1b; font-size: 12px; margin-bottom: 8px; }
  .runtime-error { background: #fff7ed; border: 1px solid #fed7aa; color: #7c2d12; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="wrap">
  <section class="card">
    <h1>测试报告</h1>
    <div class="sub">由 Authine E2E Agent 平台在执行结束后自动生成（自包含单文件，可直接分享）。</div>
    <div class="meta-grid">
      <span><b>Skill：</b>${escapeHtml(metadata.skillTitle)}（${escapeHtml(metadata.skillId)}）</span>
      <span><b>运行编号：</b>${escapeHtml(metadata.runId)}</span>
      <span><b>开始时间：</b>${escapeHtml(metadata.startedAt)}</span>
      <span><b>总耗时：</b>${formatDuration(data.stats.durationMs)}</span>
      <span><b>执行模式：</b>${metadata.headed ? '有头（headed）' : '无头（headless）'}</span>
      <span><b>目标 URL：</b>${escapeHtml(metadata.baseUrl)}</span>
    </div>
    <div class="stats">
      ${summaryCards
      .map(
        (card) =>
          `<div class="stat ${card.tone}"><div class="n">${card.value}</div><div class="t">${card.label}</div></div>`,
      )
      .join('\n      ')}
    </div>
  </section>

  <section class="card">
    <h1 style="font-size:15px">测试明细</h1>
    ${data.entries.length === 0 ? '<div class="sub" style="margin-top:8px">本次运行没有产生任何测试结果（可能是执行被中断或浏览器启动失败）。</div>' : entriesHtml}
  </section>
</div>
</body>
</html>
`
}

/** 渲染单条测试区块：标题行 + 常显内容（步骤列表；失败时另有错误与截图）。 */
function renderEntry (
  entry: ITestReportEntry,
  screenshots: Array<{ name: string; base64: string | null }>,
  stepTitle: (stepId: string) => string,
): string {
  const { result } = entry
  const statusLabel: Record<string, string> = {
    passed: '通过',
    failed: '失败',
    timedOut: '超时',
    interrupted: '中断',
    skipped: '跳过',
  }

  const stepsHtml =
    entry.steps.length === 0
      ? ''
      : `<ul class="steps">${entry.steps
        .map(
          (step) =>
            `<li style="padding-left:${step.depth * 18}px"><span class="${step.ok ? 'ok' : 'bad'}">${step.ok ? '✓' : '✗'}</span> ${escapeHtml(stepTitle(step.stepId))}<span class="sid">${escapeHtml(step.stepId)}</span></li>`,
        )
        .join('')}</ul>`

  const errorHtml = result.errorMessage
    ? `<div class="err">${escapeHtml(result.errorMessage)}</div>`
    : ''

  const failedStepHtml = result.failedStepId
    ? `<p style="margin:10px 0 0;font-size:13px"><b>失败步骤：</b>${escapeHtml(stepTitle(result.failedStepId))}<span class="sid">${escapeHtml(result.failedStepId)}</span></p>`
    : ''

  const shotsHtml = renderScreenshots(screenshots)

  // 步骤列表始终展示（PRD P7 ④ 是报告最低集合）；失败诊断内容仅失败用例有。
  const bodyHtml =
    errorHtml || failedStepHtml || stepsHtml || shotsHtml
      ? `<div class="test-body">${errorHtml}${failedStepHtml}${stepsHtml}${shotsHtml}</div>`
      : ''

  return `<div class="test">
  <div class="test-head"><span class="badge ${result.status}">${statusLabel[result.status] ?? result.status}</span>
  <span>${escapeHtml(result.title)}</span>
  <span class="sub">${formatDuration(result.durationMs)}</span></div>
  ${bodyHtml}
</div>`
}

/** 图片在报告中的角色：决定标题栏文案与配色。 */
interface IShotCardInput {
  name: string
  base64: string | null
  /** 标题栏左侧的角色名，如「期望基线」。 */
  label: string
  /** 卡片配色类别（视觉附件沿用其语义，普通截图为 screenshot）。 */
  kind: TVisualAttachmentKind
}

/**
 * 渲染单张截图卡片：**标题栏在上、图片在下**。
 *
 * 标题栏是这张卡片唯一说明图片身份的地方——多张图堆叠时，
 * 「哪张是基线、哪张是本次截图」由标题栏的角色名与配色直接给出，
 * 不再依赖图片下方那行容易被忽略的小字。
 *
 * @param input - 截图内容与角色信息。
 * @returns 卡片 HTML；图片超出上限或读取失败时渲染占位文案。
 * @throws 不抛出异常。
 */
function renderShotCard (input: IShotCardInput): string {
  const name = escapeHtml(input.name)
  const alt = escapeHtml(`${input.label}：${input.name}`)

  const body = input.base64
    ? `<img${input.kind === 'diff' ? ' class="visual-diff"' : ''} alt="${alt}" src="data:image/png;base64,${input.base64}" />`
    : `<div class="missing">图片过大或读取失败，未内嵌（${name}）。</div>`

  return `<figure class="shot-card ${input.kind}">
  <figcaption class="shot-card-head"><span class="shot-card-label">${escapeHtml(input.label)}</span><span class="shot-card-name">${name}</span></figcaption>
  <div class="shot-card-body">${body}</div>
</figure>`
}

/**
 * 渲染用例的截图区（v12：视觉比对附件按语义分组展示）。
 *
 * 视觉失败时，**差异热点图置顶**——它是用户判断「哪里变了」的首要依据；
 * 基线与实际依次纵向排列在其后作为对照。每张图都是独立卡片，
 * 标题栏给出角色名与文件名，因此**多张图时也能逐张分辨**。
 *
 * @param screenshots - 已读取的截图（base64 或 null 占位）。
 * @returns 截图区的 HTML；无截图时为空串。
 * @throws 不抛出异常。
 */
function renderScreenshots (
  screenshots: Array<{ name: string; base64: string | null }>,
): string {
  if (screenshots.length === 0) {
    return ''
  }

  const grouped: Record<
    TVisualAttachmentKind,
    Array<{ name: string; base64: string | null }>
  > = {
    diff: [],
    expected: [],
    actual: [],
    screenshot: [],
  }

  for (const shot of screenshots) {
    grouped[classifyVisualAttachment(shot.name)].push(shot)
  }

  const sections: string[] = []

  // 差异热点图：置顶，作为「哪里变了」的首要依据。
  if (grouped.diff.length > 0) {
    const cards = grouped.diff
      .map((shot) =>
        renderShotCard({ ...shot, label: '差异热点图', kind: 'diff' }),
      )
      .join('\n')
    sections.push(
      `<div class="visual-block"><div class="visual-title">视觉比对未通过</div><div class="visual-note">差异处已用红色标出；下方依次为期望基线与实际画面。</div>${cards}</div>`,
    )
  }

  // 基线 / 实际：逐张纵向排列，供用户定位具体差异。
  const compareCards = [
    ...grouped.expected.map((shot) => ({
      ...shot,
      label: '期望基线',
      kind: 'expected' as const,
    })),
    ...grouped.actual.map((shot) => ({
      ...shot,
      label: '实际画面',
      kind: 'actual' as const,
    })),
  ]

  if (compareCards.length > 0) {
    const cards = compareCards
      .map((shot) => renderShotCard({ ...shot, kind: shot.kind }))
      .join('\n')
    sections.push(`<div class="shot-stack">${cards}</div>`)
  }

  // 普通失败截图：同样成卡片，标题栏给出角色名以便区分。
  if (grouped.screenshot.length > 0) {
    const cards = grouped.screenshot
      .map((shot) =>
        renderShotCard({ ...shot, label: '失败截图', kind: 'screenshot' }),
      )
      .join('\n')
    sections.push(`<div class="shot-stack">${cards}</div>`)
  }

  return sections.join('')
}

// ---------------------------------------------------------------------------
// 解析辅助。
// ---------------------------------------------------------------------------

/** 归一 Playwright 状态为报告状态（未知状态按失败处理）。 */
function normalizeStatus (status: unknown): IExecutionTestCaseResult['status'] {
  switch (status) {
    case 'passed':
    case 'expected':
      return 'passed'
    case 'timedOut':
      return 'timedOut'
    case 'skipped':
      return 'skipped'
    case 'interrupted':
      return 'interrupted'
    default:
      return 'failed'
  }
}

/** 在步骤树中按文档顺序找第一个失败步骤的 stepId（即 test.step 标题）。 */
function findFailedStepId (
  steps: IPlaywrightJsonStep[] | undefined,
): string | undefined {
  for (const step of steps ?? []) {
    if (step.error) return step.title ?? undefined
    const nested = findFailedStepId(step.steps)
    if (nested) return nested
  }
  return undefined
}

/**
 * 收集业务步骤（文档顺序 + 嵌套深度）。
 *
 * 实证（playwright 1.62 JSON 报告）：步骤节点**不携带 category**，
 * 无法按 test.step 类别过滤；改为排除钩子（hook）后全部收集——
 * JSON 步骤树本身只包含业务步骤与断言，不含 pw:api 内部调用。
 */
function collectSteps (
  steps: IPlaywrightJsonStep[] | undefined,
  depth = 0,
): ITestReportEntry['steps'] {
  const collected: ITestReportEntry['steps'] = []

  for (const step of steps ?? []) {
    if (step.category === 'hook') {
      // 钩子（beforeEach 等）不是用例业务步骤：只下钻其内部步骤。
      collected.push(...collectSteps(step.steps, depth))
      continue
    }
    collected.push({ stepId: step.title ?? '', ok: !step.error, depth })
    collected.push(...collectSteps(step.steps, depth + 1))
  }

  return collected
}

/**
 * 视觉比对附件的语义分类（v12）。
 *
 * Playwright 的视觉断言失败时会自动产出三件套：`*-expected.png`（基线）、
 * `*-actual.png`（实际）、`*-diff.png`（**差异热点图**）。
 *
 * ⚠️ 附件名**带路径段前缀**（实测形如 `preview\candidate-a-diff.png`），
 * 因此必须按**后缀**匹配，不能用全名相等比较。
 */
export type TVisualAttachmentKind =
  'diff' | 'expected' | 'actual' | 'screenshot'

/**
 * 按附件名后缀判定视觉附件语义。
 *
 * @param name - 附件名（可能含路径段前缀）。
 * @returns 附件语义分类；非视觉附件返回 'screenshot'。
 * @throws 不抛出异常。
 */
export function classifyVisualAttachment (name: string): TVisualAttachmentKind {
  const lower = name.toLowerCase()
  if (lower.endsWith('-diff.png')) return 'diff'
  if (lower.endsWith('-expected.png')) return 'expected'
  if (lower.endsWith('-actual.png')) return 'actual'
  return 'screenshot'
}

/** 收集 PNG 失败截图的名称与来源路径。 */
function collectScreenshotNames (
  attachments:
    | Array<{
      name?: string
      contentType?: string
      path?: string
      body?: string
    }>
    | undefined,
): Array<{ name: string; sourcePath?: string }> {
  return (attachments ?? [])
    .filter((attachment) => attachment.contentType === 'image/png')
    .map((attachment) => ({
      name: attachment.name ?? 'failure-screenshot.png',
      ...(attachment.path ? { sourcePath: attachment.path } : {}),
    }))
}

/**
 * 读取截图并转为 base64；超出上限或读取失败返回 null（渲染为占位）。
 *
 * @param sourcePath - 截图文件路径（运行工作区内）。
 * @param maxBytes - 内嵌字节上限。
 * @returns base64 文本；无法内嵌时为 null。
 * @throws 不抛出异常。
 */
async function readScreenshotBase64 (
  sourcePath: string | undefined,
  maxBytes: number,
): Promise<string | null> {
  if (!sourcePath) return null

  try {
    const statResult = await stat(sourcePath)
    if (statResult.size > maxBytes) return null
    const content = await readFile(sourcePath)
    return content.toString('base64')
  } catch {
    return null
  }
}

/** 毫秒时长的可读格式。 */
function formatDuration (durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '-'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

/** HTML 实体转义（报告内容零脚本的关键防线）。 */
function escapeHtml (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
