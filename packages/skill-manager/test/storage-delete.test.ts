// 验证 deleteSkill：彻底删除 Skill 目录与全局索引条目，并处理缺失 / 孤儿场景。
import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SkillManagerError,
  createSkill,
  deleteSkill,
  listSkills,
} from '../src/index'

const tempDirectories: string[] = []

/**
 * 在临时目录中创建 Skill 夹具。
 * @param title 示例 Skill 名称。
 * @returns 临时根目录与创建结果。
 * @throws 创建失败时由 Skill Manager 抛出。
 */
async function createFixture(title: string) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'authine-skill-delete-'))
  tempDirectories.push(rootDir)
  const created = await createSkill({
    rootDir,
    title,
    description: 'delete fixture',
  })
  return { rootDir, created }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('deleteSkill', () => {
  it('彻底删除 Skill 目录与索引条目，且不影响其他 Skill', async () => {
    const fixture = await createFixture('待删除Skill')
    const keeper = await createSkill({
      rootDir: fixture.rootDir,
      title: '保留Skill',
      description: 'keep',
    })
    const skillId = fixture.created.skillManifest.id
    const directoryName = fixture.created.skillManifest.directoryName
    expect(directoryName).toBeTruthy()

    const result = await deleteSkill({ rootDir: fixture.rootDir }, skillId)

    expect(result).toEqual({ skillId, directoryName })
    await expect(
      access(fixture.created.skillDirectoryPath),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const remaining = await listSkills({ rootDir: fixture.rootDir })
    expect(remaining.some((skill) => skill.id === skillId)).toBe(false)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(keeper.skillManifest.id)

    const listContent = await readFile(
      path.join(fixture.rootDir, 'skill.list.json'),
      'utf-8',
    )
    expect(listContent).not.toContain(skillId)
    expect(listContent).toContain(keeper.skillManifest.id)
  })

  it('Skill 不存在时抛出 SKILL_NOT_FOUND', async () => {
    const fixture = await createFixture('绝区Skill')

    await expect(
      deleteSkill({ rootDir: fixture.rootDir }, 'zzzzzzzzz'),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
  })

  it('Skill ID 格式不正确时抛出 INVALID_SKILL_ID', async () => {
    const fixture = await createFixture('校验Skill')

    await expect(
      deleteSkill({ rootDir: fixture.rootDir }, 'bad-id'),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL_ID' })
  })

  it('目录已缺失（孤儿）时仍从索引剔除', async () => {
    const fixture = await createFixture('孤儿Skill')
    const skillId = fixture.created.skillManifest.id
    await rm(fixture.created.skillDirectoryPath, {
      recursive: true,
      force: true,
    })

    const result = await deleteSkill({ rootDir: fixture.rootDir }, skillId)

    expect(result.skillId).toBe(skillId)
    expect(await listSkills({ rootDir: fixture.rootDir })).toHaveLength(0)
  })

  it('索引条目损坏时抛出 SKILL_CORRUPTED', async () => {
    const fixture = await createFixture('损坏Skill')
    const listPath = path.join(fixture.rootDir, 'skill.list.json')
    await writeFile(
      listPath,
      JSON.stringify([{ id: fixture.created.skillManifest.id, title: 123 }]),
      'utf-8',
    )

    const error = await deleteSkill(
      { rootDir: fixture.rootDir },
      fixture.created.skillManifest.id,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SkillManagerError)
    expect((error as SkillManagerError).code).toBe('SKILL_CORRUPTED')
    expect(String((error as SkillManagerError).message)).toBe(
      'Skill 索引条目已损坏。',
    )
  })
})
