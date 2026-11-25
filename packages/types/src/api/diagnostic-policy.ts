/**
 * 诊断的「是否阻断写入」策略（v15）。
 *
 * 背景：v15 起 SKILL.md 与 Playwright 脚本的写入**不再因内容质量问题被阻断**——
 * 发现问题只用诊断提醒用户，Agent 产出的内容一律写入指定文件。但**安全边界**类
 * 问题必须继续阻断：v14 技术方案已决策「运行期不设 fs 拦截」（D4），执行期没有
 * 第二道防线，生成期是唯一的拦截点。
 *
 * 因此本模块要回答的唯一问题是：**一条诊断是否必须阻断写入**。
 *
 * 设计取舍：**阻断是「检查族」的属性，不是「单条消息」的属性**——明文凭据扫描在
 * 定义上就永远属于安全族，不存在「有时是安全、有时是质量」。若改用 `blocking`
 * 布尔字段让每个 issue 构造点自行标注，安全决策就被分散到各处，漏标一处即
 * fail-open；集中在下面这一个注册表里才可审计。
 *
 * 判定归属：validator 只负责发出正确的 `code` 与 `severity`（安全族发 `error`，
 * 质量族发 `warning`），**阻断决策由应用层调用 {@link isBlockingDiagnostic} 做出**。
 * 校验层不感知调用方是首次落盘还是实时编辑。
 */
import type { TDiagnosticSeverity } from './file-save'

/**
 * 安全边界诊断码：命中的诊断在写入时仍然阻断。
 *
 * 这是「阻断」的唯一权威定义。**安全族的 `error` 级别是不可协商项**：
 *
 *   - v14 技术方案 D4 明确决策「运行期不设 fs 拦截」，越界写盘没有第二道防线；
 *   - 目录外的写操作、子进程与动态执行一旦落盘，平台不再有机会拦截。
 *
 * 故本清单只应因「某条检查的防护对象发生变化」而增删，不应为了「让某次生成成功」
 * 而放宽。
 */
export const SECURITY_BLOCKING_CODES: ReadonlySet<string> = new Set([
  // —— Playwright 脚本安全边界（v14 W33/W34/W36/W37）——
  /** 使用了 eval / child_process / 动态执行等禁止能力。 */
  'FORBIDDEN_API',
  /** 导入了白名单之外的模块或非白名单成员。 */
  'IMPORT_NOT_ALLOWED',
  /** 使用了 require。 */
  'REQUIRE_NOT_ALLOWED',
  /** 使用了动态 import()。 */
  'DYNAMIC_IMPORT_NOT_ALLOWED',
  /** fs 调用的路径无法证明位于 userWorkSpace 内（越界写盘）。 */
  'FS_PATH_OUTSIDE_WORKSPACE',
  /** 试图删除或重命名 userWorkSpace 根目录。 */
  'FS_WORKSPACE_ROOT_DELETE',
  /**
   * TypeScript 语法错误。
   *
   * 归入安全族有两个独立且都成立的硬理由（均经真实 TypeScript 实测确认）：
   *
   *   1. **不阻断会写入被改写的代码**：格式化用 `ts.createPrinter().printFile()`
   *      从 AST 重新打印，而打印机对不可解析代码会**凭空补全缺失 token**
   *      （未闭合的函数体会被自动补上 `});`）、并**静默丢弃**游离 token，
   *      产出「语法合法但语义被改写」的代码。
   *   2. **不阻断会让安全校验整体失效**：校验器在语法错误时**直接早退**，
   *      后续全部安全校验器一个都不跑——含 `child_process` 且语法有误的脚本
   *      只会报语法错误，导入策略与禁止 API 检查完全不出结论。
   */
  'TYPESCRIPT_SYNTAX_ERROR',
  // —— SKILL.md 安全边界 ——
  /** 产物正文疑似包含明文凭据（v10 PRD 8.2 K1，文档侧的最后防线）。 */
  'SKILL_DOCUMENT_SENSITIVE_CONTENT',
])

/**
 * 判断单条诊断是否必须阻断写入。
 *
 * 判据是**双向 fail-closed** 的，两个方向都不会静默漏放：
 *
 *   - 安全码永远阻断——即使它被误标成 `warning`；
 *   - `error` 级永远阻断——即使某个码漏登记进 {@link SECURITY_BLOCKING_CODES}。
 *
 * 「漏登记」的后果因此是**开发期立刻可见的功能回归**（用户点生成就失败），
 * 而不是一个静默的安全漏洞。改动安全清单时请配合 `diagnostic-policy.test.ts`
 * 的码清单不变式测试。
 *
 * @param diagnostic - 待判定的诊断；只需 `code` 与 `severity` 两个字段。
 * @returns 必须阻断写入时返回 true。
 * @throws 不抛出异常。
 */
export function isBlockingDiagnostic(diagnostic: {
  code: string
  severity: TDiagnosticSeverity
}): boolean {
  return (
    SECURITY_BLOCKING_CODES.has(diagnostic.code) ||
    diagnostic.severity === 'error'
  )
}
