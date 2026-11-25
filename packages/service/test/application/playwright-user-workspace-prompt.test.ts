/**
 * 生成 prompt 的 userWorkSpace 上下文块断言（v14 §12.4-1，场景 9）。
 *
 * PRD 5.1：客户端请求生成或更新 Playwright 脚本时，prompt 必须包含
 * userWorkSpace 的存在、用途与写入边界说明；技术方案 §7.1 追加执行期
 * SKILL_USER_WORKSPACE 注入说明。本测试用 fake 会话运行器捕获真实 prompt。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IE2ETestCase } from '@charlie_deng/e2e-assistant-types'
import { createPlaywrightScriptGenerator } from '../../src/application/e2e-test-case/playwright-script-generator'

/** 临时目录清单（afterEach 统一清理）。 */
const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

/** 构造最小用例。 */
function createTestCase (): IE2ETestCase {
  return {
    id: 'case_v14',
    schemaVersion: '1.0',
    title: '导出并保存产物',
    description: '',
    baseUrl: 'https://example.test',
    tags: [],
    preconditions: [],
    steps: [],
  }
}

describe('生成 prompt 的 userWorkSpace 上下文（PRD 5.1，场景 9）', () => {
  it('包含 userWorkSpace 说明块与 SKILL_USER_WORKSPACE 注入说明', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'authine-v14-prompt-'),
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

    const prompts: string[] = []
    const generator = createPlaywrightScriptGenerator({
      workspace,
      sessionRunner: {
        async run (input: { prompt: string }) {
          prompts.push(input.prompt)
          await writeFile(
            targetFile,
            "import { test } from '@playwright/test'\n",
            'utf8',
          )
          return { finalText: '完成。' }
        },
      } as never,
    })

    await generator.generate(
      {
        testCase: createTestCase(),
        skillDocumentContent: '# doc',
        targetFile,
        sessionId: 'v14-prompt-session',
      },
      { signal: new AbortController().signal },
    )

    const prompt = prompts[0] ?? ''

    // PRD 5.1 推荐文案的关键句逐项断言。
    expect(prompt).toContain('当前 Skill 根目录下存在固定目录 userWorkSpace')
    expect(prompt).toContain('截图、基准图片、差异图、导出文件和其他测试资源')
    expect(prompt).toContain('node:fs')
    expect(prompt).toContain('userWorkSpace 根目录本身不可删除、不可重命名')
    expect(prompt).toContain('视觉基准默认目录是 `userWorkSpace/baselines`')
    expect(prompt).toContain('AskUserQuestion')
    // §7.1 追加的执行期注入说明（W38/A16）。
    expect(prompt).toContain('SKILL_USER_WORKSPACE')
    expect(prompt).toContain('不得使用绝对路径')

    // 与 temp/ 不混淆（A2）：唯一写入目标仍是候选脚本路径。
    expect(prompt).toContain(targetFile)
  })
})
