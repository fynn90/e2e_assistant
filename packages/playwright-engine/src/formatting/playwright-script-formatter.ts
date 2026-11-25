/**
 * 使用 TypeScript Printer 对已解析的候选脚本执行确定性基础格式化。
 */
import ts from 'typescript'

/**
 * 格式化候选 TypeScript 源码，不执行模块解析或代码。
 *
 * @param sourceFile - 无语法错误的 TypeScript AST。
 * @returns 使用 LF 和尾换行的格式化代码。
 */
export function formatPlaywrightScript(sourceFile: ts.SourceFile): string {
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  })
  return `${printer.printFile(sourceFile).trimEnd()}\n`
}
