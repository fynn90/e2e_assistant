/**
 * userWorkSpace 文件操作校验（v14）的单元测试——**模板一致性测试，最优先**。
 *
 * 它把「提示词模板 × 校验器 × shim」三方的耦合变成可回归的断言（技术方案 §13）：
 *   1. user-workspace.md 的标准模板整段喂给**完整校验器**必须零 error
 *      （import 放行、shim 零语义错误、env 豁免、污点分析通过、步骤覆盖满足）；
 *   2. 反向用例逐条覆盖污点分析的拒绝面（移除即失败验证：把污点传播逻辑退化后
 *      这些用例必须变红）。
 */

import { describe, expect, it } from 'vitest'
import type { IValidationTestCase } from '../src/contracts/validation'
import { PlaywrightScriptValidator } from '../src/validation/playwright-script-validator'
import { validateTypeScriptSemantics } from '../src/validation/typescript-semantic-validator'
import { validateUserWorkspaceFs } from '../src/validation/user-workspace-fs-validator'
import { validateForbiddenApis } from '../src/validation/forbidden-api-validator'
import { validateImportPolicy } from '../src/validation/import-policy-validator'
import { parseTypeScript } from '../src/validation/typescript-parser'

const testCase: IValidationTestCase = {
  title: '导出报表并保存产物',
  baseUrl: 'https://example.test',
  description: '验证导出。',
  tags: [],
  preconditions: [],
  steps: [
    {
      id: 'step_export',
      order: 1,
      description: '导出',
      action: '点击导出按钮',
      expectedResult: '出现成功提示',
      testData: {},
      enabled: true,
    },
  ],
}

/**
 * 技能资源 user-workspace.md 的标准模板（逐字，仅替换用例标题 / baseUrl / 步骤 id）。
 *
 * 模板与技能资源的任何一方漂移都会在此报出——这是三方耦合的回归锚点。
 */
const TEMPLATE_CODE = `import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

test('导出报表并保存产物', async ({ page }) => {
  await page.goto('https://example.test')

  await test.step('step_export', async () => {
    // —— 页面交互（保证该步骤的操作覆盖）——
    await page.getByRole('button', { name: '导出' }).click()

    // 平台注入的当前 Skill userWorkSpace 绝对路径（执行期存在，生成期只是占位语义）。
    const workspaceRoot = process.env.SKILL_USER_WORKSPACE
    if (!workspaceRoot) {
      throw new Error('缺少 SKILL_USER_WORKSPACE 环境变量，无法保存测试产物。')
    }

    // 业务相对路径必须先与根合并，再校验未逃逸 userWorkSpace（W39）。
    const target = path.resolve(workspaceRoot, 'exports/result.csv')
    const relative = path.relative(workspaceRoot, target)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('文件路径超出 userWorkSpace 边界：exports/result.csv')
    }

    // 目录由写入动作隐式创建；文件操作与断言都留在 step 体内。
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, '导出内容', 'utf-8')

    await expect(page.getByRole('status')).toBeVisible()
  })
})
`

/**
 * 用模板派生测试脚本：替换「路径派生 + fs 调用」整段（保持其余逐字）。
 *
 * 替换块从「业务相对路径必须先与根合并」注释起、到 writeFile 行止——必须覆盖
 * 原 `const target` 声明，否则反向用例的非法派生会被模板里同名的合法声明遮蔽
 * （同名变量声明只有首个进入深度表，测试会静默失去拒绝面）。
 */
function deriveFromTemplate(pathBlock: string): string {
  return TEMPLATE_CODE.replace(
    `    // 业务相对路径必须先与根合并，再校验未逃逸 userWorkSpace（W39）。
    const target = path.resolve(workspaceRoot, 'exports/result.csv')
    const relative = path.relative(workspaceRoot, target)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('文件路径超出 userWorkSpace 边界：exports/result.csv')
    }

    // 目录由写入动作隐式创建；文件操作与断言都留在 step 体内。
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, '导出内容', 'utf-8')`,
    pathBlock,
  )
}

describe('模板一致性（最优先）：user-workspace.md 标准模板 × 完整校验器', () => {
  it('标准模板整段通过完整校验（零 error）', () => {
    const result = new PlaywrightScriptValidator().validate(TEMPLATE_CODE, {
      testCase,
    })

    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('标准模板经 TS 语义校验零错误（shim 覆盖三个 Node 模块）', () => {
    expect(validateTypeScriptSemantics(TEMPLATE_CODE)).toEqual([])
  })

  it('SKILL_USER_WORKSPACE 引用不触发 ENVIRONMENT_VARIABLE_UNDECLARED（W38 豁免）', () => {
    const result = new PlaywrightScriptValidator().validate(TEMPLATE_CODE, {
      testCase,
    })

    expect(result.errors.map((issue) => issue.code)).not.toContain(
      'ENVIRONMENT_VARIABLE_UNDECLARED',
    )
    // 豁免只作用于 actual 方向：用例声明的 env 缺失仍报错（回归）。
    const declaredTestCase: IValidationTestCase = {
      ...testCase,
      steps: [{ ...testCase.steps[0], action: '使用 ${ENV:E2E_TOKEN}' }],
    }
    const missing = new PlaywrightScriptValidator().validate(TEMPLATE_CODE, {
      testCase: declaredTestCase,
    })
    // v15：env 一致性属质量族，缺失时以 warning 呈现（豁免仍只作用于 actual 方向）。
    expect(missing.warnings.map((issue) => issue.code)).toContain(
      'ENVIRONMENT_VARIABLE_MISSING',
    )
    expect(missing.errors).toEqual([])
  })
})

describe('fs 污点校验（FS_PATH_OUTSIDE_WORKSPACE / FS_WORKSPACE_ROOT_DELETE）', () => {
  it('字面量绝对路径被拒绝', () => {
    const code = deriveFromTemplate(
      `    await writeFile('/tmp/escape.txt', '导出内容', 'utf-8')`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.map((issue) => issue.code)).toContain(
      'FS_PATH_OUTSIDE_WORKSPACE',
    )
  })

  it('非根环境变量派生被拒绝', () => {
    const code = deriveFromTemplate(
      `    const target = path.resolve(process.env.OTHER_ROOT ?? '/tmp', 'x.txt')
    await writeFile(target, 'x', 'utf-8')`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.map((issue) => issue.code)).toContain(
      'FS_PATH_OUTSIDE_WORKSPACE',
    )
  })

  it('根变量之后的字面量段含 .. 被拒绝（静态可判穿越）', () => {
    const code = deriveFromTemplate(
      `    const escape = path.resolve(workspaceRoot, '../outside.txt')
    await writeFile(escape, 'x', 'utf-8')`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.map((issue) => issue.code)).toContain(
      'FS_PATH_OUTSIDE_WORKSPACE',
    )
  })

  it('无关变量与复杂表达式被拒绝（保守误拒方向）', () => {
    const code = deriveFromTemplate(
      `    const parts = ['exports', 'result.csv']
    await writeFile(parts.join('/'), 'x', 'utf-8')`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.map((issue) => issue.code)).toContain(
      'FS_PATH_OUTSIDE_WORKSPACE',
    )
  })

  it('rm 根变量本身被拒绝（FS_WORKSPACE_ROOT_DELETE，W36）', () => {
    const code = deriveFromTemplate(
      `    await rm(workspaceRoot, { recursive: true, force: true })`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.map((issue) => issue.code)).toContain(
      'FS_WORKSPACE_ROOT_DELETE',
    )
  })

  it('rm(dirname(workspaceRoot)) 被拒绝（dirname 逃出根 = Skill 根）', () => {
    const code = deriveFromTemplate(
      `    await rm(path.dirname(workspaceRoot), { recursive: true, force: true })`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.map((issue) => issue.code)).toContain(
      'FS_PATH_OUTSIDE_WORKSPACE',
    )
  })

  it('rm 根内子路径通过（根守卫只拦根本身）', () => {
    const code = deriveFromTemplate(
      `    const target = path.resolve(workspaceRoot, 'exports/result.csv')
    await rm(target, { force: true })`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues).toEqual([])
  })

  it('rename / copyFile 的两个路径位都检查', () => {
    const code = deriveFromTemplate(
      `    const target = path.resolve(workspaceRoot, 'exports/result.csv')
    await copyFile(target, '/tmp/escape.txt')`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.map((issue) => issue.code)).toContain(
      'FS_PATH_OUTSIDE_WORKSPACE',
    )
  })

  it('无根变量声明时全部 fs 调用被拒绝', () => {
    const code = deriveFromTemplate(
      `    await writeFile('exports/result.csv', '导出内容', 'utf-8')`,
    ).replace(
      `    const workspaceRoot = process.env.SKILL_USER_WORKSPACE
    if (!workspaceRoot) {
      throw new Error('缺少 SKILL_USER_WORKSPACE 环境变量，无法保存测试产物。')
    }
`,
      '',
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.length).toBeGreaterThan(0)
    expect(
      issues.every((issue) => issue.code === 'FS_PATH_OUTSIDE_WORKSPACE'),
    ).toBe(true)
  })

  it('根变量的内联 resolve/join 调用形态通过', () => {
    const code = deriveFromTemplate(
      `    await mkdir(path.resolve(workspaceRoot, 'exports'), { recursive: true })
    await writeFile(path.join(workspaceRoot, 'exports/result.csv'), 'x', 'utf-8')`,
    )
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues).toEqual([])
  })

  it('Sync 变体同样被覆盖（node:fs 形态）', () => {
    const code = deriveFromTemplate(`    writeFileSync('/tmp/escape.txt', 'x')`)
    const issues = validateUserWorkspaceFs(
      parseTypeScript(code).sourceFile,
    ).issues
    expect(issues.map((issue) => issue.code)).toContain(
      'FS_PATH_OUTSIDE_WORKSPACE',
    )
  })
})

describe('import 白名单放宽（W33/W34）', () => {
  it('三模块合法形态通过且不产生 PLAYWRIGHT_TEST_IMPORT_REQUIRED 之外的错误', () => {
    const parsed = parseTypeScript(TEMPLATE_CODE)
    const result = validateImportPolicy(parsed.sourceFile, [])
    expect(result.issues).toEqual([])
    expect(result.importsTest).toBe(true)
    expect(result.importsExpect).toBe(true)
  })

  it('node:fs 命名空间导入被拒绝', () => {
    const code = `import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import path from 'node:path'

test('t', async ({ page }) => {
  await page.goto('https://example.test')
  await test.step('s', async () => {
    void fs
    await expect(page.getByRole('button')).toBeVisible()
  })
})
`
    const result = validateImportPolicy(parseTypeScript(code).sourceFile, [])
    expect(result.issues.map((issue) => issue.code)).toContain(
      'IMPORT_NOT_ALLOWED',
    )
  })

  it('按名导入非白名单成员（open / symlink）被拒绝并附白名单说明', () => {
    const code = `import { test, expect } from '@playwright/test'
import { open, symlink } from 'node:fs/promises'

test('t', async ({ page }) => {
  await page.goto('https://example.test')
  await test.step('s', async () => {
    void open
    void symlink
    await expect(page.getByRole('button')).toBeVisible()
  })
})
`
    const issues = validateImportPolicy(
      parseTypeScript(code).sourceFile,
      [],
    ).issues
    const importIssues = issues.filter(
      (issue) => issue.code === 'IMPORT_NOT_ALLOWED',
    )
    expect(importIssues.length).toBe(2)
    expect(importIssues[0]?.message).toContain('mkdir')
  })

  it('node:os 等其他 Node 模块仍被拒绝', () => {
    const code = `import { test, expect } from '@playwright/test'
import os from 'node:os'

test('t', async ({ page }) => {
  await page.goto('https://example.test')
  await test.step('s', async () => {
    void os
    await expect(page.getByRole('button')).toBeVisible()
  })
})
`
    const result = validateImportPolicy(parseTypeScript(code).sourceFile, [])
    expect(result.issues.map((issue) => issue.code)).toContain(
      'IMPORT_NOT_ALLOWED',
    )
  })
})

describe('forbidden 清单调整（W37：fs 族解禁）', () => {
  it('writeFile / fs.rm 不再被误拦', () => {
    const code = `writeFile('a', 'b')
fs.rm('a')
writeFileSync('a', 'b')
appendFile('a', 'b')
`
    expect(validateForbiddenApis(parseTypeScript(code).sourceFile)).toEqual([])
  })

  it('child_process / eval / new Function 仍然拦截', () => {
    const code = `child_process.spawn('x')
eval('x')
new Function('x')
exec('pwd')
spawn('ls')
process.exit(0)
`
    const issues = validateForbiddenApis(parseTypeScript(code).sourceFile)
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'FORBIDDEN_API',
        'FORBIDDEN_API',
        'FORBIDDEN_API',
        'FORBIDDEN_API',
        'FORBIDDEN_API',
        'FORBIDDEN_API',
      ]),
    )
  })
})
