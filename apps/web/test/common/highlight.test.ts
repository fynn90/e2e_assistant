/**
 * 语法高亮的单元测试（`common/code/highlight.ts`）。
 *
 * 覆盖三条契约：
 *   1. 已注册语言产出 hljs token，未注册 / 缺省语言**回落转义纯文本**；
 *   2. 输出可安全嵌入 HTML——源码里的 `<`、`&`、引号一律转义（高亮与否都不例外）；
 *   3. 非法 / 半截语法不抛错（流式输出的常态）。
 *
 * 第 2 条是安全底线：`highlightCode` 的返回值会被 `v-html` 与 markdown-it
 * 的 `highlight` 回调**原样嵌入**（后者不二次转义），漏转义即等于注入。
 */
import { describe, expect, it } from 'vitest'
import { highlightCode } from '../../src/common/code/highlight'

describe('highlightCode', () => {
  it('已注册语言产出 hljs token', () => {
    const html = highlightCode('const a = 1', 'typescript')

    expect(html).toContain('hljs-keyword')
    expect(html).toContain('hljs-number')
  })

  it('语言名大小写不敏感，且接受别名', () => {
    // 事件里的 language 由模型给出，大小写不作保证
    expect(highlightCode('const a = 1', 'TypeScript')).toContain('hljs-keyword')
    expect(highlightCode('const a = 1', ' ts ')).toContain('hljs-keyword')
    // 'ts' / 'yml' / 'html' 等别名由各语言包自带；别名失效说明注册时没走 registerLanguage
    expect(highlightCode('a: 1', 'yml')).toContain('hljs-attr')
    expect(highlightCode('<div id="a">', 'html')).toContain('hljs-tag')
  })

  it('markdown 围栏声明的语言（含工程文档实际用到的）均可高亮', () => {
    // 取自 packages/agent/PRD 与技能文档里实际出现的围栏标签
    const cases: Array<[string, string]> = [
      ['json', '{"a": 1}'],
      ['bash', 'echo "hi"'],
      ['javascript', 'const a = 1'],
      ['css', '.a { color: red }'],
      ['diff', '--- a\n+++ b'],
      ['http', 'GET /x HTTP/1.1'],
      ['dockerfile', 'FROM node:22'],
      ['ini', '[sec]\nkey = 1'],
    ]

    for (const [language, source] of cases) {
      expect(highlightCode(source, language), language).toContain('hljs-')
    }
  })

  it('未注册 / 缺省语言回落转义纯文本，不产生 hljs token', () => {
    for (const language of [undefined, '', 'mermaid', 'brainfuck']) {
      const html = highlightCode('const a = 1', language)

      expect(html, String(language)).toBe('const a = 1')
      expect(html, String(language)).not.toContain('hljs-')
    }
  })

  it('高亮路径转义 HTML 特殊字符', () => {
    // 字符串里的尖括号是常见来源：page.goto('<a>&"')
    const html = highlightCode(
      'const s = "</script><img src=x onerror=1>"',
      'typescript',
    )

    expect(html).not.toContain('<img')
    expect(html).not.toContain('</script>')
    expect(html).toContain('&lt;')
    expect(html).toContain('&gt;')
    expect(html).toContain('&quot;')
  })

  it('纯文本回落路径同样转义 HTML 特殊字符', () => {
    // 这条最容易漏：兜底分支若直接返回原文，等于给未注册语言开了注入口
    const html = highlightCode('<img src=x onerror=alert(1)>&"\'', 'mermaid')

    expect(html).not.toContain('<img')
    expect(html).toBe('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;')
  })

  it('半截 / 非法语法不抛错（流式输出的常态）', () => {
    expect(() => highlightCode('const a = "abc', 'typescript')).not.toThrow()
    expect(() => highlightCode('function f() {', 'typescript')).not.toThrow()
    expect(() => highlightCode('#$%^&*', 'typescript')).not.toThrow()
    // 半截字符串仍会被识别并着色，说明未因非法片段整体放弃
    expect(highlightCode('const a = "abc', 'typescript')).toContain(
      'hljs-string',
    )
  })
})
