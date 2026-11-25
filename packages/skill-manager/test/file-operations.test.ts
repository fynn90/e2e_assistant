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
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), 'authine-skill-manager-'),
  )
  tempDirectories.push(rootDir)
  const created = await createSkill({
    rootDir,
    title: '示例Skill',
    description: 'test fixture',
  })
  const sourcePath = path.join(created.skillDirectoryPath, 'main.ts')
  await writeFile(sourcePath, 'export const value = 1\n', 'utf-8')
  return { rootDir, created, sourcePath }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('secure Skill file operations', () => {
  it('loads detail, tree, content, and saves with a new version', async () => {
    const fixture = await createFixture()
    const skillId = fixture.created.skillManifest.id
    const detail = await getSkillDetail({ rootDir: fixture.rootDir }, skillId)
    expect(detail.title).toBe('示例Skill')

    const tree = await listSkillFiles({ rootDir: fixture.rootDir }, skillId)
    expect(tree.some((node) => node.relativePath === 'manifest.json')).toBe(
      true,
    )
    expect(tree.some((node) => node.relativePath === 'main.ts')).toBe(true)

    const file = await readSkillFile(
      { rootDir: fixture.rootDir },
      skillId,
      'main.ts',
    )
    const saved = await writeSkillFile({ rootDir: fixture.rootDir }, skillId, {
      relativePath: 'main.ts',
      content: 'export const value = 2\n',
      expectedVersion: file.version,
    })

    expect(saved.version).not.toBe(file.version)
    expect(await readFile(fixture.sourcePath, 'utf-8')).toBe(
      'export const value = 2\n',
    )
  })

  it('rejects traversal and stale versions without overwriting drafts', async () => {
    const fixture = await createFixture()
    const skillId = fixture.created.skillManifest.id

    await expect(
      readSkillFile(
        { rootDir: fixture.rootDir },
        skillId,
        '../skill.list.json',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })

    const file = await readSkillFile(
      { rootDir: fixture.rootDir },
      skillId,
      'main.ts',
    )
    await writeFile(fixture.sourcePath, 'external change\n', 'utf-8')

    await expect(
      writeSkillFile({ rootDir: fixture.rootDir }, skillId, {
        relativePath: 'main.ts',
        content: 'editor draft\n',
        expectedVersion: file.version,
      }),
    ).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
    expect(await readFile(fixture.sourcePath, 'utf-8')).toBe(
      'external change\n',
    )
  })
})
