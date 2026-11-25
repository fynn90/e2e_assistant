import { describe, expect, it } from 'vitest'
import { renderSafeMarkdown } from '../src/common/chat/markdown'

describe('safe Markdown rendering', () => {
  it('removes executable HTML and unsafe URLs', () => {
    const rendered = renderSafeMarkdown(
      '<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [good](https://example.com)',
    )

    expect(rendered).not.toContain('<img')
    expect(rendered).not.toContain('href="javascript:')
    expect(rendered).toContain('https://example.com')
    expect(rendered).toContain('noopener noreferrer')
  })
})

describe('围栏代码块语法高亮', () => {
  it('默认不高亮（既有消费方维持原样）', () => {
    const rendered = renderSafeMarkdown('```typescript\nconst a = 1\n```')

    expect(rendered).not.toContain('hljs-')
  })

  it('开启后 token 类的 span 通过消毒幸存', () => {
    // 本断言是「高亮 + 消毒」这对组合的回归锁：DOMPurify 的白名单若漏掉
    // span / class，hljs 的着色会在消毒环节被整体剥掉——渲染回退成纯文本，
    // 但页面上不会有任何报错，只有人工比对才能发现。
    const rendered = renderSafeMarkdown('```typescript\nconst a = 1\n```', {
      syntaxHighlight: true,
    })

    expect(rendered).toContain('<span class="hljs-keyword">const</span>')
    expect(rendered).toContain('hljs-number')
  })

  it('未注册语言回落为转义纯文本，不遗留 hljs token', () => {
    const rendered = renderSafeMarkdown('```mermaid\ngraph TD; A-->B\n```', {
      syntaxHighlight: true,
    })

    expect(rendered).not.toContain('hljs-')
    expect(rendered).toContain('A--&gt;B')
  })

  it('高亮路径不放松注入防线', () => {
    // 代码里的 HTML 与事件处理器必须仍被转义（高亮回调的输出会被原样嵌入）
    const rendered = renderSafeMarkdown(
      '```typescript\nconst s = "</script><img src=x onerror=1>"\n```',
      { syntaxHighlight: true },
    )

    expect(rendered).not.toContain('<img')
    expect(rendered).not.toContain('onerror=1">')
    expect(rendered).toContain('&lt;')
  })
})
