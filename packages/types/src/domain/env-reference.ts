/**
 * 用例中 `${ENV:KEY}` 环境变量引用的共享识别规则（PRD v10 第 6/7 章）。
 *
 * 职责：提供引用提取、失效判定与「敏感数据行」的数据契约判定，供
 * Web 结构化编辑器、生成前就绪校验与 playwright-engine 静态校验共同调用，
 * 保证引用链路各端只有一份正则与一套判定（避免多端漂移）。
 */

/**
 * `${ENV:NAME}` 占位符（全局匹配形态）。
 *
 * 与 playwright-engine 既有语法一致，正则下沉至此统一维护；
 * 使用方通过 `matchAll` 消费，全局标志不影响复用安全性。
 */
export const ENV_REFERENCE_PATTERN = /\$\{ENV:([A-Z_][A-Z0-9_]*)\}/g

/**
 * 疑似敏感数据的键名词根（PRD 6.1.2 W1）。
 *
 * 不区分大小写、键名包含词根即命中（如 `userPassword`）。
 * 词根表与被移除的敏感词拦截规则（PRD 8.1 D4）同源：
 * 移除的是拦截行为，词根表被新的非阻断软提醒复用。
 */
export const SUGGESTIVE_SENSITIVE_KEY_PATTERN =
  /(password|passwd|token|secret|api[_-]?key|验证码)/i

/**
 * 「敏感数据行已添加但尚未选择 key」的暂存值（PRD 6.1.3 C5）。
 *
 * 该值不会通过任何校验落盘（保存被阻断），仅存在于编辑中的草稿里；
 * 采用残缺占位符形态使其天然不会被引用提取正则识别为有效引用。
 */
export const SENSITIVE_ROW_UNSELECTED_VALUE = '${ENV:}'

/**
 * 引用提取的最小结构化输入。
 *
 * `IE2ETestCase` 天然满足该结构；定义为最小结构是为了让
 * playwright-engine 的最小用例契约也能复用同一份实现（校验规则同源）。
 */
export interface IEnvReferenceScanSource {
  /** 用例标题。 */
  title: string
  /** 用例描述（可选，缺失按空文本处理）。 */
  description?: string
  /** 目标 URL。 */
  baseUrl: string
  /** 标签集合（可选）。 */
  tags?: ReadonlyArray<string>
  /** 前置条件集合（可选）。 */
  preconditions?: ReadonlyArray<{ description: string }>
  /** 测试步骤集合。 */
  steps: ReadonlyArray<{
    /** 是否启用；未启用的步骤不参与提取（与脚本生成范围一致）。 */
    enabled: boolean
    description?: string
    action?: string
    expectedResult?: string
    testData?: Readonly<Record<string, string>>
  }>
}

/** 单个失效引用的定位信息，供行内警示与就绪摘要跳转使用。 */
export interface IEnvReferenceFinding {
  /** 失效的 env key。 */
  key: string
  /** 用例内的位置路径，与 IE2EValidationIssue.path 同构。 */
  path: Array<string | number>
}

/**
 * 判断测试数据条目是否符合「敏感数据行」的数据契约（PRD 6.1.3，第三次修订）。
 *
 * 契约：值恰为一个完整的合法 `${ENV:KEY}` 引用占位符；键名由用户命名，
 * 与所引用的 env key 解耦。判定与序列化回显规则同源，
 * 常量行手输完整占位符（PRD S4）与切换、下拉选择产生的方式同等识别。
 *
 * @param value - 测试数据的值。
 * @returns 条目是已选择 key 的敏感数据行时返回 true；否则返回 false。
 * @throws 不抛出异常。
 */
export function isSensitiveTestDataEntry(value: string): boolean {
  return /^\$\{ENV:([A-Z_][A-Z0-9_]*)\}$/.test(value.trim())
}

/**
 * 判断测试数据条目是否为「已切换为敏感数据但尚未选择 key」的行（PRD 6.1.3 C5）。
 *
 * @param value - 测试数据的值。
 * @returns 条目是未选择 key 的敏感数据行时返回 true；否则返回 false。
 * @throws 不抛出异常。
 */
export function isUnselectedSensitiveEntry(value: string): boolean {
  return value === SENSITIVE_ROW_UNSELECTED_VALUE
}

/**
 * 构造敏感数据行选中某个 env key 后的持久化值（PRD 6.1.3 数据契约）。
 *
 * @param key - 选中的 env key。
 * @returns 形如 `${ENV:E2E_PASSWORD}` 的引用占位符。
 * @throws 不抛出异常。
 */
export function buildSensitiveReferenceValue(key: string): string {
  return `\${ENV:${key}}`
}

/**
 * 收集用例中引用的全部 env key（去重、按字母序排列）。
 *
 * 扫描范围与 playwright-engine 的脚本一致性校验保持一致：
 * 标题、描述、Base URL、标签、前置条件描述，以及**启用步骤**的
 * 描述 / 操作 / 预期结果与测试数据的键和值。禁用步骤不参与——
 * 脚本只为启用步骤生成 `process.env` 引用，两端的 key 集合因此对齐（PRD G2）。
 *
 * @param testCase - 结构化 E2E 用例（或满足最小结构的等价数据）。
 * @returns 去重排序后的 env key 列表。
 * @throws 不抛出异常。
 */
export function collectEnvReferences(
  testCase: IEnvReferenceScanSource,
): string[] {
  const keys = new Set<string>()
  const values = [
    testCase.title,
    testCase.description ?? '',
    testCase.baseUrl,
    ...(testCase.tags ?? []),
    ...(testCase.preconditions ?? []).map(
      (precondition) => precondition.description,
    ),
    ...testCase.steps
      .filter((step) => step.enabled)
      .flatMap((step) => [
        step.description ?? '',
        step.action ?? '',
        step.expectedResult ?? '',
        ...Object.keys(step.testData ?? {}),
        ...Object.values(step.testData ?? {}),
      ]),
  ]

  for (const value of values) {
    for (const match of value.matchAll(ENV_REFERENCE_PATTERN)) {
      const key = match[1]

      if (key) {
        keys.add(key)
      }
    }
  }

  return [...keys].sort()
}

/**
 * 找出用例中在给定 key 集合里不存在的引用（PRD 6.3 / J1）。
 *
 * 每个失效引用按其出现位置产出一条定位信息；同一字段内的重复出现合并为一条。
 * 判定使用与 `collectEnvReferences` 相同的扫描范围（启用步骤），
 * 使「行内警示」与「就绪校验阻断」对同一条引用给出一致的结论。
 *
 * @param testCase - 结构化 E2E 用例（或满足最小结构的等价数据）。
 * @param envKeys - env.json 最新合法内容中的全部 key。
 * @returns 失效引用列表；全部引用有效时返回空数组。
 * @throws 不抛出异常。
 */
export function findMissingEnvReferences(
  testCase: IEnvReferenceScanSource,
  envKeys: ReadonlySet<string>,
): IEnvReferenceFinding[] {
  const findings: IEnvReferenceFinding[] = []
  const seen = new Set<string>()

  /**
   * 记录一个文本字段中失效的引用。
   * @param text - 字段文本。
   * @param path - 字段在用例中的位置路径。
   * @returns 无返回值。
   */
  function scanText(text: string, path: Array<string | number>): void {
    for (const match of text.matchAll(ENV_REFERENCE_PATTERN)) {
      const key = match[1]
      if (!key || envKeys.has(key)) continue

      const dedupeKey = `${key}:${path.join('.')}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      findings.push({ key, path })
    }
  }

  scanText(testCase.title, ['title'])
  scanText(testCase.description ?? '', ['description'])
  scanText(testCase.baseUrl, ['baseUrl'])
  ;(testCase.tags ?? []).forEach((tag, index) => scanText(tag, ['tags', index]))
  ;(testCase.preconditions ?? []).forEach((precondition, index) =>
    scanText(precondition.description, ['preconditions', index, 'description']),
  )

  testCase.steps.forEach((step, index) => {
    if (!step.enabled) return

    scanText(step.description ?? '', ['steps', index, 'description'])
    scanText(step.action ?? '', ['steps', index, 'action'])
    scanText(step.expectedResult ?? '', ['steps', index, 'expectedResult'])

    for (const [key, value] of Object.entries(step.testData ?? {})) {
      // 键与值共用同一路径：测试数据条目的定位以键名收尾（IE2EValidationIssue 同构）。
      scanText(key, ['steps', index, 'testData', key])
      scanText(value, ['steps', index, 'testData', key])
    }
  })

  return findings
}
