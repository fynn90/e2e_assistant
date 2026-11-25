/**
 * 使用内存 TypeScript Program 对候选脚本执行不加载代码的轻量语义检查。
 */
import ts from 'typescript'
import type { IPlaywrightValidationIssue } from './validation-types'

const SCRIPT_FILE_NAME = '/authine-validation/test.spec.ts'
const SHIM_FILE_NAME = '/authine-validation/runtime-shim.d.ts'
const SHIM_SOURCE = `
declare module '@playwright/test' {
  /**
   * 元素句柄的最小类型边界。
   *
   * 唯一目的是给**接收回调的方法**提供签名，让回调参数有上下文类型——
   * 接收者为 any 时回调参数在 strict 的 noImplicitAny 下会被判为隐式 any 并阻断生成，
   * 而这类回调（page.on、evaluate 等）恰恰是真实脚本的常见写法。
   *
   * 两条设计约束，缺一不可：
   *   1. 未列举的成员由索引签名兜底为 any，保持既有兼容性；
   *   2. 除回调形参外的参数一律用**变参**声明。真实 Playwright 的 API 常有多个可选参数
   *      （如 locator(selector[, options])），按固定元数声明会把合法调用误判为
   *      「Expected N arguments」——误拒合法代码比漏报更危险。
   */
  export interface Locator {
    [key: string]: any
    evaluate(callback: (...args: any[]) => any, ...rest: any[]): Promise<any>
    screenshot(...rest: any[]): Promise<any>
    first(): Locator
    last(): Locator
    nth(...rest: any[]): Locator
    filter(...rest: any[]): Locator
  }

  /** 页面对象的最小类型边界，取舍理由同 Locator。 */
  export interface Page {
    [key: string]: any
    /** 事件监听：真实 API 固定为 (event, listener)，故逐字声明两参。 */
    on(event: string, listener: (...args: any[]) => void): any
    once(event: string, listener: (...args: any[]) => void): any
    off(event: string, listener: (...args: any[]) => void): any
    evaluate(callback: (...args: any[]) => any, ...rest: any[]): Promise<any>
    waitForFunction(callback: (...args: any[]) => any, ...rest: any[]): Promise<any>
    /** 定位类方法返回 Locator，使链式调用后的回调仍有上下文类型。 */
    locator(...rest: any[]): Locator
    getByRole(...rest: any[]): Locator
    getByText(...rest: any[]): Locator
    getByLabel(...rest: any[]): Locator
    getByPlaceholder(...rest: any[]): Locator
    getByTestId(...rest: any[]): Locator
  }

  interface TestApi {
    (title: string, callback: (fixtures: { page: Page }) => unknown): unknown
    step(title: string, callback: () => unknown): unknown
  }
  export const test: TestApi
  export const expect: (actual: unknown) => any
}
declare const process: {
  env: Record<string, string | undefined>
}
/**
 * v14（W33/W34）：Node 原生文件模块的最小类型边界。
 *
 * 哲学与 @playwright/test shim 一致：变参 + any 返回，只保证「模板形态零语义错误」，
 * 不追求与真实 Node 类型图一致（宽松面的取舍见技术方案 §5.4/R5：极端写法可能
 * 本地校验通过而运行期行为不同，运行期失败由测试报告捕获）。
 * 成员清单与 import-policy-validator 的 ALLOWED_FS_API_BASE_NAMES 同源
 * （node:fs 额外含 Sync 变体；node:fs/promises 仅 Promise 形态）。
 */
declare module 'node:fs' {
  export function mkdir(...args: any[]): any
  export function mkdirSync(...args: any[]): any
  export function writeFile(...args: any[]): any
  export function writeFileSync(...args: any[]): any
  export function appendFile(...args: any[]): any
  export function appendFileSync(...args: any[]): any
  export function readFile(...args: any[]): any
  export function readFileSync(...args: any[]): any
  export function copyFile(...args: any[]): any
  export function copyFileSync(...args: any[]): any
  export function rename(...args: any[]): any
  export function renameSync(...args: any[]): any
  export function readdir(...args: any[]): any
  export function readdirSync(...args: any[]): any
  export function stat(...args: any[]): any
  export function statSync(...args: any[]): any
  export function access(...args: any[]): any
  export function accessSync(...args: any[]): any
  export function unlink(...args: any[]): any
  export function unlinkSync(...args: any[]): any
  export function rm(...args: any[]): any
  export function rmSync(...args: any[]): any
  export function rmdir(...args: any[]): any
  export function rmdirSync(...args: any[]): any
}
declare module 'node:fs/promises' {
  export function mkdir(...args: any[]): Promise<any>
  export function writeFile(...args: any[]): Promise<any>
  export function appendFile(...args: any[]): Promise<any>
  export function readFile(...args: any[]): Promise<any>
  export function copyFile(...args: any[]): Promise<any>
  export function rename(...args: any[]): Promise<any>
  export function readdir(...args: any[]): Promise<any>
  export function stat(...args: any[]): Promise<any>
  export function access(...args: any[]): Promise<any>
  export function unlink(...args: any[]): Promise<any>
  export function rm(...args: any[]): Promise<any>
  export function rmdir(...args: any[]): Promise<any>
}
declare module 'node:path' {
  const path: {
    resolve(...args: string[]): string
    join(...args: string[]): string
    relative(from: string, to: string): string
    isAbsolute(p: string): boolean
    dirname(p: string): string
    basename(p: string, ext?: string): string
    extname(p: string): string
    sep: string
    [key: string]: any
  }
  export default path
}
`

/**
 * 对单个 Playwright 脚本执行 TypeScript 语义诊断，不 emit、不 require、不执行模块。
 *
 * 仅提供 Playwright 与 process.env 的最小类型边界，避免加载完整测试运行时类型图；
 * Playwright 专属结构由其他 AST 校验器负责。
 *
 * @param code - 候选 TypeScript 源码。
 * @returns 当前脚本文件上的语义错误。
 */
export function validateTypeScriptSemantics(
  code: string,
): IPlaywrightValidationIssue[] {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  }
  const defaultHost = ts.createCompilerHost(compilerOptions, true)
  const scriptSource = ts.createSourceFile(
    SCRIPT_FILE_NAME,
    code,
    compilerOptions.target ?? ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  )
  const shimSource = ts.createSourceFile(
    SHIM_FILE_NAME,
    SHIM_SOURCE,
    compilerOptions.target ?? ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  )
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists(candidatePath) {
      return (
        candidatePath === SCRIPT_FILE_NAME ||
        candidatePath === SHIM_FILE_NAME ||
        defaultHost.fileExists(candidatePath)
      )
    },
    readFile(candidatePath) {
      if (candidatePath === SCRIPT_FILE_NAME) return code
      if (candidatePath === SHIM_FILE_NAME) return SHIM_SOURCE
      return defaultHost.readFile(candidatePath)
    },
    getSourceFile(
      candidatePath,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) {
      if (candidatePath === SCRIPT_FILE_NAME) return scriptSource
      if (candidatePath === SHIM_FILE_NAME) return shimSource
      return defaultHost.getSourceFile(
        candidatePath,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      )
    },
  }
  const program = ts.createProgram(
    [SCRIPT_FILE_NAME, SHIM_FILE_NAME],
    compilerOptions,
    host,
  )
  return program
    .getSemanticDiagnostics(scriptSource)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => diagnosticToIssue(scriptSource, diagnostic))
}

function diagnosticToIssue(
  sourceFile: ts.SourceFile,
  diagnostic: ts.Diagnostic,
): IPlaywrightValidationIssue {
  const position =
    diagnostic.start === undefined
      ? undefined
      : sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
  return {
    code: 'TYPESCRIPT_SEMANTIC_ERROR',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    severity: 'warning',
    ...(position
      ? { line: position.line + 1, column: position.character + 1 }
      : {}),
  }
}
