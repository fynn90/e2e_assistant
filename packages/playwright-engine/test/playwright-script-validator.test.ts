/** 验证 Playwright AST 校验器的安全策略、结构规则和步骤覆盖。 */

import { describe, expect, it } from 'vitest'
import { createPlaywrightEngine } from '../src/engine'
import type { IValidationTestCase } from '../src/contracts/validation'
import { PlaywrightScriptValidator } from '../src/validation/playwright-script-validator'

const testCase: IValidationTestCase = {
  title: '用户登录成功',
  baseUrl: 'https://example.test',
  description: '验证登录。',
  tags: [],
  preconditions: [],
  steps: [
    {
      id: 'step_login',
      order: 1,
      description: '登录',
      action: '点击登录按钮',
      expectedResult: '进入工作台',
      testData: {},
      enabled: true,
    },
  ],
}

const validCode = `
import { test, expect } from '@playwright/test'

test('用户登录成功', async ({ page }) => {
  await page.goto('https://example.test')
  await test.step('step_login', async () => {
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/dashboard/)
  })
})
`

describe('PlaywrightScriptValidator', () => {
  it('accepts and formats a safe fully-covered script', () => {
    const result = new PlaywrightScriptValidator().validate(validCode, {
      testCase,
    })

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.stepCoverage).toEqual([
      { stepId: 'step_login', operations: 1, assertions: 1 },
    ])
    expect(result.code).toContain("test.step('step_login'")
  })

  it('rejects unsafe imports and dynamic execution', () => {
    const result = new PlaywrightScriptValidator().validate(
      `${validCode}\nimport { exec } from 'node:child_process'\neval('danger')\nexec('pwd')\n`,
      { testCase },
    )

    expect(result.valid).toBe(false)
    expect(result.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['IMPORT_NOT_ALLOWED', 'FORBIDDEN_API']),
    )
  })

  it('requires the page fixture and the configured Base URL origin', () => {
    const missingFixture = new PlaywrightScriptValidator().validate(
      validCode.replace('async ({ page })', 'async ()'),
      { testCase },
    )
    const wrongOrigin = new PlaywrightScriptValidator().validate(
      validCode.replace('https://example.test', 'https://attacker.test'),
      { testCase },
    )

    // v15：结构与同源问题属质量族，只提醒不阻断（`valid` 仅反映有无安全族问题）。
    expect(missingFixture.warnings.map((issue) => issue.code)).toContain(
      'PAGE_FIXTURE_REQUIRED',
    )
    expect(wrongOrigin.warnings.map((issue) => issue.code)).toContain(
      'PAGE_GOTO_TARGET_MISMATCH',
    )
    expect(missingFixture.errors).toEqual([])
    expect(wrongOrigin.errors).toEqual([])
  })

  it('requires exact environment variable references from enabled source data', () => {
    const environmentTestCase: IValidationTestCase = {
      ...testCase,
      steps: [
        {
          ...testCase.steps[0],
          action: '填写 ${ENV:E2E_PASSWORD}',
        },
      ],
    }
    const withEnvironment = validCode.replace(
      "await page.getByRole('button', { name: '登录' }).click()",
      "const password = process.env.E2E_PASSWORD\n    await page.getByLabel('密码').fill(password ?? '')",
    )
    const valid = new PlaywrightScriptValidator().validate(withEnvironment, {
      testCase: environmentTestCase,
    })
    const missing = new PlaywrightScriptValidator().validate(validCode, {
      testCase: environmentTestCase,
    })
    const extra = new PlaywrightScriptValidator().validate(
      validCode.replace(
        "await page.getByRole('button', { name: '登录' }).click()",
        "const token = process.env.EXTRA_TOKEN\n    await page.getByRole('button', { name: token }).click()",
      ),
      { testCase },
    )

    expect(valid.valid).toBe(true)
    expect(valid.environmentVariables).toEqual(['E2E_PASSWORD'])
    // v15：env 引用不一致属质量族——脚本仍可落盘，由用户在卡片上看提示。
    expect(missing.warnings.map((issue) => issue.code)).toContain(
      'ENVIRONMENT_VARIABLE_MISSING',
    )
    expect(extra.warnings.map((issue) => issue.code)).toContain(
      'ENVIRONMENT_VARIABLE_UNDECLARED',
    )
    expect(missing.errors).toEqual([])
    expect(extra.errors).toEqual([])
  })

  it('rejects computed dynamic execution and TypeScript semantic errors', () => {
    const unsafe = new PlaywrightScriptValidator().validate(
      `${validCode}\nglobalThis['eval']('danger')\n`,
      { testCase },
    )
    const semantic = new PlaywrightScriptValidator().validate(
      validCode.replace(
        "test('用户登录成功'",
        "const invalid: string = 1\n\ntest('用户登录成功'",
      ),
      { testCase },
    )

    // 动态执行是安全族：仍阻断。
    expect(unsafe.errors.map((issue) => issue.code)).toContain('FORBIDDEN_API')
    // v15：类型检查未通过属质量族，只提醒不阻断。
    expect(semantic.warnings.map((issue) => issue.code)).toContain(
      'TYPESCRIPT_SEMANTIC_ERROR',
    )
    expect(semantic.errors).toEqual([])
  })

  it('accepts unannotated callback params on page and locator APIs', () => {
    // v13：运行时 shim 曾只声明 test / expect / process，page 与 locator 落到 any，
    // 于是 page.on('console', (message) => ...) 这类回调参数被判为隐式 any 而阻断生成
    // （真实用例中被拦的是控制台错误收集器）。shim 补上最小类型边界后，
    // 回调参数可从调用处签名推断，无需逐个标注。
    const result = new PlaywrightScriptValidator().validate(
      validCode.replace(
        "await page.getByRole('button', { name: '登录' }).click()",
        [
          "page.on('console', (message) => { void message })",
          "page.on('pageerror', (error) => { void error })",
          "await page.getByRole('button', { name: '登录' }).click()",
        ].join('\n    '),
      ),
      { testCase },
    )

    expect(result.errors.map((issue) => issue.code)).not.toContain(
      'TYPESCRIPT_SEMANTIC_ERROR',
    )
    expect(result.valid).toBe(true)
  })

  it('does not reject valid Playwright call shapes with optional params', () => {
    // shim 若按固定元数声明方法（如 locator(selector)），会把真实 API 的合法多参调用
    // （locator(selector[, options])）误判为「Expected 1 arguments, but got 2」——
    // 误拒合法代码比漏报更危险。回调之外的参数一律用变参声明即为防止此点。
    const result = new PlaywrightScriptValidator().validate(
      validCode.replace(
        "await page.getByRole('button', { name: '登录' }).click()",
        [
          "await page.locator('span', { hasText: '模版id:' }).first().click()",
          "await page.getByRole('button', { name: '登录' }).click()",
        ].join('\n    '),
      ),
      { testCase },
    )

    expect(result.errors.map((issue) => issue.message)).not.toContainEqual(
      expect.stringContaining('Expected 1 arguments'),
    )
    expect(result.valid).toBe(true)
  })

  it('reports missing, duplicated and disabled step coverage as warnings', () => {
    const result = new PlaywrightScriptValidator().validate(
      validCode.replace("'step_login'", "'unknown_step'"),
      { testCase },
    )

    // v15：步骤覆盖属质量族——脚本仍写入，用户按提示确认是否偏离用例。
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['UNKNOWN_STEP_ID']),
    )
  })

  it('reports fixed waits and xpath as quality warnings', () => {
    const code = validCode.replace(
      "await page.getByRole('button', { name: '登录' }).click()",
      "await page.locator('//button').click()\n    await page.waitForTimeout(1000)",
    )
    const result = new PlaywrightScriptValidator().validate(code, { testCase })

    expect(result.valid).toBe(true)
    expect(result.warnings.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'XPATH_LOCATOR_WARNING',
        'FIXED_WAIT_DISCOURAGED',
      ]),
    )
  })

  it('exposes independent stage 0/1 capabilities without auto-starting them', async () => {
    const engine = createPlaywrightEngine()

    expect(engine.chromium).toBeDefined()
    expect(engine.browser).toBeDefined()
    expect(engine.validator).toBeInstanceOf(PlaywrightScriptValidator)
    await expect(
      engine.dryRun.run({
        workspaceDir: 'temp',
        specCode: validCode,
        baseUrl: testCase.baseUrl,
        envWhitelist: {},
      }),
    ).rejects.toMatchObject({
      code: 'DRY_RUN_FAILED',
    })
  })
})

describe('语法不可解析时的格式化安全（v15）', () => {
  /**
   * 这组用例守护的是「不可解析即不可打印」这条不变式。
   *
   * 动机是 TypeScript 打印机的两个真实行为（均经实测确认，非推测）：
   *   - 对缺失 token 会**凭空补全**：未闭合的函数体会被自动补上 `});`；
   *   - 对游离 token 会**静默丢弃**：多余的一个 `}` 直接从输出里消失。
   * 两者都会产出「语法合法但语义已被改写」的代码，因此语法错误必须阻断，
   * 且 `result.code` 必须原样返回入参，绝不能是打印机的产物。
   */
  const cases: ReadonlyArray<{ name: string; code: string }> = [
    {
      name: '未闭合的函数体不会被补全成 });',
      code: `import { test } from '@playwright/test'\n\ntest('用户登录成功', async ({ page }) => {\n  await page.goto('https://example.test')\n`,
    },
    {
      name: '多余的右花括号不会被静默丢弃',
      code: `${validCode}}\n`,
    },
    {
      name: '未闭合的模板字符串不会吞掉后续 token',
      code: "import { test } from '@playwright/test'\n\nconst a = `oops\nrequire('node:child_process')\n",
    },
  ]

  for (const testCaseItem of cases) {
    it(testCaseItem.name, () => {
      const result = new PlaywrightScriptValidator().validate(
        testCaseItem.code,
        {
          testCase,
        },
      )

      // 阻断，且写回的必须是原文——落盘内容与 Agent 写的内容逐字一致。
      expect(result.valid).toBe(false)
      expect(result.code).toBe(testCaseItem.code)
      expect(result.errors.map((issue) => issue.code)).toContain(
        'TYPESCRIPT_SYNTAX_ERROR',
      )
    })
  }

  it('语法错误时不跑后续校验器，因此解释为何它必须阻断', () => {
    // 未闭合模板会把 require(...) 吞进模板 token，AST 里看不到这个调用；
    // 若在此状态继续做安全检查，会得出「无违规」的错误结论。
    // 这条用例把该行为固定下来，防止后人误以为「语法错误也可以不阻断」。
    const result = new PlaywrightScriptValidator().validate(
      "import { test } from '@playwright/test'\n\nconst a = `oops\nrequire('node:child_process')\n",
      { testCase },
    )

    expect(result.errors.map((issue) => issue.code)).not.toContain(
      'REQUIRE_NOT_ALLOWED',
    )
  })
})
