// YAML frontmatter 处理工具：从 markdown 文本中剥离头部元数据块

/**
 * 剥离 markdown 文本开头的 YAML frontmatter 块（--- 包裹的元数据）。
 * 避免 frontmatter 被 markdown-it 误渲染为标题或分隔线。
 * @param content 原始 markdown 文本。
 * @returns 去除 frontmatter 后的正文；无 frontmatter 时原样返回。
 * @throws 不抛出异常。
 */
export function stripMarkdownFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/)
  return match ? content.slice(match[0].length) : content
}
