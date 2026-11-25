/**
 * 验证 E2E 固定文件仓储、不可变 Skill 目录身份和脚本版本控制。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  FileE2ETestCaseRepository,
  FilePlaywrightScriptRepository,
  SkillManagerError,
  createSkill,
  getSkillDetail,
  listSkills,
  readSkillFile,
  writeSkillFile,
} from '../src/index'

const tempDirectories: string[] = []

async function createFixture() {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), 'authine-e2e-repository-'),
  )
  tempDirectories.push(rootDir)
  const created = await createSkill({
    rootDir,
    title: '登录Skill',
    description: '',
  })
  const scriptRepository = new FilePlaywrightScriptRepository({ rootDir })
  const repository = new FileE2ETestCaseRepository(
    { rootDir },
    scriptRepository,
  )
  return { rootDir, created, repository, scriptRepository }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('E2E fixed file repositories', () => {
  it('initializes a valid draft and keeps directory identity after title changes', async () => {
    const fixture = await createFixture()
    const skillId = fixture.created.skillManifest.id
    const beforeDirectory = fixture.created.skillDirectoryPath
    const initial = await fixture.repository.findBySkillId(skillId)

    expect(initial.testCase.baseUrl).toBe('')
    expect(initial.testCase.steps).toEqual([])

    const saved = await fixture.repository.save(
      skillId,
      {
        ...initial.testCase,
        title: '  更新后的登录用例  ',
        description: '  验证用户登录。  ',
        baseUrl: 'https://example.test',
        tags: ['  登录  '],
      },
      initial.version,
    )

    expect(saved.version).not.toBe(initial.version)
    expect(saved.testCase.title).toBe('更新后的登录用例')
    expect(saved.testCase.description).toBe('验证用户登录。')
    expect(saved.testCase.tags).toEqual(['登录'])
    expect(
      JSON.parse(
        await readFile(path.join(beforeDirectory, 'e2e_schema.json'), 'utf-8'),
      ),
    ).toEqual(saved.testCase)
    expect(
      (await getSkillDetail({ rootDir: fixture.rootDir }, skillId)).title,
    ).toBe('更新后的登录用例')
    expect(fixture.created.skillDirectoryPath).toBe(beforeDirectory)
    expect(
      JSON.parse(
        await readFile(path.join(beforeDirectory, 'manifest.json'), 'utf-8'),
      ).directoryName,
    ).toBe(path.basename(beforeDirectory))
  })

  it('repairs a stale skill.list projection from the authoritative manifest', async () => {
    const fixture = await createFixture()
    const skillId = fixture.created.skillManifest.id
    const initial = await fixture.repository.findBySkillId(skillId)
    await fixture.repository.save(
      skillId,
      {
        ...initial.testCase,
        title: '权威标题',
        description: '权威描述',
        baseUrl: 'https://example.test',
      },
      initial.version,
    )
    const listPath = path.join(fixture.rootDir, 'skill.list.json')
    const staleList = JSON.parse(await readFile(listPath, 'utf-8')) as Array<
      Record<string, unknown>
    >
    staleList[0] = {
      ...staleList[0],
      title: '过期标题',
      description: '过期描述',
    }
    await writeFile(
      listPath,
      `${JSON.stringify(staleList, null, 2)}\n`,
      'utf-8',
    )

    expect(
      (await getSkillDetail({ rootDir: fixture.rootDir }, skillId)).title,
    ).toBe('权威标题')
    expect((await listSkills({ rootDir: fixture.rootDir }))[0]?.title).toBe(
      '权威标题',
    )
  })

  it('rejects stale test case versions without overwriting the external content', async () => {
    const fixture = await createFixture()
    const skillId = fixture.created.skillManifest.id
    const initial = await fixture.repository.findBySkillId(skillId)
    const schemaPath = path.join(
      fixture.created.skillDirectoryPath,
      'e2e_schema.json',
    )
    await writeFile(schemaPath, '{"external":true}\n', 'utf-8')

    await expect(
      fixture.repository.save(
        skillId,
        {
          ...initial.testCase,
          description: '验证版本冲突。',
          baseUrl: 'https://example.test',
        },
        initial.version,
      ),
    ).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
    expect(await readFile(schemaPath, 'utf-8')).toBe('{"external":true}\n')
  })

  it('rejects generic E2E writes and serializes manual script edits under the Skill lock', async () => {
    const fixture = await createFixture()
    const skillId = fixture.created.skillManifest.id
    const document = await fixture.repository.findBySkillId(skillId)

    await expect(
      writeSkillFile({ rootDir: fixture.rootDir }, skillId, {
        relativePath: 'e2e_schema.json',
        content: '{}\n',
        expectedVersion: document.version,
      }),
    ).rejects.toMatchObject({ code: 'FILE_READ_ONLY' })

    const generated = await fixture.scriptRepository.save(
      skillId,
      "import { test, expect } from '@playwright/test'\n",
      document.sourceHash,
      null,
    )
    const manuallyEdited = await writeSkillFile(
      { rootDir: fixture.rootDir },
      skillId,
      {
        relativePath: 'test.spec.ts',
        content:
          "import { test, expect } from '@playwright/test'\n// manual edit\n",
        expectedVersion: generated.version,
      },
    )
    const state = await fixture.scriptRepository.getState(
      skillId,
      document.sourceHash,
    )

    expect(state.status).toBe('current')
    expect(state.version).toBe(manuallyEdited.version)
    expect(state.updatedAt).toBeTruthy()
  })

  it('creates a script once and rejects a stale null expected version', async () => {
    const fixture = await createFixture()
    const skillId = fixture.created.skillManifest.id
    const document = await fixture.repository.findBySkillId(skillId)
    const code = "import { test, expect } from '@playwright/test'\n"
    const saved = await fixture.scriptRepository.save(
      skillId,
      code,
      document.sourceHash,
      null,
    )

    expect(saved.relativePath).toBe('test.spec.ts')
    await expect(
      fixture.scriptRepository.save(
        skillId,
        `${code}\n`,
        document.sourceHash,
        null,
      ),
    ).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
    expect(
      (
        await readSkillFile(
          { rootDir: fixture.rootDir },
          skillId,
          'test.spec.ts',
        )
      ).content,
    ).toBe(code)
  })
})
