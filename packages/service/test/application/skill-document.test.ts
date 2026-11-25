/**
 * 验证应用服务可以通过 fake Agent 生成 SKILL.md，并按 mode 分级即时保存。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  FileE2ETestCaseRepository,
  FileSkillDocumentRepository,
  createSkill,
} from '@authine-e2e-agent/skill-manager'
import { createE2ETestCaseApplicationServices } from '../../src/application/e2e-test-case/create-services'
import type { ISkillMarkdownGenerator } from '../../src/application/e2e-test-case/skill-markdown-generator'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('SKILL.md application flow', () => {
  it('generates the document and writes it with generatedSkill metadata in generation mode', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-cli-skill-document-'),
    )
    tempDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: '登录应用服务',
      description: '验证登录流程。',
    })
    const skillId = created.skillManifest.id
    const repository = new FileE2ETestCaseRepository({ rootDir })
    const initial = await repository.findBySkillId(skillId)
    const saved = await repository.save(
      skillId,
      {
        ...initial.testCase,
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
      },
      initial.version,
    )

    const generator: ISkillMarkdownGenerator = {
      async generate(input) {
        const content = `---
name: 登录应用服务
description: 验证登录流程。
---

# 测试目标

验证登录流程。

## 执行上下文

- 目标 URL：\`https://example.test/login\`

## 前置条件

1. 测试环境可访问。

## 测试步骤

1. **打开登录页面**
   - 操作：

     \`\`\`text
     访问登录页。
     \`\`\`

   - 预期结果：

     \`\`\`text
     登录页面正常展示。
     \`\`\`

## 执行注意事项

- 当前阶段不会运行 Playwright 测试。
`
        await writeFile(
          path.join(input.targetDirectory, 'SKILL.md'),
          content,
          'utf8',
        )
        return {
          content,
          warnings: [],
          assumptions: [],
        }
      },
    }
    let receivedConfig:
      | {
          projectDirectory: string
          llmApiKey: string
          llmApiBaseUrl: string
          llmModelName: string
        }
      | undefined
    const services = createE2ETestCaseApplicationServices(
      undefined,
      (config) => {
        receivedConfig = config
        return generator
      },
    )
    const generateSkillDocument = services.generateSkillDocument
    const saveSkillDocument = services.saveSkillDocument
    expect(generateSkillDocument).toBeDefined()
    expect(saveSkillDocument).toBeDefined()

    const candidate = await generateSkillDocument!({
      config: {
        projectDirectory: rootDir,
        llmApiKey: 'fake-key',
        llmApiBaseUrl: 'https://llm.example.test/v1',
        llmModelName: 'fake-model',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      skillId,
      sessionId: 'test-generation-session',
      request: {
        expectedTestCaseFileVersion: saved.version,
        expectedSkillDocumentVersion: null,
      },
      signal: new AbortController().signal,
    })

    expect(candidate.content).toContain('# 测试目标')
    expect(receivedConfig).toMatchObject({
      projectDirectory: rootDir,
      llmApiKey: 'fake-key',
      llmApiBaseUrl: 'https://llm.example.test/v1',
      llmModelName: 'fake-model',
    })
    await expect(
      readFile(path.join(created.skillDirectoryPath, 'SKILL.md'), 'utf-8'),
    ).resolves.toContain('# 测试目标')

    const savedDocument = await saveSkillDocument!({
      rootDir,
      skillId,
      request: {
        content: candidate.content,
        sourceHash: candidate.sourceHash,
        expectedSkillDocumentVersion: candidate.skillDocumentVersion,
        mode: 'generation',
      },
    })
    expect(savedDocument.relativePath).toBe('SKILL.md')
    expect(savedDocument.diagnostics).toEqual([])
    expect(
      await readFile(
        path.join(created.skillDirectoryPath, 'SKILL.md'),
        'utf-8',
      ),
    ).toBe(candidate.content)
    // 即时保存必须同步写入 manifest.generatedSkill：脚本生成服务端会校验
    // SKILL.md 的来源哈希与当前用例一致，未写入元数据的文档会被判定为未生成而拒绝。
    const manifest = JSON.parse(
      await readFile(
        path.join(created.skillDirectoryPath, 'manifest.json'),
        'utf-8',
      ),
    )
    expect(manifest.generatedSkill.sourceHash).toBe(candidate.sourceHash)
  })

  it('writes user-edited content with diagnostics in edit mode', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-cli-skill-document-edit-'),
    )
    tempDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: '编辑应用服务',
      description: '验证用户手改实时保存。',
    })
    const skillId = created.skillManifest.id
    const repository = new FileE2ETestCaseRepository({ rootDir })
    const initial = await repository.findBySkillId(skillId)
    await repository.save(
      skillId,
      {
        ...initial.testCase,
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
      },
      initial.version,
    )

    const generator: ISkillMarkdownGenerator = {
      async generate(input) {
        const content = `---
name: 编辑应用服务
description: 验证用户手改实时保存。
---

# 测试目标

验证用户手改实时保存。

## 执行上下文

- 目标 URL：\`https://example.test/login\`

## 前置条件

1. 测试环境可访问。

## 测试步骤

1. **打开登录页面**
   - 操作：

     \`\`\`text
     访问登录页。
     \`\`\`

   - 预期结果：

     \`\`\`text
     登录页面正常展示。
     \`\`\`

## 执行注意事项

- 当前阶段不会运行 Playwright 测试。
`
        await writeFile(
          path.join(input.targetDirectory, 'SKILL.md'),
          content,
          'utf8',
        )
        return { content, warnings: [], assumptions: [] }
      },
    }
    const services = createE2ETestCaseApplicationServices(
      undefined,
      () => generator,
    )
    const candidate = await services.generateSkillDocument!({
      config: {
        projectDirectory: rootDir,
        llmApiKey: 'fake-key',
        llmApiBaseUrl: 'https://llm.example.test/v1',
        llmModelName: 'fake-model',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      skillId,
      sessionId: 'test-edit-session',
      request: {
        expectedTestCaseFileVersion: (await repository.findBySkillId(skillId))
          .version,
        expectedSkillDocumentVersion: null,
      },
      signal: new AbortController().signal,
    })

    const savedDocument = await services.saveSkillDocument!({
      rootDir,
      skillId,
      request: {
        content: candidate.content,
        sourceHash: candidate.sourceHash,
        expectedSkillDocumentVersion: candidate.skillDocumentVersion,
        mode: 'generation',
      },
    })

    // 用户手改：把正文改成结构不完整的中间态（缺少必需章节）。
    const editedContent = `${candidate.content}\n\n## 用户补充\n\n临时笔记，稍后整理。\n`
    const editResult = await services.saveSkillDocument!({
      rootDir,
      skillId,
      request: {
        content: editedContent,
        sourceHash: candidate.sourceHash,
        expectedSkillDocumentVersion: savedDocument.version,
        mode: 'edit',
      },
    })

    // edit 模式：结构诊断不阻断写入，磁盘内容为用户提交的正文。
    expect(editResult.diagnostics).toEqual([])
    expect(
      await readFile(
        path.join(created.skillDirectoryPath, 'SKILL.md'),
        'utf-8',
      ),
    ).toContain('用户补充')
  })

  it('rejects structurally invalid content in generation mode', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-cli-skill-document-invalid-'),
    )
    tempDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: '严格校验用例',
      description: '验证 generation 模式阻断。',
    })
    const skillId = created.skillManifest.id
    const repository = new FileE2ETestCaseRepository({ rootDir })
    const initial = await repository.findBySkillId(skillId)
    await repository.save(
      skillId,
      {
        ...initial.testCase,
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
      },
      initial.version,
    )
    const services = createE2ETestCaseApplicationServices(undefined, () => {
      throw new Error('本用例不触发 Agent 生成。')
    })
    const latest = await repository.findBySkillId(skillId)

    // v15：结构不完整属质量族——**写入成功**，问题以诊断呈现给用户。
    const saved = await services.saveSkillDocument!({
      rootDir,
      skillId,
      request: {
        content:
          '---\nname: 严格校验用例\ndescription: 验证 generation 模式阻断。\n---\n\n# 测试目标\n\n内容不完整。\n',
        sourceHash: latest.sourceHash,
        expectedSkillDocumentVersion: null,
        mode: 'generation',
      },
    })

    expect(saved.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'SKILL_DOCUMENT_SECTION_MISSING',
    )
    // 内容确实落盘了——这才是「确保 Agent 的内容都能写入」。
    const written = await new FileSkillDocumentRepository({
      rootDir,
    }).findBySkillId(skillId)
    expect(written?.content).toContain('内容不完整。')
  })

  it('still blocks plaintext credentials in generation mode', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-cli-skill-document-secret-'),
    )
    tempDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: '凭据用例',
      description: '验证凭据仍阻断。',
    })
    const skillId = created.skillManifest.id
    const repository = new FileE2ETestCaseRepository({ rootDir })
    const initial = await repository.findBySkillId(skillId)
    await repository.save(
      skillId,
      {
        ...initial.testCase,
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
      },
      initial.version,
    )
    const services = createE2ETestCaseApplicationServices(undefined, () => {
      throw new Error('本用例不触发 Agent 生成。')
    })
    const latest = await repository.findBySkillId(skillId)

    // 安全族：风险内容不得落盘，即使其余部分完整。
    await expect(
      services.saveSkillDocument!({
        rootDir,
        skillId,
        request: {
          content:
            '---\nname: 凭据用例\ndescription: 验证凭据仍阻断。\n---\n\n# 测试目标\n\n验证凭据。\n\n## 执行上下文\n\n- 目标 URL：`https://example.test/login`\n\n## 前置条件\n\n1. 环境可访问。\n\n## 测试步骤\n\n1. **打开登录页面**\n   - 操作：访问登录页。\n   - 预期结果：登录页面正常展示。\n\napi_key: sk-abcdefghijklmnopqrstuvwxyz\n\n## 执行注意事项\n\n- 不运行测试。\n',
          sourceHash: latest.sourceHash,
          expectedSkillDocumentVersion: null,
          mode: 'generation',
        },
      }),
    ).rejects.toThrow(/明文凭据/)
  })

  it('allows plaintext sensitive test data in MVP and still generates', async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), 'authine-cli-sensitive-'),
    )
    tempDirectories.push(rootDir)
    const created = await createSkill({
      rootDir,
      title: '敏感数据用例',
      description: '验证明文密码不阻断生成。',
    })
    const skillId = created.skillManifest.id
    const repository = new FileE2ETestCaseRepository({ rootDir })
    const initial = await repository.findBySkillId(skillId)
    const saved = await repository.save(
      skillId,
      {
        ...initial.testCase,
        baseUrl: 'https://example.test/login',
        steps: [
          {
            id: 'step_1',
            order: 1,
            description: '填写用户名和密码',
            action: '填写用户名或手机号和密码',
            expectedResult: '进入工作台',
            testData: { username: 'bo2', password: '123456' },
            enabled: true,
          },
        ],
      },
      initial.version,
    )
    let generatorCalled = false
    const generator: ISkillMarkdownGenerator = {
      async generate(input) {
        generatorCalled = true
        const content = `---
name: 敏感数据用例
description: 验证明文密码不阻断生成。
---

# 测试目标

验证明文密码不阻断生成。

## 执行上下文

- 目标 URL：\`https://example.test/login\`

## 前置条件

1. 测试环境可访问。

## 测试步骤

1. **填写用户名和密码**
   - 操作：

     \`\`\`text
     填写用户名或手机号和密码。
     \`\`\`

   - 预期结果：

     \`\`\`text
     进入工作台。
     \`\`\`

## 执行注意事项

- 当前阶段不会运行 Playwright 测试。
`
        await writeFile(
          path.join(input.targetDirectory, 'SKILL.md'),
          content,
          'utf8',
        )
        return { content, warnings: [], assumptions: [] }
      },
    }
    const services = createE2ETestCaseApplicationServices(
      undefined,
      () => generator,
    )

    // MVP 阶段敏感数据总开关关闭：明文密码可落盘，生成流程照常走到模型
    const candidate = await services.generateSkillDocument!({
      config: {
        projectDirectory: rootDir,
        llmApiKey: 'fake-key',
        llmApiBaseUrl: 'https://llm.example.test/v1',
        llmModelName: 'fake-model',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      skillId,
      sessionId: 'test-sensitive-session',
      request: {
        expectedTestCaseFileVersion: saved.version,
        expectedSkillDocumentVersion: null,
      },
      signal: new AbortController().signal,
    })

    expect(generatorCalled).toBe(true)
    expect(candidate.content).toContain('# 测试目标')
  })
})
