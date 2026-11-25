/**
 * 验证技能静态包含（`{{> 子文件 }}`）的组装行为（v12）。
 *
 * 背景：技能正文在构建期经 `?raw` 内联进内存注册表，运行期**没有**按路径读子文件的能力。
 * 因此「主文件引用子文件」只能在注册时组装；本测试锁定该机制的正确性与失败语义。
 */

import { describe, expect, it } from 'vitest'
import { composeSkill, composeSkillContent } from '../src/skills/compose-skill'
import { resourceLoader } from '../src/resourceLoader'

describe('composeSkillContent', () => {
  it('展开全部占位符', () => {
    const result = composeSkillContent('A\n{{> one }}\nB\n{{>two}}\nC', {
      one: 'ONE',
      two: 'TWO',
    })

    expect(result).toBe('A\nONE\nB\nTWO\nC')
  })

  it('支持嵌套包含', () => {
    const result = composeSkillContent('{{> outer }}', {
      outer: 'O[{{> inner }}]O',
      inner: 'INNER',
    })

    expect(result).toBe('O[INNER]O')
  })

  it('引用缺失的子文件时明确报错并列出可用项', () => {
    expect(() =>
      composeSkillContent('{{> missing }}', { present: 'x' }, { name: 'demo' }),
    ).toThrow(/未提供的子文件「missing」/)
  })

  it('循环引用快速失败而不是无限递归', () => {
    expect(() =>
      composeSkillContent('{{> a }}', { a: '{{> a }}' }, { name: 'loop' }),
    ).toThrow(/循环引用/)
  })

  it('无占位符时原样返回', () => {
    expect(composeSkillContent('plain', {})).toBe('plain')
  })

  it('不误伤运行期变量占位符 {{ name }}', () => {
    // 静态包含用 `{{> x }}`，运行期变量用 `{{ x }}`，两者刻意区分。
    const result = composeSkillContent('{{ keepMe }}', {
      keepMe: 'SHOULD_NOT_APPLY',
    })

    expect(result).toBe('{{ keepMe }}')
  })
})

describe('composeSkill', () => {
  it('用 name 报告错误', () => {
    expect(() => composeSkill('{{> x }}', {}, 'my-skill')).toThrow(/my-skill/)
  })
})

describe('playwright_script_generation 技能组装结果', () => {
  it('注册后的技能正文不含未展开的占位符', () => {
    const skill = resourceLoader.getSkill('playwright_script_generation')

    expect(skill.content).not.toContain('{{>')
  })

  it('全部子章节都已内联（主文件仅作索引，内容来自子文件）', () => {
    const content = resourceLoader.getSkill(
      'playwright_script_generation',
    ).content

    for (const heading of [
      '## 用途',
      '## 页面核对（必须执行）',
      '## 多步骤流程：先列 todo 清单，再逐步核对',
      '## 视觉回归核对（新旧 DOM 截图对比）',
      '## 输出格式',
      '## 生成规则',
      '## 交付要求',
      '## 不确定性的处理',
    ]) {
      expect(content).toContain(heading)
    }
  })

  it('frontmatter 的 name 与 description 保持不变（技能匹配依赖它）', () => {
    const skill = resourceLoader.getSkill('playwright_script_generation')

    expect(skill.name).toBe('playwright_script_generation')
    expect(skill.description.length).toBeGreaterThan(0)
  })
})
