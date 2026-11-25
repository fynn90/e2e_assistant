/**
 * 验证 Playwright 候选脚本生成器的提示词边界、Agent 说明解析与写入白名单守卫。
 *
 * 这三块都是纯逻辑，可用替身完整覆盖，无需连接模型或启动浏览器。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IE2ETestCase } from '@authine-e2e-agent/types'
import { createGenerationWriteGuard } from '../../src/application/e2e-test-case/generation-tool-guards'
import {
  createPlaywrightScriptGenerator,
  createScriptWriteOnlyToolGuard,
  parseAgentNotes,
} from '../../src/application/e2e-test-case/playwright-script-generator'

/** 用例创建的临时工作区，测试结束后统一清理。 */
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/** 构造一份结构完整的最小用例，作为生成器的输入数据。 */
function createTestCase(overrides: Partial<IE2ETestCase> = {}): IE2ETestCase {
  return {
    schemaVersion: '1.0',
    id: 'case_login',
    title: '用户使用有效账号登录成功',
    description: '验证有效用户可以进入工作台。',
    baseUrl: 'https://example.test/login',
    tags: [],
    preconditions: [],
    steps: [
      {
        id: 'step_login',
        order: 1,
        description: '提交登录',
        action: '点击登录按钮。',
        expectedResult: '进入工作台。',
        testData: {},
        enabled: true,
      },
    ],
    ...overrides,
  } as IE2ETestCase
}

describe('createPlaywrightScriptGenerator 提示词边界', () => {
  /**
   * 创建捕获 prompt 的 fake 会话运行器，并模拟 Agent 写入候选脚本。
   *
   * 必须真实写盘：生成器会从 targetFile 读回产物，
   * 只返回文本而不落盘会让用例以 LLM_INVALID_RESPONSE 失败。
   */
  function createFakeRunner(targetFile: string, code: string) {
    const runs: Array<{ prompt: string; title: string }> = []
    return {
      runs,
      runner: {
        async run(input: { prompt: string; title: string }) {
          runs.push({ prompt: input.prompt, title: input.title })
          await writeFile(targetFile, code, 'utf8')
          return { finalText: '脚本已写入。' }
        },
      },
    }
  }

  /** 在临时工作区中准备生成器与候选脚本目标路径（真实 Skill 的 temp/ 结构）。 */
  async function prepareGenerator(
    code = "import { test } from '@playwright/test'\n",
  ) {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'authine-script-prompt-'),
    )
    temporaryDirectories.push(workspace)
    const targetFile = path.join(
      workspace,
      'skills',
      'abc',
      'temp',
      'candidate.spec.ts',
    )
    await mkdir(path.dirname(targetFile), { recursive: true })
    const { runs, runner } = createFakeRunner(targetFile, code)
    const generator = createPlaywrightScriptGenerator({
      workspace,
      sessionRunner: runner as never,
    })
    return { workspace, targetFile, generator, runs }
  }

  it('提示词只表达业务意图与参数，不点名任何 Agent 工具', async () => {
    const { targetFile, generator, runs } = await prepareGenerator()

    await generator.generate(
      {
        testCase: createTestCase(),
        skillDocumentContent: '# 测试目标\n\n验证有效用户可以进入工作台。',
        targetFile,
        sessionId: 'prompt-session',
      },
      { signal: new AbortController().signal },
    )

    const prompt = runs[0]?.prompt ?? ''

    // 正向：业务意图、候选脚本写入目标与三项输入数据都必须出现。
    expect(prompt).toContain('创建')
    expect(prompt).toContain('Playwright 脚本')
    expect(prompt).toContain(targetFile)
    expect(prompt).toContain('用户使用有效账号登录成功')
    expect(prompt).toContain('验证有效用户可以进入工作台')

    // 反向：Skill 加载与页面核对属于 agent 侧规则，应用层不得点名。
    expect(prompt).not.toContain('load_skill')
    expect(prompt).not.toContain('browser_')
    // 正式脚本必须与本次写入目标区分开，避免 Agent 自行推导路径。
    expect(prompt).toContain('test.spec.ts')
  })

  it('有上一版脚本时表达更新语义，并把它作为参考传入', async () => {
    const { targetFile, generator, runs } = await prepareGenerator()

    await generator.generate(
      {
        testCase: createTestCase(),
        skillDocumentContent: '# 测试目标',
        targetFile,
        sessionId: 'update-session',
        previousCode: '// 上一版脚本：先填写用户名再提交',
      },
      { signal: new AbortController().signal },
    )

    const prompt = runs[0]?.prompt ?? ''
    expect(prompt).toContain('更新')
    expect(prompt).toContain('上一版脚本：先填写用户名再提交')
  })

  it('读回 Agent 写入的候选脚本并解析其说明', async () => {
    const code =
      "import { test } from '@playwright/test'\nexport const marker = 1\n"
    const { targetFile, generator } = await prepareGenerator(code)

    const candidate = await generator.generate(
      {
        testCase: createTestCase(),
        skillDocumentContent: '# 测试目标',
        targetFile,
        sessionId: 'readback-session',
      },
      { signal: new AbortController().signal },
    )

    expect(candidate.code).toBe(code)
    await expect(readFile(targetFile, 'utf8')).resolves.toBe(code)
  })
})

describe('parseAgentNotes', () => {
  it('解析断点、假设与警告小节', () => {
    const notes = parseAgentNotes(
      [
        '已完成脚本写入。',
        '',
        '## 断点',
        '- 用例要求输入邮箱，但页面只有手机号输入框。',
        '',
        '## 假设',
        '- 假定登录后直接进入工作台，无需二次验证。',
        '',
        '## 警告',
        '- 提交按钮的文案可能随语言切换变化。',
      ].join('\n'),
    )

    // 断点是确定性结论，必须按 warning 级别展示以引起用户注意。
    expect(notes.warnings).toEqual([
      {
        code: 'PAGE_MISMATCH',
        message: '用例要求输入邮箱，但页面只有手机号输入框。',
        severity: 'warning',
      },
      {
        code: 'GENERATION_WARNING',
        message: '提交按钮的文案可能随语言切换变化。',
        severity: 'warning',
      },
    ])
    expect(notes.assumptions).toEqual([
      '假定登录后直接进入工作台，无需二次验证。',
    ])
  })

  it('把「无」视为空小节，不产生噪声条目', () => {
    const notes = parseAgentNotes(
      ['## 断点', '无', '', '## 假设', '无。', '', '## 警告', '无'].join('\n'),
    )

    expect(notes.warnings).toEqual([])
    expect(notes.assumptions).toEqual([])
  })

  it('容忍 Agent 未按约定输出说明，不因此判定生成失败', () => {
    // 只给一段普通确认文本：解析结果为空，但流程必须继续（产物以文件为准）。
    const notes = parseAgentNotes('脚本已写入临时工作区，未发现异常。')

    expect(notes.warnings).toEqual([])
    expect(notes.assumptions).toEqual([])
  })

  it('支持有序列表并去除重复条目', () => {
    const notes = parseAgentNotes(
      ['## 假设', '1. 假定已登录', '2. 假定已登录', '3. 假定网络正常'].join(
        '\n',
      ),
    )

    expect(notes.assumptions).toEqual(['假定已登录', '假定网络正常'])
  })
})

describe('createScriptWriteOnlyToolGuard', () => {
  const workspace = process.platform === 'win32' ? 'D:\\ws' : '/ws'
  const targetFile =
    process.platform === 'win32'
      ? 'D:\\ws\\skills\\abc\\temp\\candidate.spec.ts'
      : '/ws/skills/abc/temp/candidate.spec.ts'

  it('放行 load_skill 与浏览器工具', async () => {
    const guard = createScriptWriteOnlyToolGuard(workspace, targetFile)

    // 加载生成规则与页面核对都是生成流程的必需步骤。
    await expect(
      guard.beforeCall!({ name: 'load_skill', args: {} }),
    ).resolves.toBeUndefined()
    await expect(
      guard.beforeCall!({ name: 'browser_navigate', args: {} }),
    ).resolves.toBeUndefined()
    await expect(
      guard.beforeCall!({ name: 'browser_snapshot', args: {} }),
    ).resolves.toBeUndefined()
    await expect(
      guard.beforeCall!({ name: 'browser_query', args: {} }),
    ).resolves.toBeUndefined()
  })

  it('只允许写入指定的临时候选脚本路径', async () => {
    const guard = createScriptWriteOnlyToolGuard(workspace, targetFile)

    await expect(
      guard.beforeCall!({ name: 'write', args: { path: targetFile } }),
    ).resolves.toBeUndefined()
  })

  it('阻断写入正式脚本、SKILL.md 或 Skill 目录外的路径', async () => {
    const guard = createScriptWriteOnlyToolGuard(workspace, targetFile)

    // 这些路径代表 v7 明令禁止的写入目标（PRD 4.4 / 9.3）。
    for (const forbidden of [
      process.platform === 'win32'
        ? 'D:\\ws\\skills\\abc\\test.spec.ts'
        : '/ws/skills/abc/test.spec.ts',
      process.platform === 'win32'
        ? 'D:\\ws\\skills\\abc\\SKILL.md'
        : '/ws/skills/abc/SKILL.md',
      process.platform === 'win32'
        ? 'D:\\ws\\skills\\abc\\e2e_schema.json'
        : '/ws/skills/abc/e2e_schema.json',
    ]) {
      await expect(
        guard.beforeCall!({ name: 'write', args: { path: forbidden } }),
      ).resolves.toMatchObject({ block: true })
    }
  })

  it('危险 bash 命令被阻断但不终止本轮；edit 等非白名单工具被阻断并终止', async () => {
    const guard = createScriptWriteOnlyToolGuard(workspace, targetFile)

    // v11（技术方案 D11）：bash 放开白名单，命中危险清单的命令拒绝执行但不终止本轮。
    await expect(
      guard.beforeCall!({ name: 'bash', args: { command: 'rm -rf /' } }),
    ).resolves.toMatchObject({ block: true })
    await expect(
      guard.beforeCall!({ name: 'bash', args: { command: 'node --version' } }),
    ).resolves.toBeUndefined()
    await expect(
      guard.beforeCall!({ name: 'edit', args: {} }),
    ).resolves.toMatchObject({ block: true, terminate: true })
  })

  it('放行工作区内的 read', async () => {
    const guard = createScriptWriteOnlyToolGuard(workspace, targetFile)

    // 系统提示词要求 Agent 在改文件前先 read；只读且无副作用，必须放行。
    await expect(
      guard.beforeCall!({
        name: 'read',
        args: {
          path:
            process.platform === 'win32'
              ? 'D:\\ws\\skills\\abc\\e2e_schema.json'
              : '/ws/skills/abc/e2e_schema.json',
        },
      }),
    ).resolves.toBeUndefined()
    await expect(
      guard.beforeCall!({
        name: 'read',
        args: { path: 'skills/abc/SKILL.md' },
      }),
    ).resolves.toBeUndefined()
  })

  it('阻断读取工作区外的文件，但不终止本轮', async () => {
    const guard = createScriptWriteOnlyToolGuard(workspace, targetFile)

    // 越界读是可通过改路径自行纠正的错误，不应像越权工具那样终止整轮。
    await expect(
      guard.beforeCall!({ name: 'read', args: { path: '../../etc/passwd' } }),
    ).resolves.toMatchObject({ block: true })
    await expect(
      guard.beforeCall!({
        name: 'read',
        args: {
          path:
            process.platform === 'win32'
              ? 'D:\\other\\secret.txt'
              : '/other/secret.txt',
        },
      }),
    ).resolves.toMatchObject({ block: true })
  })

  it('阻断文案不点名任何 Agent 工具', async () => {
    const guard = createScriptWriteOnlyToolGuard(workspace, targetFile)

    // 阻断原因会作为工具结果进入模型上下文；
    // 工具清单属于 agent 包的实现细节，应用层不得经此泄露。
    // （v11 起 bash 已入白名单，改用非白名单工具触发越权阻断文案。）
    const blocked = await guard.beforeCall!({ name: 'grep', args: {} })
    expect(blocked?.reason).toBeTruthy()
    expect(blocked?.reason).not.toContain('load_skill')
    expect(blocked?.reason).not.toContain('browser_')
    expect(blocked?.reason).not.toContain('write')
  })
})

describe('createGenerationWriteGuard', () => {
  const workspace = process.platform === 'win32' ? 'D:\\ws' : '/ws'
  const targetFile =
    process.platform === 'win32'
      ? 'D:\\ws\\skills\\abc\\SKILL.md'
      : '/ws/skills/abc/SKILL.md'

  it('未声明额外前缀时不放行浏览器工具', async () => {
    const guard = createGenerationWriteGuard({
      id: 'test-guard',
      workspace,
      targetFile,
      blockedToolReason: '不允许。',
    })

    // SKILL.md 生成不需要访问目标页面，不应获得浏览器能力（PRD 4.2 授权边界）。
    await expect(
      guard.beforeCall!({ name: 'browser_navigate', args: {} }),
    ).resolves.toMatchObject({ block: true, terminate: true })
  })

  it('按声明的前缀放行额外工具', async () => {
    const guard = createGenerationWriteGuard({
      id: 'test-guard',
      workspace,
      targetFile,
      extraAllowedPrefixes: ['browser_'],
      blockedToolReason: '不允许。',
    })

    await expect(
      guard.beforeCall!({ name: 'browser_query', args: {} }),
    ).resolves.toBeUndefined()
  })
})
