// Markdown 安全渲染工具：基于 markdown-it 渲染、DOMPurify 消毒，供聊天消息与文档预览复用
import MarkdownIt, { type Options as MarkdownItOptions } from 'markdown-it'
import DOMPurify from 'dompurify'
import { highlightCode } from '../code/highlight'

/**
 * 创建 markdown 渲染器：应用工程统一的解析选项与安全规则。
 *
 * 安全规则与是否高亮无关，两个实例共用：链接协议白名单、图片转纯文本、
 * 外链补 `noopener noreferrer`。
 *
 * @param syntaxHighlight - 是否对围栏代码块做语法高亮。
 * @returns 可直接 `render` 的 markdown-it 实例。
 * @throws 不抛出异常。
 */
function createRenderer(syntaxHighlight: boolean): MarkdownIt {
  const options: MarkdownItOptions = {
    html: false,
    linkify: true,
    breaks: true,
  }
  if (syntaxHighlight) {
    // 回调返回值会被 markdown-it 原样嵌入（不二次转义），
    // 故只能返回 highlightCode 的输出——它保证文本部分一律转义。
    options.highlight = (code: string, language: string) =>
      highlightCode(code, language)
  }
  const markdown = new MarkdownIt(options)

  // 只放行 http(s) / mailto，其余（javascript:、data: 等）一律拒绝
  markdown.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url)

  // 图片不渲染为 <img>：远程图片会向第三方发起请求，退化为「替代文本: 链接」
  markdown.renderer.rules.image = (tokens, index) => {
    const token = tokens[index]
    const altText = token.content || token.attrGet('alt') || '图片链接'
    const source = token.attrGet('src') || ''
    return markdown.utils.escapeHtml(`${altText}: ${source}`)
  }

  const originalLinkOpen = markdown.renderer.rules.link_open
  markdown.renderer.rules.link_open = (
    tokens,
    index,
    options,
    environment,
    self,
  ) => {
    tokens[index].attrSet('rel', 'noopener noreferrer')
    tokens[index].attrSet('target', '_blank')
    return originalLinkOpen
      ? originalLinkOpen(tokens, index, options, environment, self)
      : self.renderToken(tokens, index, options)
  }

  return markdown
}

/** 无高亮渲染器：聊天等既有场景的默认路径。 */
const plainMarkdown = createRenderer(false)

/** 高亮渲染器：`syntaxHighlight` 开启时使用（Agent 时间线的代码展示）。 */
const highlightedMarkdown = createRenderer(true)

/**
 * 类名放行形状：标识符式类名（hljs 的 token 类、语言标记均满足）。
 *
 * 高亮 token 的类名不全是 `hljs-` 前缀——分层 scope 会附加 `function_`、
 * `class_`、`inherited__` 等后缀词，故不收紧到前缀匹配。
 */
const CLASS_TOKEN = /^[a-zA-Z0-9_-]+$/

/**
 * 收窄 `class` 属性的放行范围：仅允许 `span` / `code` 携带标识符式类名。
 *
 * 为什么需要它：高亮依赖 `span` + `hljs-*` 类名，而 DOMPurify 的 `ALLOWED_ATTR`
 * 只能按属性粒度放行——直接放行 `class` 会让**任意元素**都能带类名，日后若有人
 * 打开 `html: true`，类名注入就成了可污染页面样式的口子。此处保持既有安全姿态：
 * 类名只能出现在这两个标签上、且只能是标识符形状。
 */
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName !== 'class') return
  const tag = node.nodeName.toLowerCase()
  const tokens = data.attrValue.trim().split(/\s+/)
  if (
    (tag !== 'span' && tag !== 'code') ||
    !tokens.every((token) => CLASS_TOKEN.test(token))
  ) {
    data.keepAttr = false
  }
})

/**
 * 消毒配置：白名单与 markdown-it 的输出形状严格对齐（`html: false`，
 * 不存在原始 HTML）。`span` / `class` 为语法高亮的 token 着色服务。
 */
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    's',
    'ul',
    'ol',
    'li',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'a',
    'code',
    'pre',
    'span',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  ALLOWED_ATTR: ['href', 'rel', 'target', 'class'],
}

/**
 * 渲染选项。
 */
export interface IRenderSafeMarkdownOptions {
  /**
   * 是否对围栏代码块做语法高亮。
   *
   * 默认关闭：既有消费方（聊天消息等）维持原样，需要高亮的场景显式开启。
   */
  syntaxHighlight?: boolean
}

/**
 * 渲染并消毒 markdown 源文本。
 *
 * @param content - markdown 源文本（超长部分截断）。
 * @param options - 渲染选项。
 * @returns 可安全用于 `v-html` 的 HTML。
 * @throws 不抛出异常。
 */
export function renderSafeMarkdown(
  content: string,
  options: IRenderSafeMarkdownOptions = {},
): string {
  const limitedContent = content.slice(0, 100_000)
  const renderer = options.syntaxHighlight ? highlightedMarkdown : plainMarkdown
  return DOMPurify.sanitize(renderer.render(limitedContent), SANITIZE_CONFIG)
}

export type TMessagePart =
  | { type: 'markdown'; content: string }
  | { type: 'code'; content: string; language: string }

export function splitMessageParts(content: string): TMessagePart[] {
  const parts: TMessagePart[] = []
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g
  let lastIndex = 0

  for (const match of content.matchAll(fencePattern)) {
    const matchIndex = match.index ?? 0

    if (matchIndex > lastIndex) {
      parts.push({
        type: 'markdown',
        content: content.slice(lastIndex, matchIndex),
      })
    }

    parts.push({
      type: 'code',
      language: match[1].trim().slice(0, 40),
      content: match[2].slice(0, 100_000),
    })
    lastIndex = matchIndex + match[0].length
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'markdown', content: content.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ type: 'markdown', content }]
}
