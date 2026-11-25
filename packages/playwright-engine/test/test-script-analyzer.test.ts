/** 验证测试脚本静态分析：test() 判定与 process.env 引用收集（v11 J2/J4）。 */

import { describe, expect, it } from 'vitest'
import { analyzeTestScript } from '../src/validation/test-script-analyzer'

describe('analyzeTestScript', () => {
  it('空文件与纯注释判定为无测试', () => {
    expect(analyzeTestScript('').hasTests).toBe(false)
    expect(analyzeTestScript('   \n\t').hasTests).toBe(false)
    expect(analyzeTestScript('// 只有注释\n/* 块注释 */').hasTests).toBe(false)
  })

  it('只有辅助函数没有 test() 判定为无测试', () => {
    const code = `
      import { expect } from '@playwright/test'
      export function helper(value: string): string {
        return value.trim()
      }
    `
    expect(analyzeTestScript(code).hasTests).toBe(false)
  })

  it('包含一条 test() 判定为有测试并计数', () => {
    const code = `
      import { test, expect } from '@playwright/test'
      test('登录成功', async ({ page }) => {
        await page.goto('/')
      })
    `
    const analysis = analyzeTestScript(code)
    expect(analysis.hasTests).toBe(true)
    expect(analysis.testCount).toBe(1)
  })

  it('收集 process.env.KEY 与 process.env["KEY"] 两种引用并去重', () => {
    const code = `
      import { test, expect } from '@playwright/test'
      test('登录', async ({ page }) => {
        const password = process.env.E2E_PASSWORD
        const user = process.env['E2E_USER']
        const again = process.env.E2E_PASSWORD
      })
    `
    expect(analyzeTestScript(code).environmentVariables).toEqual([
      'E2E_PASSWORD',
      'E2E_USER',
    ])
  })

  it('非 process 对象的 env 属性访问不误报', () => {
    const code = `
      const config = { env: { KEY: 'x' } }
      const value = config.env.KEY
    `
    expect(analyzeTestScript(code).environmentVariables).toEqual([])
  })
})
