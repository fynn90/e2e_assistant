/**
 * 验证 SKILL.md 生成器经会话端口驱动生成，并保持 prompt 与工具守卫契约。
 *
 * 会话承载（agent-work 运行时）由 infra 层的适配器负责，其行为在
 * agent-work-runtime 测试中单独覆盖；本用例聚焦生成器自身的契约。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  FileE2ETestCaseRepository,
  createSkill,
} from '@authine-e2e-agent/skill-manager'
import { createSkillMarkdownGenerator } from '../../src/application/e2e-test-case/skill-markdown-generator'

/** 用例创建的临时工作区，测试结束后统一清理。 */
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('SKILL.md Agent 生成器', () => {
  it('向会话端口传递会话 ID、标题、prompt 与受限写入守卫，并读回 Agent 产物', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-cli-agent-write-'),
    )
    temporaryDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: 'Agent写入测试',
      description: '验证 Agent 可以写入测试用例文档。',
    })
    const repository = new FileE2ETestCaseRepository({ rootDir })
    const initial = await repository.findBySkillId(created.skillManifest.id)
    const saved = await repository.save(
      created.skillManifest.id,
      {
        ...initial.testCase,
        baseUrl: 'https://example.test/login',
        steps: [
          {
            id: 'step_login',
            order: 1,
            description: '打开登录页面',
            action: '访问登录页面。',
            expectedResult: '登录页面正常展示。',
            testData: {},
            enabled: true,
          },
        ],
      },
      initial.version,
    )
    const content = `---
name: Agent写入测试
description: 验证 Agent 可以写入测试用例文档。
---

# 测试目标

验证 Agent 可以写入测试用例文档。

## 执行上下文

- 目标 URL：\`https://example.test/login\`

## 前置条件

无特殊前置条件。

## 测试步骤

1. **打开登录页面**
   - 操作：访问登录页面。
   - 测试数据：无。
   - 预期结果：登录页面正常展示。

## 执行注意事项

- 当前阶段只生成并保存 SKILL.md，不会运行 Playwright 测试。
`
    const targetFile = path.join(created.skillDirectoryPath, 'SKILL.md')
    const sessionId = 'generation-test-session'
    // fake 会话运行器：捕获生成器交给端口的入参，并模拟 Agent 写入产物。
    // 真实的 Agent 工具循环由 agent 包自身测试覆盖，此处聚焦生成器契约。
    const runs: Array<{
      sessionId: string
      title: string
      prompt: string
      guardBlocksBash: boolean
      guardBlocksOtherFile: boolean
      guardAllowsWorkspaceRead: boolean
      guardBlocksOtherSkillRead: boolean
      guardBlocksOutsideRead: boolean
    }> = []
    const generator = createSkillMarkdownGenerator({
      workspace: rootDir,
      sessionRunner: {
        async run(input) {
          const guard = input.toolGuard
          runs.push({
            sessionId: input.sessionId,
            title: input.title,
            prompt: input.prompt,
            guardBlocksBash:
              (await guard.beforeCall?.({
                name: 'bash',
                args: { command: 'rm -rf /' },
              } as never)) !== undefined,
            guardBlocksOtherFile:
              (await guard.beforeCall?.({
                name: 'write',
                args: { path: path.join(rootDir, 'other.txt') },
              } as never)) !== undefined,
            // 系统提示词要求改文件前先 read：v11 A1 起 read 范围收紧为
            // 当前 Skill 目录（工作区内但 Skill 外的文件同样被阻断）。
            guardAllowsWorkspaceRead:
              (await guard.beforeCall?.({
                name: 'read',
                args: {
                  path: path.join(
                    created.skillDirectoryPath,
                    'e2e_schema.json',
                  ),
                },
              } as never)) === undefined,
            // A1（AC-10）：读取工作区内其他 Skill 的文件被拒绝。
            guardBlocksOtherSkillRead:
              (await guard.beforeCall?.({
                name: 'read',
                args: {
                  path: path.join(rootDir, 'skills', 'a', 'e2e_schema.json'),
                },
              } as never)) !== undefined,
            guardBlocksOutsideRead:
              (await guard.beforeCall?.({
                name: 'read',
                args: { path: '..' },
              } as never)) !== undefined,
          })
          // 模拟 Agent 的 write 工具落盘。
          await writeFile(targetFile, content, 'utf8')
          return {}
        },
      },
    })

    const stages: string[] = []
    const result = await generator.generate(
      {
        testCase: saved.testCase,
        targetDirectory: created.skillDirectoryPath,
        sessionId,
      },
      {
        signal: new AbortController().signal,
        onProgress: (stage) => stages.push(stage),
      },
    )

    expect(stages).toEqual(['requesting-model', 'writing-skill'])
    expect(result.content).toBe(content)
    await expect(readFile(targetFile, 'utf8')).resolves.toBe(content)
    // 生成器把会话 ID、标题、prompt 与守卫一并交给端口。
    expect(runs[0]?.sessionId).toBe(sessionId)
    expect(runs[0]?.title).toBe('生成 SKILL.md')
    // 应用层只表达业务意图与目标文件；Skill 加载与工具名属于 agent 侧知识，
    // 由系统提示词中的技能列表驱动，CLI 不得点名。
    expect(runs[0]?.prompt).toContain(targetFile)
    expect(runs[0]?.prompt).toContain('SKILL.md')
    expect(runs[0]?.prompt).not.toContain('load_skill')
    expect(runs[0]?.prompt).not.toContain('test_case_Skill_document')
    // 守卫拦截非白名单工具与白名单外的写入目标。
    expect(runs[0]?.guardBlocksBash).toBe(true)
    expect(runs[0]?.guardBlocksOtherFile).toBe(true)
    // read 放行当前 Skill 目录内文件（v11 A1 收紧），阻断越界读取（不终止本轮）。
    expect(runs[0]?.guardAllowsWorkspaceRead).toBe(true)
    // A1（AC-10）：读取工作区内其他 Skill 的文件被拒绝。
    expect(runs[0]?.guardBlocksOtherSkillRead).toBe(true)
    expect(runs[0]?.guardBlocksOutsideRead).toBe(true)
  })

  it('Agent 未写入目标文件时抛出 LLM_INVALID_RESPONSE', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-cli-agent-missing-'),
    )
    temporaryDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: '缺失产物测试',
      description: '验证 Agent 未落盘时的错误语义。',
    })
    const generator = createSkillMarkdownGenerator({
      workspace: rootDir,
      // 模拟 Agent 本轮结束但没写任何文件。
      sessionRunner: {
        async run() {
          return {}
        },
      },
    })

    await expect(
      generator.generate(
        {
          testCase: (
            await new FileE2ETestCaseRepository({ rootDir }).findBySkillId(
              created.skillManifest.id,
            )
          ).testCase,
          targetDirectory: created.skillDirectoryPath,
          sessionId: 'missing-artifact-session',
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' })
  })
})
