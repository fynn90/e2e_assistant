/**
 * env.json（Skill 敏感数据文件）的存储层测试（v10）：
 * 创建默认写入、详情 / 文件树读取补建、写入校验闸门（阻断落盘）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SkillManagerError,
  createSkill,
  getSkillDetail,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
} from '../src/index'

const tempDirectories: string[] = []

async function createFixture() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'authine-skill-env-'))
  tempDirectories.push(rootDir)
  const created = await createSkill({
    rootDir,
    title: '示例Skill',
    description: 'test fixture',
  })
  return {
    rootDir,
    skillId: created.skillManifest.id,
    skillDirectoryPath: created.skillDirectoryPath,
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('env.json 创建与补建（PRD 4.1）', () => {
  it('新建 Skill 时默认写入内容为空对象的 env.json', async () => {
    const fixture = await createFixture()
    const envPath = path.join(fixture.skillDirectoryPath, 'env.json')

    expect(await readFile(envPath, 'utf-8')).toBe('{\n}')
    const tree = await listSkillFiles(
      { rootDir: fixture.rootDir },
      fixture.skillId,
    )
    expect(tree.some((node) => node.relativePath === 'env.json')).toBe(true)
  })

  it('打开缺失 env.json 的存量 Skill 时自动补建（详情读取触发）', async () => {
    const fixture = await createFixture()
    const envPath = path.join(fixture.skillDirectoryPath, 'env.json')
    await rm(envPath)

    await getSkillDetail({ rootDir: fixture.rootDir }, fixture.skillId)

    expect(await readFile(envPath, 'utf-8')).toBe('{\n}')
  })

  it('文件树读取同样触发补建，保证打开后立即可见', async () => {
    const fixture = await createFixture()
    const envPath = path.join(fixture.skillDirectoryPath, 'env.json')
    await rm(envPath)

    const tree = await listSkillFiles(
      { rootDir: fixture.rootDir },
      fixture.skillId,
    )

    expect(tree.some((node) => node.relativePath === 'env.json')).toBe(true)
    expect(await readFile(envPath, 'utf-8')).toBe('{\n}')
  })

  it('已存在时不重写用户内容', async () => {
    const fixture = await createFixture()
    const envPath = path.join(fixture.skillDirectoryPath, 'env.json')
    await writeFile(envPath, '{\n  "E2E_TOKEN": "keep"\n}', 'utf-8')

    await getSkillDetail({ rootDir: fixture.rootDir }, fixture.skillId)

    expect(await readFile(envPath, 'utf-8')).toBe('{\n  "E2E_TOKEN": "keep"\n}')
  })
})

describe('env.json 写入校验闸门（PRD 5.3）', () => {
  it('合法内容正常写入并返回新版本', async () => {
    const fixture = await createFixture()
    const envPath = path.join(fixture.skillDirectoryPath, 'env.json')
    const current = await readSkillFile(
      { rootDir: fixture.rootDir },
      fixture.skillId,
      'env.json',
    )

    const saved = await writeSkillFile(
      { rootDir: fixture.rootDir },
      fixture.skillId,
      {
        relativePath: 'env.json',
        content: '{\n  "E2E_PASSWORD": "secret-value"\n}',
        expectedVersion: current.version,
      },
    )

    expect(saved.version).not.toBe(current.version)
    expect(await readFile(envPath, 'utf-8')).toContain('E2E_PASSWORD')
  })

  it('非法内容被拒绝（ENV_FILE_INVALID），磁盘保留最近一份合法内容', async () => {
    const fixture = await createFixture()
    const envPath = path.join(fixture.skillDirectoryPath, 'env.json')
    const current = await readSkillFile(
      { rootDir: fixture.rootDir },
      fixture.skillId,
      'env.json',
    )

    const error = await writeSkillFile(
      { rootDir: fixture.rootDir },
      fixture.skillId,
      {
        relativePath: 'env.json',
        content: '{ "password": "明文", "COUNT": 3 }',
        expectedVersion: current.version,
      },
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SkillManagerError)
    expect((error as SkillManagerError).code).toBe('ENV_FILE_INVALID')
    expect(await readFile(envPath, 'utf-8')).toBe('{\n}')
  })

  it('重复 key 的小写命名与重复定义都会被闸门拦截', async () => {
    const fixture = await createFixture()
    const current = await readSkillFile(
      { rootDir: fixture.rootDir },
      fixture.skillId,
      'env.json',
    )

    const caught = await writeSkillFile(
      { rootDir: fixture.rootDir },
      fixture.skillId,
      {
        relativePath: 'env.json',
        content: '{\n  "TOKEN": "a",\n  "TOKEN": "b"\n}',
        expectedVersion: current.version,
      },
    ).catch((caughtError: unknown) => caughtError)

    expect(caught).toBeInstanceOf(SkillManagerError)
    expect((caught as SkillManagerError).code).toBe('ENV_FILE_INVALID')
  })

  it('版本冲突仍优先报 FILE_VERSION_CONFLICT（409 语义不变）', async () => {
    const fixture = await createFixture()

    await expect(
      writeSkillFile({ rootDir: fixture.rootDir }, fixture.skillId, {
        relativePath: 'env.json',
        content: '{}',
        expectedVersion: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
  })
})
