/**
 * 全局类型声明：允许以 `?raw` 后缀导入 markdown 文件，返回文件原始文本字符串。
 * 构建期由 tsup 的 text loader 内联，开发期/测试期由 Vite 的 `?raw` 机制处理。
 */
declare module '*.md?raw' {
  const content: string
  export default content
}
