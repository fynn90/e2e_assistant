// 语法高亮工具：highlight.js 实例与 highlightCode() 的唯一定义处。
//
// Agent 时间线的只读代码块（ReadOnlyCodeBlock）与 Markdown 围栏代码均经此高亮。
// 语言按工程实际内容精选注册（12 种，合计 gzip 约 20KB）；未注册语言回落到
// 转义纯文本——宁可无色，不可报错或漏转义。
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import http from 'highlight.js/lib/languages/http'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { LanguageFn } from 'highlight.js'
import './hljs-theme.css'

/**
 * 注册的语言清单。
 *
 * 键为 highlight.js 的语言名，别名（ts / js / yml / html / toml / jsonc 等）
 * 由各语言包自带。只注册工程内容实际用到的语言：完整 common 包
 * （36 种语言，gzip 约 76KB）对当前场景过重。
 */
const LANGUAGES: Record<string, LanguageFn> = {
  bash,
  css,
  diff,
  dockerfile,
  http,
  ini,
  javascript,
  json,
  markdown,
  typescript,
  xml,
  yaml,
}

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition)
}

/**
 * 高亮文本长度上限（100KB）。
 *
 * 与 `renderSafeMarkdown` 的截断上限一致。超限回落纯文本：流式输出每次追加
 * 都会整段重渲染，超大代码块（实测 90KB 约 69ms）逐帧高亮会明显拖慢主线程。
 */
const MAX_HIGHLIGHT_LENGTH = 100_000

/**
 * 转义 HTML 特殊字符。
 *
 * 兜底输出必须与高亮输出同样不可信内容零直出；转义集与 markdown-it 保持一致。
 *
 * @param value - 待转义文本。
 * @returns 可安全嵌入 HTML 的文本。
 * @throws 不抛出异常。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 把源码高亮为 HTML 片段（`<span class="hljs-*">`）。
 *
 * 返回值只含 highlight.js 生成的 span 与转义后的文本，可安全用于 `v-html`，
 * 或作为 markdown-it 的 `highlight` 选项返回值嵌入围栏代码块。
 *
 * @param source - 源码原文。
 * @param language - 语言名或别名，大小写不敏感、忽略前后空白；缺省或未注册时
 *   回落为转义纯文本（不发散不报错）。
 * @returns 高亮后的 HTML 片段（内容部分一律转义）。
 * @throws 不抛出异常；异常输入走纯文本兜底。
 */
export function highlightCode(source: string, language?: string): string {
  const name = language?.trim().toLowerCase()
  // getLanguage 对未注册语言返回 undefined；highlight() 则直接抛错，必须先判存在。
  if (
    source.length > MAX_HIGHLIGHT_LENGTH ||
    !name ||
    !hljs.getLanguage(name)
  ) {
    return escapeHtml(source)
  }
  return hljs.highlight(source, {
    language: name,
    // 流式输出的代码可能是半截语法，容忍非法片段而不抛错。
    ignoreIllegals: true,
  }).value
}
