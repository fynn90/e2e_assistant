/**
 * 校验用户 Skill 的 SKILL.md frontmatter、正文结构、步骤覆盖率和明文凭据。
 *
 * 校验同时覆盖结构化用例与生成正文，防止 Agent 将真实凭据或不一致的目标地址写入文件。
 * （v10 起：用例侧的敏感数据拦截已移除，敏感数据的引导与引用机制见 env.json 体系；
 * 本文件保留的 `checkSensitiveContent` 是针对**产物正文**的明文凭据扫描（PRD v10 8.2 K1），
 * 作为防止真实凭据进入文档的最后防线。）
 *
 * v15 起对外只提供一个入口 {@link collectSkillDocumentDiagnostics}：**永不抛错**，
 * 收集全部诊断。是否阻断写入由调用方按 `isBlockingDiagnostic` 判定——本模块只负责
 * 回答「发现了什么问题」，不替调用方决定「要不要拦」。校验层因此不需要知道调用方
 * 是首次落盘还是实时编辑，规则天然同源。
 */
import {
  type IE2ETestCase,
  type IFileSaveDiagnostic,
  type TDiagnosticSeverity,
} from '@charlie_deng/e2e-assistant-types'
import {
  isTextCovered,
  normalizeForCoverage,
} from './skill-document-text-match'

/**
 * SKILL.md 检查专属的诊断码。
 *
 * 每条检查发自己的码，而不是共用一个 `SKILL_DOCUMENT_INVALID`——阻断判定按码的
 * 族别进行，复用同一个码会让安全族与质量族无法区分（见 `diagnostic-policy`）。
 * 码值属跨包契约：前端按它分组展示，测试按它断言。
 */
export type TSkillDocumentDiagnosticCode =
  | 'SKILL_DOCUMENT_EMPTY'
  | 'SKILL_DOCUMENT_FRONTMATTER_INVALID'
  | 'SKILL_DOCUMENT_SECTION_MISSING'
  | 'SKILL_DOCUMENT_BASE_URL_MISSING'
  | 'SKILL_DOCUMENT_STEP_COVERAGE_MISSING'
  /** 安全族：命中时仍阻断写入。 */
  | 'SKILL_DOCUMENT_SENSITIVE_CONTENT'

export interface ISkillDocumentValidationResult {
  /** 规范化后的正文（始终可用，即使存在 error 诊断）。 */
  content: string
  /** 全部诊断；调用方按 `isBlockingDiagnostic` 决定是否阻断。 */
  diagnostics: IFileSaveDiagnostic[]
  /** 正文中引用的环境变量名（排序去重）。 */
  environmentVariables: string[]
}

/**
 * 单条检查的结果：通过时返回 null，不通过时返回诊断。
 *
 * 拆成 `content => IFileSaveDiagnostic | null` 的纯函数后，
 * 严格入口与收集入口可以各自组装出不同语义的结果。
 */
type TSkillDocumentCheck = (context: {
  normalizedContent: string
  testCase: IE2ETestCase
}) => IFileSaveDiagnostic | null

/**
 * 校验模型生成或 Agent 写入的 SKILL.md 是否符合当前用例。
 *
 * 校验模型生成、Agent 写入或用户编辑的 SKILL.md，**收集全部诊断，永不抛错**。
 *
 * 是否阻断写入不在这里决定：调用方对返回的诊断调用 `isBlockingDiagnostic`，
 * 只有安全族（明文凭据）才会拦下写入，其余仅为提醒。
 *
 * @param content - 待校验的 Markdown 文本，允许是未写完的中间态。
 * @param testCase - 当前磁盘上的结构化 E2E 用例。
 * @returns 规范化正文、全部诊断与环境变量名；正文始终可用（即使存在 error 诊断）。
 * @throws 不抛出异常（空文档以一条诊断表达）。
 */
export function collectSkillDocumentDiagnostics (
  content: string,
  testCase: IE2ETestCase,
): ISkillDocumentValidationResult {
  const normalizedContent = normalizeContent(content)

  // 空文档无法继续做结构检查：直接返回单条诊断，避免产生一串派生噪音。
  if (!normalizedContent) {
    return {
      content: `${content}\n`,
      diagnostics: [
        {
          code: 'SKILL_DOCUMENT_EMPTY',
          message: 'SKILL.md 不能为空。',
          // 纯空白文档没有任何可用内容，属结构性缺失而非「可提醒的质量问题」，
          // 保持 error 让它在写入前被拦下（zod 的 min(1) 挡不住纯空白）。
          severity: 'error',
        },
      ],
      environmentVariables: [],
    }
  }

  return {
    content: normalizedContent,
    diagnostics: runChecks({ normalizedContent, testCase }),
    environmentVariables: collectEnvironmentVariables(normalizedContent),
  }
}

/**
 * 依次执行全部检查并收集诊断。
 *
 * @param context - 已规范化的正文与当前用例。
 * @returns 诊断列表（按检查顺序；未命中的检查不产出条目）。
 */
function runChecks (context: {
  normalizedContent: string
  testCase: IE2ETestCase
}): IFileSaveDiagnostic[] {
  return SKILL_DOCUMENT_CHECKS.map((check) => check(context)).filter(
    (diagnostic): diagnostic is IFileSaveDiagnostic => diagnostic !== null,
  )
}

/**
 * 构造一条诊断。
 *
 * v15 起**每条检查发自己的诊断码**，而不是共用一个 `SKILL_DOCUMENT_INVALID`：
 * 是否阻断写入由 `diagnostic-policy` 按码的族别判定，复用同一个码会让
 * 「明文凭据（安全族，必须阻断）」与「章节缺失（质量族，仅提醒）」无法区分。
 *
 * @param code - 本检查专属的诊断码。
 * @param message - 面向用户的说明。
 * @param severity - 展现级别；安全族发 `error`，质量族发 `warning`。
 * @returns 一条诊断。
 */
function invalid (
  code: TSkillDocumentDiagnosticCode,
  message: string,
  severity: TDiagnosticSeverity = 'warning',
): IFileSaveDiagnostic {
  return { code, message, severity }
}

/**
 * 全部检查规则，按「由外到内」的顺序排列：
 * frontmatter → 必需章节 → 目标地址 → 步骤覆盖 → 明文凭据扫描。
 */
const SKILL_DOCUMENT_CHECKS: readonly TSkillDocumentCheck[] = [
  checkFrontmatter,
  checkRequiredSections,
  checkBaseUrl,
  checkEnabledSteps,
  checkSensitiveContent,
]

/** 校验 frontmatter 存在，且 name / description 与用例标题、描述完全一致。 */
function checkFrontmatter (context: {
  normalizedContent: string
  testCase: IE2ETestCase
}): IFileSaveDiagnostic | null {
  const frontmatter = parseFrontmatter(context.normalizedContent)
  if (!frontmatter || !frontmatter.name || !frontmatter.description) {
    return invalid(
      'SKILL_DOCUMENT_FRONTMATTER_INVALID',
      frontmatter
        ? 'SKILL.md frontmatter 必须包含 name 和 description。'
        : 'SKILL.md 缺少合法 YAML frontmatter。',
    )
  }
  // 等值判定同样经 normalizeForCoverage 归一化：frontmatter 里的引号 / 破折号
  // 形态由模型排版产生，与用户在结构化编辑器中的输入常不逐字节相同，
  // 这类差异不改变语义，不应判定为「与用例不一致」。
  //
  // 注意：name / description 的**逐字符**等值并非下游契约——生成的 SKILL.md
  // 只作为自然语言文本被读取，其 frontmatter 从不参与功能判定（Web 端渲染时
  // 甚至主动剥离）。此处的归一化等值只为守住「文档确实对应当前用例」这一层，
  // 故不引入字符级差异容忍：短标题上的笔误更可能是语义错误而非排版噪声。
  if (
    normalizeForCoverage(frontmatter.name) !==
    normalizeForCoverage(context.testCase.title)
  ) {
    return invalid(
      'SKILL_DOCUMENT_FRONTMATTER_INVALID',
      'SKILL.md 的 name 必须与用例标题一致。',
    )
  }
  if (
    normalizeForCoverage(frontmatter.description) !==
    normalizeForCoverage(context.testCase.description)
  ) {
    return invalid(
      'SKILL_DOCUMENT_FRONTMATTER_INVALID',
      'SKILL.md 的 description 必须与用例描述一致。',
    )
  }
  return null
}

/** 校验必需章节齐全。 */
function checkRequiredSections (context: {
  normalizedContent: string
}): IFileSaveDiagnostic | null {
  for (const [heading, label] of REQUIRED_SECTIONS) {
    if (!context.normalizedContent.includes(heading)) {
      return invalid(
        'SKILL_DOCUMENT_SECTION_MISSING',
        `SKILL.md 缺少“${label}”章节。`,
      )
    }
  }
  return null
}

/** 校验正文覆盖用例目标 URL。 */
function checkBaseUrl (context: {
  normalizedContent: string
  testCase: IE2ETestCase
}): IFileSaveDiagnostic | null {
  return context.normalizedContent.includes(context.testCase.baseUrl.trim())
    ? null
    : invalid(
      'SKILL_DOCUMENT_BASE_URL_MISSING',
      'SKILL.md 未完整覆盖用例目标 URL。',
    )
}

/**
 * 校验启用步骤的数量、顺序、标题与内容覆盖。
 *
 * 内容覆盖交由 {@link isTextCovered} 判定，而不是整段精确子串匹配：
 * 多行 `action` / `expectedResult` 写进 Markdown 列表时，续行必须缩进才能保持列表结构，
 * 缩进量由文档结构决定、与用例字段的原始缩进无关；行尾空白也不可见。
 * 精确匹配会把这类纯格式差异误判为「未覆盖」，使含多行字段的用例无法生成（v12 修复）。
 * v15 起进一步吸收排版异形与个别字符笔误，避免模型转录长中文时的非语义差异
 * 导致生成任务被终止（判定边界见 skill-document-text-match）。
 */
function checkEnabledSteps (context: {
  normalizedContent: string
  testCase: IE2ETestCase
}): IFileSaveDiagnostic | null {
  const enabledSteps = context.testCase.steps.filter((step) => step.enabled)
  // 标题只在**代码块之外**提取：`action` / `expectedResult` 现以 ```text 代码块承载原文，
  // 其中形如 `1. **xxx**` 的枚举行与步骤标题同形，若一并计入会让后续标题比对错位，
  // 报出与真实原因无关的「顺序或标题不一致」。
  const stepHeadings =
    stripFencedCodeBlocks(context.normalizedContent).match(
      /^\d+\.\s+\*\*.+\*\*$/gm,
    ) ?? []

  if (stepHeadings.length < enabledSteps.length) {
    return invalid(
      'SKILL_DOCUMENT_STEP_COVERAGE_MISSING',
      'SKILL.md 未覆盖全部启用测试步骤。',
    )
  }

  const coverageContent = normalizeForCoverage(context.normalizedContent)

  for (const [index, step] of enabledSteps.entries()) {
    const expectedHeading = `${index + 1}. **${step.description.trim()}**`
    // 标题比对同样归一化：`description` 由模型转录到标题行时，引号 / 破折号形态
    // 与全半角混排常与用例原文不逐字节相同。这与本函数下方的正文覆盖判定是同一类
    // 非语义差异，早期只归一化了正文、标题仍走精确匹配，同一段文本会出现
    // 「正文判定已覆盖、标题判定不一致」的自相矛盾（v15 修复）。
    if (
      normalizeForCoverage(stepHeadings[index] ?? '') !==
      normalizeForCoverage(expectedHeading)
    ) {
      return invalid(
        'SKILL_DOCUMENT_STEP_COVERAGE_MISSING',
        `SKILL.md 的测试步骤顺序或标题与步骤“${step.description.trim()}”不一致。`,
      )
    }
    if (
      !isTextCovered(coverageContent, step.action) ||
      !isTextCovered(coverageContent, step.expectedResult)
    ) {
      return invalid(
        'SKILL_DOCUMENT_STEP_COVERAGE_MISSING',
        `SKILL.md 未完整覆盖步骤“${step.description.trim()}”。`,
      )
    }
  }
  return null
}

/**
 * 扫描生成正文中的明显凭据值，避免 Agent 或用户写入真实密钥（PRD v10 8.2 K1）。
 *
 * 这是针对**产物内容**的最后防线：有了 env.json 之后正常流程不会触发它，
 * 保留无任何使用成本；用户手改正文时同样被覆盖。
 *
 * @param context - 已规范化的正文。
 * @returns 命中疑似明文凭据时返回诊断，否则返回 null。
 */
function checkSensitiveContent (context: {
  normalizedContent: string
}): IFileSaveDiagnostic | null {
  const suspiciousPatterns = [
    /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/,
    /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"]?(?!\$\{ENV:[A-Z_][A-Z0-9_]*\})[^\s'"`]{8,}/i,
  ]

  return suspiciousPatterns.some((pattern) =>
    pattern.test(context.normalizedContent),
  )
    ? invalid(
      'SKILL_DOCUMENT_SENSITIVE_CONTENT',
      'SKILL.md 包含疑似明文凭据，请改用环境变量引用。',
      // 安全族：真实凭据一旦落盘无法回收，且这是文档侧唯一的防线，必须阻断。
      'error',
    )
    : null
}

/** 必需章节（标题 → 面向上报的章节名）。 */
const REQUIRED_SECTIONS = [
  ['# 测试目标', '测试目标'],
  ['## 执行上下文', '执行上下文'],
  ['## 前置条件', '前置条件'],
  ['## 测试步骤', '测试步骤'],
  ['## 执行注意事项', '执行注意事项'],
] as const

/**
 * 统一换行与文件末尾格式；空文档返回空串（由调用方决定如何上报）。
 *
 * @param content - 原始正文。
 * @returns 以单个换行结尾的规范化正文；内容为空时返回空串。
 */
function normalizeContent (content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  return normalized ? `${normalized}\n` : ''
}

/**
 * 移除正文中所有围栏代码块，供「只看文档结构」的检查使用。
 *
 * `action` / `expectedResult` 以 ```text 围栏承载原文，其内容属于**被引用的数据**，
 * 不参与文档结构解析。结构类检查（如步骤标题提取）必须先剔除它们，
 * 否则代码块里的枚举行会与真实的步骤标题混淆。
 *
 * 实现按 CommonMark 语义逐行扫描：开围栏（≥3 个反引号，可带语言标注）到
 * 闭围栏（反引号数量不少于开围栏、且其后无其它字符）之间的行全部丢弃。
 *
 * 开围栏的**前导缩进不做限制**（CommonMark 只认 0–3 空格，但本模板的代码块位于
 * 列表项内、按内容列对齐缩进 5 空格，逐行扫描没有列表上下文，故对缩进宽容）。
 * 未闭合的围栏视为延伸至文末——这是容错取向：宁可少识别几个标题，
 * 也不要把代码块内容误当成文档结构。
 *
 * @param content - 已规范化的正文。
 * @returns 移除代码块后的正文；代码块被整体删除（含围栏行），不留空行占位。
 */
function stripFencedCodeBlocks (content: string): string {
  /** 开围栏：允许任意前导空白 + ≥3 个连续反引号，后可跟语言标注。 */
  const openingFence = /^\s*(`{3,})/
  const kept: string[] = []
  let fenceLength = 0

  for (const line of content.split('\n')) {
    if (fenceLength === 0) {
      const opening = line.match(openingFence)
      if (opening) {
        fenceLength = opening[1].length
        continue
      }
      kept.push(line)
      continue
    }

    // 闭围栏：反引号数量不少于开围栏，且其后不得再有其它字符。
    const closing = line.match(/^\s*(`{3,})\s*$/)
    if (closing && closing[1].length >= fenceLength) {
      fenceLength = 0
    }
    // 块内内容（含未匹配的闭围栏行）一律丢弃。
  }

  return kept.join('\n')
}

/**
 * 解析 SKILL.md 顶部的最小 YAML frontmatter。
 *
 * @param content - 已规范化的正文。
 * @returns 解析出的 name / description；缺少 frontmatter 时返回 null。
 */
function parseFrontmatter (content: string): {
  name: string
  description: string
} | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) {
    return null
  }

  const fields = new Map<string, string>()
  for (const line of match[1].split('\n')) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    fields.set(key, value)
  }

  return {
    name: fields.get('name')?.trim() ?? '',
    description: fields.get('description')?.trim() ?? '',
  }
}

/** 收集正文中引用的环境变量名称。 */
function collectEnvironmentVariables (content: string): string[] {
  return [
    ...new Set(
      [...content.matchAll(/\$\{ENV:([A-Z_][A-Z0-9_]*)\}/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort()
}
