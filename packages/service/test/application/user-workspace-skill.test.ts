/**
 * userWorkSpace 技能资源（v14）的注册与模板一致性测试。
 *
 * 位置说明：本测试需要同时引用 agent 的技能资源与 playwright-engine 的校验器，
 * 而 agent 包不得依赖 playwright-engine，因此放在组合根 service（跨包集成测试随集成点走）。
 *
 * 两层断言（技术方案 §12.3-3 与 §13 教训「模板一致性测试应尽早写」）：
 *   1. 注册期防漏挂：compose-skill 组装后的 playwright_script_generation 技能正文
 *      必须包含 user-workspace.md 的内容（标题与关键规则锚点）；
 *   2. 模板一致性：从**真正给模型看的那份 Skill 文本**中抽取 Node 文件操作模板，
 *      整段喂给平台完整校验器必须零 error——模板 × 校验器 × shim 三方耦合的回归锚点。
 */

import { describe, expect, it } from 'vitest'
import type { IValidationTestCase } from '@fynn90-e2e_assistant/playwright-engine'
import { PlaywrightScriptValidator } from '@fynn90-e2e_assistant/playwright-engine'
import { resourceLoader } from '@fynn90-e2e_assistant/agent'

const validator = new PlaywrightScriptValidator()

/** 与文件产物步骤对应的最小用例。 */
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

/** userWorkSpace 章节在技能正文中的标题锚点。 */
const SECTION_HEADING = '## userWorkSpace：测试产物的唯一存放地'

/**
 * 从技能正文中抽取 userWorkSpace 章节的 Node 文件操作模板。
 *
 * 直接从 Skill 文本里取，而不是在测试里复制一份——保证测试锁定的是
 * **真正给模型看的那份模板**（与 visual-regression-template.test.ts 同法）。
 *
 * @returns 模板代码块正文（不含 markdown 围栏）。
 * @throws {Error} 章节或代码块缺失时抛出，提示同步更新测试。
 */
function extractUserWorkspaceTemplate (): string {
  const skill = resourceLoader.getSkill('playwright_script_generation').content
  const sectionStart = skill.indexOf(SECTION_HEADING)

  if (sectionStart < 0) {
    throw new Error(
      '未在 Skill 正文中找到 userWorkSpace 章节——user-workspace.md 可能未挂载。',
    )
  }

  const fenceStart = skill.indexOf('```ts', sectionStart)
  if (fenceStart < 0) {
    throw new Error('未在 userWorkSpace 章节中找到模板代码块。')
  }

  const fenceEnd = skill.indexOf('```', fenceStart + 5)
  if (fenceEnd < 0) {
    throw new Error('userWorkSpace 章节的模板代码块未闭合。')
  }

  return skill.slice(fenceStart + 5, fenceEnd).trim()
}

describe('user-workspace.md 的注册期防漏挂', () => {
  it('compose 后的技能正文包含 userWorkSpace 章节与关键规则锚点', () => {
    const skill = resourceLoader.getSkill(
      'playwright_script_generation',
    ).content

    expect(skill).toContain(SECTION_HEADING)
    // 关键规则锚点：任一缺失都说明章节内容被截断或漂移。
    expect(skill).toContain('process.env.SKILL_USER_WORKSPACE')
    expect(skill).toContain('node:fs/promises')
    expect(skill).toContain('不得删除 userWorkSpace 根目录')
    expect(skill).toContain('视觉基准默认目录是 `userWorkSpace/baselines`')
  })

  it('视觉回归章节包含 ask_user_question 流程（B6/B8/A13）', () => {
    const skill = resourceLoader.getSkill(
      'playwright_script_generation',
    ).content

    expect(skill).toContain('ask_user_question')
    // 目录与图片都缺时一次问完两个问题（不再依赖已删除的 missing 参数）。
    expect(skill).toContain('一次问完两个问题')
    // 选项构造规则（D7/A17）。
    expect(skill).toContain('2-5 个候选项')
    expect(skill).toContain('不得自行提供「其它」')
  })

  it('视觉回归章节承接了原平台侧的路径校验与捕获判定（校验下沉到 Skill）', () => {
    const skill = resourceLoader.getSkill(
      'playwright_script_generation',
    ).content

    // 路径规则由模型自行遵守：禁止绝对路径 / .. / 重复拼接，图片必须 .png。
    expect(skill).toContain('由你自行遵守，平台不再代校验')
    expect(skill).toContain('必须以 `.png` 结尾')
    // 默认目录候选仍是硬性要求（措辞从「平台拒绝」改为 Skill 指令）。
    expect(skill).toContain('使用默认目录 `userWorkSpace/baselines`')
    // 「使用已有基准 / 捕获新基准」的判定改由模型按存在性自行完成。
    expect(skill).toContain('使用已有基准')
    expect(skill).toContain('是否已存在基准图')
  })
})

describe('userWorkSpace 模板与平台校验器的一致性', () => {
  it('Skill 正文中的 Node 文件操作模板能通过平台完整静态校验（零 error）', () => {
    // 模板携带 <用例标题>/<baseUrl>/<步骤 id> 占位符，按测试用例代入真实值
    // （与 visual-regression-template.test.ts 的组装修配同法）。
    const template = extractUserWorkspaceTemplate()
      .replace('<用例标题>', testCase.title)
      .replace('<baseUrl>', testCase.baseUrl)
      .replace('<步骤 id>', testCase.steps[0]?.id ?? 'step_export')
    const result = validator.validate(template, { testCase })

    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    // 步骤覆盖：操作（click）与断言（toBeVisible）都在 step 体内。
    expect(result.stepCoverage).toHaveLength(1)
    expect(result.stepCoverage[0]?.operations).toBeGreaterThanOrEqual(1)
    expect(result.stepCoverage[0]?.assertions).toBeGreaterThanOrEqual(1)
  })

  it('模板保留污点分析的关键写法（反向锁定，防漂移）', () => {
    const template = extractUserWorkspaceTemplate()

    expect(template).toContain(
      'const workspaceRoot = process.env.SKILL_USER_WORKSPACE',
    )
    expect(template).toContain('if (!workspaceRoot)')
    expect(template).toContain(
      "path.resolve(workspaceRoot, 'exports/result.csv')",
    )
    expect(template).toContain("relative.startsWith('..')")
    expect(template).toContain('path.isAbsolute(relative)')
    expect(template).toContain(
      'await mkdir(path.dirname(target), { recursive: true })',
    )
    // 不出现绝对路径与穿越写法。
    expect(template).not.toMatch(/path\.resolve\('\//)
    expect(template).not.toContain('../')
  })
})
