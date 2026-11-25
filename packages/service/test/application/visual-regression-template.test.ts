/**
 * 视觉回归脚本模板与平台静态校验器的一致性测试（v12，技术方案 §8.2）。
 *
 * 这是 v12 最关键的测试：它把「模板能否通过平台门禁」变成可回归的断言。
 *
 * 位置说明：本测试需要同时引用 agent 的技能资源与 playwright-engine 的校验器，
 * 而 agent 包不得依赖 playwright-engine，因此放在组合根 service（跨包集成测试随集成点走）。
 *
 * 背景——内联脚本有三条**实测得出、违反即阻断生成**的硬约束（技术方案 §2.7）：
 *   1. 平台的 TypeScript 语义校验开启严格模式。**自行声明的函数**参数必须显式标注类型
 *      （用 `any`），否则报隐式 any。
 *      v13 起 shim 已声明 `Locator` / `Page`，`page.getByRole(...)` / `page.locator(...)`
 *      等**已声明方法**的回调有了上下文类型（如 `page.on('console', (message) => ...)`
 *      不再需要标注）；但挂在用户自定义 any 参数（如 `captureFullContent(target: any)`
 *      里的 `target`）上的调用仍无从推断，故模板保留 `: any` 写法——多标注无副作用。
 *   2. 平台的 `expect` 类型声明**只接受 1 个参数**，`expect(值, '说明')` 会报
 *      「Expected 1 arguments, but got 2」；
 *   3. 操作与断言必须**直接出现在 `test.step` 体内**，把比对循环封装成外部函数会让
 *      该步骤的操作数与断言数均为 0，触发 STEP_ASSERTION_REQUIRED。
 *
 * 正向用例锁定「模板当前是合法的」；反向用例锁定「每条约束都仍然生效」——
 * 后者防止将来有人放宽校验或改动模板而无人察觉。
 */

import { describe, expect, it } from 'vitest'
import type { IValidationTestCase } from '@fynn90-e2e_assistant/playwright-engine'
import { PlaywrightScriptValidator } from '@fynn90-e2e_assistant/playwright-engine'
import { resourceLoader } from '@fynn90-e2e_assistant/agent'

const validator = new PlaywrightScriptValidator()

/** 与视觉回归步骤对应的最小用例。 */
const testCase: IValidationTestCase = {
  title: '用户登录成功',
  baseUrl: 'https://example.test',
  description: '验证登录。',
  tags: [],
  preconditions: [],
  steps: [
    {
      id: 'step_visual',
      order: 1,
      description: '打开预览并做新旧 DOM 对比',
      action: '点击实际预览',
      expectedResult: '预览画布与基线一致',
      testData: {},
      enabled: true,
    },
  ],
}

/**
 * 从 Skill 正文中抽取视觉回归模板的两个辅助函数。
 *
 * 直接从 Skill 文本里取，而不是在测试里复制一份——这样才能保证测试锁定的
 * 是**真正给模型看的那份模板**，而不是测试里另写的一份（后者会随模板漂移而失效）。
 *
 * @returns 模板中的辅助函数源码（从第一个 function 到「在步骤内按下面的形态使用」之前）。
 * @throws {Error} 模板结构变化导致无法抽取时抛出，提示测试需要同步更新。
 */
function extractHelperFunctions (): string {
  const skill = resourceLoader.getSkill('playwright_script_generation').content
  const marker = "import { test, expect } from '@playwright/test'"
  const start = skill.indexOf(marker)

  if (start < 0) {
    throw new Error(
      '未在 Skill 正文中找到视觉回归模板的 import 语句，模板结构可能已变更。',
    )
  }

  // 模板代码块的结束标记：辅助函数之后紧跟的使用示例。
  const endMarker = '在步骤内按下面的形态使用'
  const end = skill.indexOf(endMarker, start)

  if (end < 0) {
    throw new Error(
      '未在 Skill 正文中找到模板代码块的结束标记，模板结构可能已变更。',
    )
  }

  // 截取代码块正文，并去掉 markdown 围栏。
  const block = skill.slice(start, end)
  const fenceEnd = block.lastIndexOf('```')

  return fenceEnd > 0 ? block.slice(0, fenceEnd) : block
}

/** 组装一份完整的候选脚本（辅助函数 + 步骤体）。 */
function buildScript (
  stepBody: string,
  helpers = extractHelperFunctions(),
): string {
  return `${helpers}

test('用户登录成功', async ({ page }) => {
  await page.goto('https://example.test')

  await test.step('step_visual', async () => {
${stepBody}
  })
})
`
}

/** 推荐的步骤体：操作 + 比对循环（在 step 内）+ 兜底断言。 */
const RECOMMENDED_STEP_BODY = `    await page.getByRole('button', { name: '实际预览' }).click()
    const target = page.locator('.print-canvas')
    const buffer = await captureFullContent(target)

    const candidates = ['candidate-a.png', 'candidate-b.png']
    const attempted: string[] = []

    for (const candidate of candidates) {
      attempted.push(candidate)
      try {
        expect(buffer).toMatchSnapshot(['preview', candidate], { maxDiffPixels: 0 })
        attempted.length = 0
        break
      } catch (error) {
        if (attempted.length === candidates.length) {
          throw new Error('视觉比对未通过，已尝试候选：' + attempted.join('、'))
        }
      }
    }

    await expect(target).toBeVisible()`

describe('视觉回归脚本模板与校验器的一致性', () => {
  it('Skill 正文中的模板能通过平台的静态校验', () => {
    const result = validator.validate(buildScript(RECOMMENDED_STEP_BODY), {
      testCase,
    })

    // 模板必须完全合法，且步骤覆盖同时满足「有操作」与「有断言」。
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    expect(result.stepCoverage).toHaveLength(1)
    expect(result.stepCoverage[0]?.operations).toBeGreaterThanOrEqual(1)
    expect(result.stepCoverage[0]?.assertions).toBeGreaterThanOrEqual(1)
  })

  it('模板中不出现平台明确反对的固定等待', () => {
    const result = validator.validate(buildScript(RECOMMENDED_STEP_BODY), {
      testCase,
    })

    expect(result.warnings.map((issue) => issue.code)).not.toContain(
      'FIXED_WAIT_DISCOURAGED',
    )
  })

  it('模板的辅助函数全部以显式类型标注参数（防隐式 any 约束失效）', () => {
    const helpers = extractHelperFunctions()

    // 反向锁定：模板里的每个箭头函数/函数参数都必须带类型标注。
    // 只要有人把 `(el: any)` 改回 `(el)`，这条断言就会失败。
    expect(helpers).toContain('el: any')
    expect(helpers).not.toMatch(/\(el\)\s*=>/)
    expect(helpers).not.toMatch(/\(el, s\)\s*=>/)
    expect(helpers).not.toMatch(/\(el, p\)\s*=>/)
  })

  it('模板使用稳定性重试而非固定等待', () => {
    const helpers = extractHelperFunctions()

    expect(helpers).toContain('async function captureStable')
    expect(helpers).toContain('current.equals(previous)')
    expect(helpers).not.toContain('waitForTimeout')
  })
})

describe('反向用例：三条硬约束仍被检出（v15 起以警告呈现，不再阻断）', () => {
  // 这三条约束的**检出逻辑**没有变，变的是处置方式：v15 起内容质量问题不再阻断
  // 生成，而是作为警告下发（脚本提示词的规则本身也要求 Agent 遵守，两者不冲突）。
  // 断言因此从 errors 移到 warnings——若哪天检出失效，这组用例仍会失败。
  it('去掉参数的显式类型标注会被拦截（隐式 any）', () => {
    // 把模板里所有 `: any` 去掉，模拟「忘记标注」。
    const helpers = extractHelperFunctions().replace(/: any/g, '')
    const result = validator.validate(
      buildScript(RECOMMENDED_STEP_BODY, helpers),
      { testCase },
    )

    expect(result.warnings.map((issue) => issue.code)).toContain(
      'TYPESCRIPT_SEMANTIC_ERROR',
    )
  })

  it('expect 使用双参数形态会被拦截', () => {
    const stepBody = `    const target = page.locator('.print-canvas')
    await target.click()
    const buffer = await captureFullContent(target)
    expect(buffer.length > 0, '截图不应为空').toBe(true)
    await expect(target).toBeVisible()`
    const result = validator.validate(buildScript(stepBody), { testCase })

    expect(result.warnings.map((issue) => issue.code)).toContain(
      'TYPESCRIPT_SEMANTIC_ERROR',
    )
  })

  it('把比对循环封装成外部函数会导致该步骤缺少断言', () => {
    // 模拟「为了可读性把循环抽成 helper」——这正是最容易被直觉误导的写法。
    const helpers = `${extractHelperFunctions()}

function matchAnyBaseline(buffer: any, dir: string, candidates: string[]) {
  for (const candidate of candidates) {
    try {
      expect(buffer).toMatchSnapshot([dir, candidate], { maxDiffPixels: 0 })
      return
    } catch (error) {
      if (candidates.indexOf(candidate) === candidates.length - 1) throw error
    }
  }
}`
    const stepBody = `    await page.getByRole('button', { name: '实际预览' }).click()
    const buffer = await page.locator('.print-canvas').screenshot()
    matchAnyBaseline(buffer, 'preview', ['a.png', 'b.png'])`
    const result = validator.validate(buildScript(stepBody, helpers), {
      testCase,
    })

    expect(result.warnings.map((issue) => issue.code)).toContain(
      'STEP_ASSERTION_REQUIRED',
    )
  })

  it('用固定等待代替稳定性重试会产生警告', () => {
    const helpers = extractHelperFunctions().replace(
      'async function captureStable(target: any) {',
      'async function captureStable(target: any, page: any) {\n  await page.waitForTimeout(200)',
    )
    const stepBody = `    await page.getByRole('button', { name: '实际预览' }).click()
    const target = page.locator('.print-canvas')
    const buffer = await captureStable(target, page)
    const candidates = ['candidate-a.png']
    for (const candidate of candidates) {
      try {
        expect(buffer).toMatchSnapshot(['preview', candidate], { maxDiffPixels: 0 })
        break
      } catch (error) {
        if (candidates.indexOf(candidate) === candidates.length - 1) throw error
      }
    }
    await expect(target).toBeVisible()`
    const result = validator.validate(buildScript(stepBody, helpers), {
      testCase,
    })

    expect(result.warnings.map((issue) => issue.code)).toContain(
      'FIXED_WAIT_DISCOURAGED',
    )
  })
})
