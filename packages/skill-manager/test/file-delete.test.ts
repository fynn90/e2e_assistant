/**
 * Skill 内文件 / 目录删除（v13）的单元测试。
 *
 * 删除不可逆，因此重点覆盖**保护边界**与安全：
 *   - 创建 Skill 时生成的文件（manifest.json / e2e_schema.json / env.json）不可删；
 *   - 子目录中的同名文件不受保护（那是用户自建内容）；
 *   - 路径穿越、符号链接、根目录、不存在目标分别报正确错误码；
 *   - 目录递归删除生效。
 */
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isProtectedSkillRootFile } from '@authine-e2e-agent/types'
import { deleteSkillEntry } from '../src/file-delete'

let workspaceRoot: string
let skillId: string
let skillRoot: string

/**
 * 写入测试所需的索引与 manifest，使 resolveSkill 能解析出 Skill 目录。
 *
 * @returns 初始化完成的 Promise。
 * @throws 文件系统写入失败时抛出。
 */
async function seedSkill(): Promise<void> {
  const meta = {
    id: skillId,
    title: 'Skill',
    description: '',
    version: '1.0.0',
    directoryName: `Skill_${skillId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  await writeFile(
    path.join(workspaceRoot, 'skill.list.json'),
    JSON.stringify([meta]),
    'utf-8',
  )
  await writeFile(
    path.join(skillRoot, 'manifest.json'),
    JSON.stringify(meta),
    'utf-8',
  )
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'file-delete-'))
  skillId = 'abc123def'
  skillRoot = path.join(workspaceRoot, `Skill_${skillId}`)
  await mkdir(skillRoot, { recursive: true })
  await seedSkill()
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('isProtectedSkillRootFile（与前端共享的清单）', () => {
  it.each(['manifest.json', 'e2e_schema.json', 'env.json'])(
    '保护创建期文件 %s',
    (name) => {
      expect(isProtectedSkillRootFile(name)).toBe(true)
    },
  )

  it('大小写不敏感', () => {
    expect(isProtectedSkillRootFile('ENV.JSON')).toBe(true)
    expect(isProtectedSkillRootFile('Manifest.Json')).toBe(true)
  })

  it('子目录中的同名文件不受保护（用户自建内容）', () => {
    expect(isProtectedSkillRootFile('docs/env.json')).toBe(false)
    expect(isProtectedSkillRootFile('backup/manifest.json')).toBe(false)
  })

  it.each(['test.spec.ts', 'SKILL.md', 'baselines/a.png'])(
    '不保护普通产物 %s',
    (relativePath) => {
      expect(isProtectedSkillRootFile(relativePath)).toBe(false)
    },
  )
})

describe('deleteSkillEntry', () => {
  it('删除文件并返回类型', async () => {
    await writeFile(path.join(skillRoot, 'SKILL.md'), '# doc\n', 'utf-8')

    const result = await deleteSkillEntry(
      { rootDir: workspaceRoot },
      skillId,
      'SKILL.md',
    )

    expect(result).toEqual({ relativePath: 'SKILL.md', kind: 'file' })
    await expect(stat(path.join(skillRoot, 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('递归删除目录及其全部内容', async () => {
    await mkdir(path.join(skillRoot, 'baselines', 'img'), { recursive: true })
    await writeFile(path.join(skillRoot, 'baselines', 'img', 'a.png'), 'x')
    await writeFile(path.join(skillRoot, 'baselines', 'b.png'), 'x')

    const result = await deleteSkillEntry(
      { rootDir: workspaceRoot },
      skillId,
      'baselines',
    )

    expect(result).toEqual({ relativePath: 'baselines', kind: 'directory' })
    await expect(stat(path.join(skillRoot, 'baselines'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })

  it('允许删除 baselines 根目录（用户明确要求）', async () => {
    await mkdir(path.join(skillRoot, 'baselines'), { recursive: true })

    await expect(
      deleteSkillEntry({ rootDir: workspaceRoot }, skillId, 'baselines'),
    ).resolves.toMatchObject({ kind: 'directory' })
  })

  it.each(['manifest.json', 'e2e_schema.json', 'env.json'])(
    '拒绝删除创建期文件 %s',
    async (fileName) => {
      // manifest.json 由 seedSkill 写好，此处只补另外两个。
      // 注意：不能覆写 manifest.json 的内容——那会让 Skill 本身的索引校验
      // 先失败（SKILL_CORRUPTED），测不到删除保护。
      if (fileName !== 'manifest.json') {
        await writeFile(path.join(skillRoot, fileName), '{}', 'utf-8')
      }

      await expect(
        deleteSkillEntry({ rootDir: workspaceRoot }, skillId, fileName),
      ).rejects.toMatchObject({ code: 'FILE_READ_ONLY' })

      // 保护必须真正生效：文件仍在
      await expect(stat(path.join(skillRoot, fileName))).resolves.toBeTruthy()
    },
  )

  it('允许删除子目录中的同名文件', async () => {
    await mkdir(path.join(skillRoot, 'docs'), { recursive: true })
    await writeFile(path.join(skillRoot, 'docs', 'env.json'), '{}', 'utf-8')

    await expect(
      deleteSkillEntry({ rootDir: workspaceRoot }, skillId, 'docs/env.json'),
    ).resolves.toMatchObject({ kind: 'file' })
  })

  it.each(['../escape', '/abs', 'a/../../b', 'C:/x', ''])(
    '拒绝非法路径 %s',
    async (relativePath) => {
      await expect(
        deleteSkillEntry({ rootDir: workspaceRoot }, skillId, relativePath),
      ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
    },
  )

  it('目标不存在时报 FILE_NOT_FOUND', async () => {
    await expect(
      deleteSkillEntry({ rootDir: workspaceRoot }, skillId, 'nope.txt'),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })

  it('拒绝删除符号链接（避免删到链接指向的真实目标）', async () => {
    const outside = path.join(workspaceRoot, 'outside.txt')
    await writeFile(outside, 'important', 'utf-8')
    const linkPath = path.join(skillRoot, 'link.txt')

    try {
      await symlink(outside, linkPath)
    } catch {
      // Windows 无权限创建符号链接时跳过，不误报失败
      return
    }

    await expect(
      deleteSkillEntry({ rootDir: workspaceRoot }, skillId, 'link.txt'),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })

    // 链接指向的真实文件必须完好
    await expect(readFile(outside, 'utf-8')).resolves.toBe('important')
  })

  it('删除只影响目标，同一目录下的其他内容不受影响', async () => {
    await writeFile(path.join(skillRoot, 'a.txt'), 'a', 'utf-8')
    await writeFile(path.join(skillRoot, 'b.txt'), 'b', 'utf-8')

    await deleteSkillEntry({ rootDir: workspaceRoot }, skillId, 'a.txt')

    await expect(stat(path.join(skillRoot, 'a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(path.join(skillRoot, 'b.txt'), 'utf-8'),
    ).resolves.toBe('b')
  })
})
