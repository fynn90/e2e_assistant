/**
 * 使用 TypeScript Compiler API 解析脚本并转换语法 diagnostics。
 */
import ts from 'typescript'
import type { IPlaywrightValidationIssue } from './validation-types'

export interface IParsedTypeScript {
  sourceFile: ts.SourceFile
  syntaxErrors: IPlaywrightValidationIssue[]
}

/**
 * 解析 Playwright TypeScript 代码，不执行脚本或解析任何外部模块。
 *
 * @param code - 候选 TypeScript 源码。
 * @returns AST 与语法错误列表。
 */
export function parseTypeScript(code: string): IParsedTypeScript {
  const sourceFile = ts.createSourceFile(
    'test.spec.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const diagnostics =
    ts.transpileModule(code, {
      fileName: 'test.spec.ts',
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
      reportDiagnostics: true,
    }).diagnostics ?? []
  const syntaxErrors = diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) =>
      diagnosticToIssue(diagnostic.file ?? sourceFile, diagnostic),
    )
  return { sourceFile, syntaxErrors }
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
    code: 'TYPESCRIPT_SYNTAX_ERROR',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    severity: 'error',
    ...(position
      ? { line: position.line + 1, column: position.character + 1 }
      : {}),
  }
}
