/**
 * 验证 SKILL.md 的正文契约、固定文件原子保存、来源元数据和版本冲突。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  FileSkillDocumentRepository,
  collectSkillDocumentDiagnostics,
  createSkill,
} from '../src/index'
import {
  createDefaultE2ETestCase,
  isBlockingDiagnostic,
  type IE2ETestCase,
} from '@charlie_deng/e2e-assistant-types'

const tempDirectories: string[] = []

/**
 * v15 起校验统一走收集入口（永不抛错），「校验失败」由诊断表达。
 *
 * 本文件原有的 `toThrow` 断言编码的是「首个错误即抛」的旧契约；迁移后统一用
 * 下面的辅助函数断言**是否报出某类问题**，测试意图（这份文档是否被拦下）不变。
 */

/**
 * 取出本次校验的全部诊断消息，供「是否报出某类问题」的断言使用。
 *
 * @param content - 待校验正文。
 * @param testCase - 结构化用例。
 * @returns 诊断消息列表。
 */
function diagnosticsOf (
  content: string,
  testCase: Parameters<typeof collectSkillDocumentDiagnostics>[1],
): string[] {
  return collectSkillDocumentDiagnostics(content, testCase).diagnostics.map(
    (diagnostic) => diagnostic.message,
  )
}

/**
 * 判断文档是否**通过校验**（无任何诊断）。
 *
 * 交付给下游（脚本生成）的就绪门槛要求零诊断，而写入门禁只拦阻断族；
 * 测试按各自要表达的门槛选用。
 *
 * @param content - 待校验正文。
 * @param testCase - 结构化用例。
 * @returns 无任何诊断时返回 true。
 */
function passesValidation (
  content: string,
  testCase: Parameters<typeof collectSkillDocumentDiagnostics>[1],
): boolean {
  return (
    collectSkillDocumentDiagnostics(content, testCase).diagnostics.length === 0
  )
}

function buildContent (title: string, description: string): string {
  return `---
name: ${title}
description: ${description}
---

# 测试目标

${description}

## 执行上下文

- 目标 URL：\`https://example.test/login\`

## 前置条件

1. 测试环境可访问。

## 测试步骤

1. **打开登录页面**
   - 操作：访问登录页。
   - 预期结果：登录页面正常展示。

## 执行注意事项

- 当前阶段不会运行 Playwright 测试。
`
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('SKILL.md 固定文件仓储', () => {
  it('校验候选并在确认后保存 SKILL.md', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-skill-document-'),
    )
    tempDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: '登录Skill',
      description: '验证用户可以登录。',
    })
    const skillId = created.skillManifest.id
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId,
        title: '登录Skill',
        description: '验证用户可以登录。',
      }),
      baseUrl: 'https://example.test/login',
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: '打开登录页面',
          action: '访问登录页。',
          expectedResult: '登录页面正常展示。',
          testData: {},
          enabled: true,
        },
      ],
    }
    const content = buildContent(testCase.title, testCase.description)
    expect(collectSkillDocumentDiagnostics(content, testCase).content).toBe(
      content,
    )

    const repository = new FileSkillDocumentRepository({ rootDir })
    const saved = await repository.save(
      skillId,
      content,
      'sha256:' + 'a'.repeat(64),
      null,
    )
    expect(saved.relativePath).toBe('SKILL.md')
    expect(
      await readFile(
        path.join(created.skillDirectoryPath, 'SKILL.md'),
        'utf-8',
      ),
    ).toBe(content)
    expect((await repository.getState(skillId, saved.sourceHash)).status).toBe(
      'current',
    )
  })

  it('v10 移除用例敏感数据检查后放行含明文测试数据的用例文档', () => {
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录Skill',
        description: '验证用户可以登录。',
      }),
      baseUrl: 'https://example.test/login',
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: '打开登录页面',
          action: '访问登录页。',
          expectedResult: '登录页面正常展示。',
          testData: { password: '123456' },
          enabled: true,
        },
      ],
    }

    // v10 D4/D5：用例侧的敏感词拦截已正式移除；checkSensitiveContent（K1 明文
    // 凭据扫描）只针对**正文**，测试数据中的明文不再影响文档校验。
    expect(
      passesValidation(
        buildContent(testCase.title, testCase.description),
        testCase,
      ),
    ).toBe(true)
  })

  it('v12 多行字段经 Markdown 列表缩进后仍判定为已覆盖', () => {
    // 复现 v12 线上缺陷：用例的 action / expectedResult 是多行文本，
    // 写进 `- 操作：` 列表项时续行必须缩进，行尾还可能残留不可见空格。
    // 这些纯格式差异不应被判成「未覆盖」。
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '打印测试',
        description: '验证打印模板切换与对比。',
      }),
      baseUrl: 'http://localhost:5500/app/tpl',
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: '截取弹出框为图片并进行对比',
          action:
            '对弹出框内容进行截图。\n如果目录不存在则创建。\n将截图与基准图片对比。',
          // 第 2 行结尾带一个不可见空格，模型与用户都无从察觉。
          expectedResult:
            '保存截图。\n如果基准图片存在，则按规则对比： \n- 有差异记录下来。',
          testData: {},
          enabled: true,
        },
      ],
    }

    // 正文按 Markdown 列表要求缩进续行（5 空格），并去掉了字段里的行尾空格。
    const content = `---
name: 打印测试
description: 验证打印模板切换与对比。
---

# 测试目标

验证打印模板切换与对比。

## 执行上下文

- 目标 URL：\`http://localhost:5500/app/tpl\`

## 前置条件

1. 本地打印服务已启动。

## 测试步骤

1. **截取弹出框为图片并进行对比**
   - 操作：

     \`\`\`text
     对弹出框内容进行截图。
     如果目录不存在则创建。
     将截图与基准图片对比。
     \`\`\`

   - 测试数据：无。
   - 预期结果：

     \`\`\`text
     保存截图。
     如果基准图片存在，则按规则对比：
     - 有差异记录下来。
     \`\`\`

## 执行注意事项

- 当前文档描述测试用例执行要求，不包含 Playwright 脚本。
`
    expect(passesValidation(content, testCase)).toBe(true)
  })

  it('v12 代码块内的加粗枚举行不被误当成步骤标题', () => {
    // 代码块承载 action 原文时，块内可能出现 `1. **xxx**` 这类与步骤标题同形的行。
    // 标题提取必须跳过代码块，否则后续标题比对会错位，
    // 报出与真实原因无关的「顺序或标题不一致」。
    const step = (
      id: string,
      order: number,
      description: string,
      action: string,
    ) => ({
      id,
      order,
      description,
      action,
      expectedResult: '弹框展示。',
      testData: {},
      enabled: true,
    })
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '打印测试',
        description: '验证打印模板切换。',
      }),
      baseUrl: 'http://localhost:5500/app/tpl',
      steps: [
        step(
          'step_1',
          1,
          '打开预览',
          '点击预览按钮，包含以下子步骤：\n1. **点击预览**\n2. **等待弹框**',
        ),
        step('step_2', 2, '截取弹出框为图片', '对弹框截图。'),
      ],
    }

    // 围栏按列表项缩进；块内刻意保留与标题同形的加粗枚举行。
    const content = `---
name: 打印测试
description: 验证打印模板切换。
---

# 测试目标

验证打印模板切换。

## 执行上下文

- 目标 URL：\`http://localhost:5500/app/tpl\`

## 前置条件

无特殊前置条件。

## 测试步骤

1. **打开预览**
   - 操作：

     \`\`\`text
     点击预览按钮，包含以下子步骤：
     1. **点击预览**
     2. **等待弹框**
     \`\`\`

   - 测试数据：无。
   - 预期结果：

     \`\`\`text
     弹框展示。
     \`\`\`

2. **截取弹出框为图片**
   - 操作：

     \`\`\`text
     对弹框截图。
     \`\`\`

   - 测试数据：无。
   - 预期结果：

     \`\`\`text
     弹框展示。
     \`\`\`

## 执行注意事项

- 当前文档描述测试用例执行要求，不包含 Playwright 脚本。
`
    expect(passesValidation(content, testCase)).toBe(true)
  })

  it('v12 未闭合的代码围栏不会让校验器误收后续标题', () => {
    // 容错取向：围栏未闭合时视为延伸至文末，宁可少识别标题，
    // 也不把代码块内容误当成文档结构。
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '打印测试',
        description: '验证打印模板切换。',
      }),
      baseUrl: 'http://localhost:5500/app/tpl',
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: '打开预览',
          action: '点击预览按钮。',
          expectedResult: '弹框展示。',
          testData: {},
          enabled: true,
        },
      ],
    }
    // 缺少第二个步骤标题（被未闭合围栏吞掉）→ 应报「未覆盖全部启用步骤」。
    const content = `---
name: 打印测试
description: 验证打印模板切换。
---

# 测试目标

验证打印模板切换。

## 执行上下文

- 目标 URL：\`http://localhost:5500/app/tpl\`

## 前置条件

无特殊前置条件。

## 测试步骤

\`\`\`text
1. **打开预览**
   - 操作：点击预览按钮。
   - 预期结果：弹框展示。
\`\`\`

## 执行注意事项

- 当前文档描述测试用例执行要求，不包含 Playwright 脚本。
`
    expect(
      collectSkillDocumentDiagnostics(content, testCase).diagnostics.map(
        (d) => d.message,
      ),
    ).toContainEqual(expect.stringContaining('未覆盖全部启用测试步骤'))
  })

  it('v12 仍拒绝真正未覆盖的步骤内容', () => {
    // 放宽的只是「行首缩进 / 行尾空白」这类不可见差异，
    // 内容缺失、行序颠倒这类真实覆盖问题必须继续拦截。
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '打印测试',
        description: '验证打印模板切换与对比。',
      }),
      baseUrl: 'http://localhost:5500/app/tpl',
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: '截取弹出框为图片并进行对比',
          action: '第一行内容。\n第二行内容。',
          expectedResult: '期望结果。',
          testData: {},
          enabled: true,
        },
      ],
    }
    const buildContent = (actionLines: string) => `---
name: 打印测试
description: 验证打印模板切换与对比。
---

# 测试目标

验证打印模板切换与对比。

## 执行上下文

- 目标 URL：\`http://localhost:5500/app/tpl\`

## 前置条件

1. 本地打印服务已启动。

## 测试步骤

1. **截取弹出框为图片并进行对比**
   - 操作：${actionLines}
   - 测试数据：无。
   - 预期结果：期望结果。

## 执行注意事项

- 当前文档描述测试用例执行要求，不包含 Playwright 脚本。
`

    // 少了一行 → 未完整覆盖。
    expect(
      diagnosticsOf(buildContent('第一行内容。'), testCase),
    ).toContainEqual(expect.stringContaining('未完整覆盖步骤'))

    // 行序颠倒 → 「按原顺序连续出现」不成立，同样拒绝。
    expect(
      diagnosticsOf(buildContent('第二行内容。\n第一行内容。'), testCase),
    ).toContainEqual(expect.stringContaining('未完整覆盖步骤'))
  })

  it('v15 吸收引号异形与个别转录笔误，不再误判为未覆盖', () => {
    // 复现线上缺陷：模型原文照抄长中文时，稳定产生两类非语义差异——
    //   1. 排版异形：用例里的中文右引号 ” 被写成英文 "；
    //   2. 逐字笔误：长句里漏掉一个字母（baseline → basline）。
    // 二者都不改变语义，不应让生成任务失败（此前 4 次生成失败 2 次）。
    const description =
      '本地开发模式在的打印测试，用于测试最新打印版本是否功能正常。' +
      '当用户提到"打印测试"、“测试打印”时调用当前 SKILL.'
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '打印测试',
        description,
      }),
      baseUrl: 'http://localhost:5500/app/tpl',
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: '截取弹出框内容区域',
          action:
            '如果baseline_img 不存在或baseline_img 中不存在以当前打印模板id 命名的图片。',
          expectedResult: '按规则保存截图。',
          testData: {},
          enabled: true,
        },
      ],
    }

    // frontmatter 的 description 改写了引号；步骤 action 漏了一个字母 e。
    const content = `---
name: 打印测试
description: 本地开发模式在的打印测试，用于测试最新打印版本是否功能正常。当用户提到"打印测试"、“测试打印"时调用当前 SKILL.
---

# 测试目标

${description}

## 执行上下文

- 目标 URL：\`http://localhost:5500/app/tpl\`

## 前置条件

1. 本地打印服务已启动。

## 测试步骤

1. **截取弹出框内容区域**
   - 操作：

     \`\`\`text
     如果basline_img 不存在或baseline_img 中不存在以当前打印模板id 命名的图片。
     \`\`\`

   - 测试数据：无。
   - 预期结果：按规则保存截图。

## 执行注意事项

- 当前文档描述测试用例执行要求，不包含 Playwright 脚本。
`
    expect(passesValidation(content, testCase)).toBe(true)
  })

  it('v15 仍拒绝语义被改写的字段（放宽下限边界）', () => {
    // 相似度阈值只吸收个别字符差异；整句被改写必须继续拦截，
    // 否则「原文照抄」这条规则会被架空。
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '打印测试',
        description: '验证打印模板切换与对比。',
      }),
      baseUrl: 'http://localhost:5500/app/tpl',
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: '切换打印模板',
          action: '在顶部找到切换打印模板的下拉框，找到需要测试的打印模板。',
          expectedResult: '画布内容区域有内容。',
          testData: {},
          enabled: true,
        },
      ],
    }
    const buildContent = (action: string) => `---
name: 打印测试
description: 验证打印模板切换与对比。
---

# 测试目标

验证打印模板切换与对比。

## 执行上下文

- 目标 URL：\`http://localhost:5500/app/tpl\`

## 前置条件

1. 本地打印服务已启动。

## 测试步骤

1. **切换打印模板**
   - 操作：${action}
   - 测试数据：无。
   - 预期结果：画布内容区域有内容。

## 执行注意事项

- 当前文档描述测试用例执行要求，不包含 Playwright 脚本。
`

    // 语义被改写（同长度、不同措辞）→ 相似度低于阈值，必须拒绝。
    expect(
      diagnosticsOf(
        buildContent(
          '在底部找到修改打印模板的输入框，找到需要审核的打印模板。',
        ),
        testCase,
      ),
    ).toContainEqual(expect.stringContaining('未完整覆盖步骤'))
  })

  it('拒绝外部修改后的旧版本确认保存', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-skill-document-conflict-'),
    )
    tempDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: '冲突Skill',
      description: '验证冲突。',
    })
    const repository = new FileSkillDocumentRepository({ rootDir })
    const first = await repository.save(
      created.skillManifest.id,
      buildContent('冲突Skill', '验证冲突。'),
      'sha256:' + 'b'.repeat(64),
      null,
    )
    await expect(
      repository.save(
        created.skillManifest.id,
        buildContent('冲突Skill', '验证冲突。'),
        'sha256:' + 'b'.repeat(64),
        null,
      ),
    ).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
    expect(first.version).toHaveLength(64)
  })
})

describe('诊断分级不变式（v15）', () => {
  /**
   * 这组测试守护的是「阻断判定按码分族」这一不变式：安全族必须阻断、质量族必须不阻断。
   * 任何把安全码误降为 warning、或把质量码误标为 error 的改动都会在这里失败——
   * 前者是静默的安全漏洞，后者是用户体验回归，两者都不该靠人工 review 兜住。
   */
  function buildCoveredTestCase (): IE2ETestCase {
    const base = createDefaultE2ETestCase({
      skillId: 'abcdef123',
      title: '登录测试',
      description: '验证登录。',
    })
    return {
      ...base,
      baseUrl: 'https://example.test/login',
      steps: [
        {
          id: 'step_1',
          order: 1,
          description: '打开登录页面',
          action: '访问登录页。',
          expectedResult: '登录页面正常展示。',
          testData: {},
          enabled: true,
        },
      ],
    }
  }

  it('质量族诊断一律不阻断写入，且以 warning 发出', () => {
    const testCase = buildCoveredTestCase()
    // 缺章节 + frontmatter 不一致 + 目标地址缺失：三类质量族问题同时命中。
    const content =
      '---\nname: 别的名字\ndescription: 别的描述\n---\n\n正文而已。\n'
    const diagnostics = collectSkillDocumentDiagnostics(
      content,
      testCase,
    ).diagnostics

    expect(diagnostics.length).toBeGreaterThan(0)
    for (const diagnostic of diagnostics) {
      expect(isBlockingDiagnostic(diagnostic)).toBe(false)
      expect(diagnostic.severity).toBe('warning')
    }
  })

  it('明文凭据命中必须阻断，且以 error 发出', () => {
    const testCase = buildCoveredTestCase()
    const content = buildContent(testCase.title, testCase.description).replace(
      '## 执行注意事项',
      'api_key: sk-abcdefghijklmnopqrstuvwxyz\n\n## 执行注意事项',
    )

    // 该文档其余部分完整，只多出一行明文凭据 → 诊断应当只有凭据这一条。
    const diagnostics = collectSkillDocumentDiagnostics(
      content,
      testCase,
    ).diagnostics
    const sensitive = diagnostics.filter(
      (diagnostic) => diagnostic.code === 'SKILL_DOCUMENT_SENSITIVE_CONTENT',
    )

    expect(sensitive).toHaveLength(1)
    expect(sensitive[0]?.severity).toBe('error')
    expect(isBlockingDiagnostic(sensitive[0]!)).toBe(true)
  })

  it('纯空白文档必须阻断（zod 的 min(1) 挡不住空白）', () => {
    const testCase = buildCoveredTestCase()
    const diagnostics = collectSkillDocumentDiagnostics(
      '   \n\n  ',
      testCase,
    ).diagnostics

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.code).toBe('SKILL_DOCUMENT_EMPTY')
    expect(isBlockingDiagnostic(diagnostics[0]!)).toBe(true)
  })

  it('收集入口永不抛错，且始终返回可用的规范化正文', () => {
    const testCase = buildCoveredTestCase()
    const result = collectSkillDocumentDiagnostics('随便写点什么', testCase)

    expect(result.content.length).toBeGreaterThan(0)
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.environmentVariables).toEqual([])
  })

  it('通过校验的文档零诊断，且解出环境变量', () => {
    const testCase = buildCoveredTestCase()
    // 覆盖判定要求用例字段的原文出现在正文中，故用例与正文必须同源构造。
    testCase.steps[0]!.action = '用 ${ENV:E2E_USERNAME} 访问登录页。'
    const content = buildContent(testCase.title, testCase.description).replace(
      '访问登录页。',
      '用 ${ENV:E2E_USERNAME} 访问登录页。',
    )

    const result = collectSkillDocumentDiagnostics(content, testCase)

    expect(result.diagnostics).toEqual([])
    expect(result.environmentVariables).toEqual(['E2E_USERNAME'])
  })
})
