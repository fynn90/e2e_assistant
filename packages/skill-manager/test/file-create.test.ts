/**
 * userWorkSpace 内新建文件 / 目录（v14 D1/W14）的单元测试。
 *
 * 重点覆盖安全边界与创建语义：
 *   - 请求体只带 userWorkSpace 内相对路径，越界（../、绝对路径、盘符）一律拒绝；
 *   - 目录多级创建与已存在拒绝；
 *   - 中间段被文件 / 符号链接占用时拒绝（mkdir recursive 不查符号链接，必须逐段）；
 *   - 文件 wx 创建不覆盖已有文件；
 *   - 二进制扩展名与内容超限拒绝。
 */

import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createUserWorkspaceDirectory,
  createUserWorkspaceFile,
  USER_WORKSPACE_DIRECTORY_NAME,
} from '../src/index'

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
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'file-create-'))
  skillId = 'abc123def'
  skillRoot = path.join(workspaceRoot, `Skill_${skillId}`)
  await mkdir(path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME), {
    recursive: true,
  })
  await seedSkill()
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('createUserWorkspaceDirectory', () => {
  it('多级创建并返回完整相对路径', async () => {
    const result = await createUserWorkspaceDirectory(
      { rootDir: workspaceRoot },
      skillId,
      'exports/2026/q1',
    )

    expect(result).toEqual({ relativePath: 'userWorkSpace/exports/2026/q1' })
    expect(
      (
        await stat(
          path.join(
            skillRoot,
            USER_WORKSPACE_DIRECTORY_NAME,
            'exports',
            '2026',
            'q1',
          ),
        )
      ).isDirectory(),
    ).toBe(true)
  })

  it('允许带一次前导 userWorkSpace 段（D2 剥离）', async () => {
    const result = await createUserWorkspaceDirectory(
      { rootDir: workspaceRoot },
      skillId,
      'userWorkSpace/exports',
    )
    expect(result).toEqual({ relativePath: 'userWorkSpace/exports' })
  })

  it('已存在时拒绝且不覆盖（DIRECTORY_ALREADY_EXISTS）', async () => {
    await createUserWorkspaceDirectory(
      { rootDir: workspaceRoot },
      skillId,
      'exports',
    )
    await expect(
      createUserWorkspaceDirectory(
        { rootDir: workspaceRoot },
        skillId,
        'exports',
      ),
    ).rejects.toMatchObject({ code: 'DIRECTORY_ALREADY_EXISTS' })
  })

  it('中间段被普通文件占用时拒绝', async () => {
    await writeFile(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'blocked'),
      'x',
    )

    await expect(
      createUserWorkspaceDirectory(
        { rootDir: workspaceRoot },
        skillId,
        'blocked/inner',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
  })

  it('中间段被符号链接占用时拒绝（逐段检查）', async () => {
    const linkTarget = await mkdtemp(
      path.join(os.tmpdir(), 'file-create-target-'),
    )
    await symlink(
      linkTarget,
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'linkdir'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(
      createUserWorkspaceDirectory(
        { rootDir: workspaceRoot },
        skillId,
        'linkdir/inner',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
  })

  it('越界与非法路径拒绝', async () => {
    for (const bad of [
      '../outside',
      '/abs',
      'C:\\x',
      'a/b/../../c',
      '',
      'userWorkSpace/userWorkSpace/x',
    ]) {
      await expect(
        createUserWorkspaceDirectory({ rootDir: workspaceRoot }, skillId, bad),
      ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
    }
  })
})

describe('createUserWorkspaceFile', () => {
  it('创建文件并返回版本与大小；父目录自动创建', async () => {
    const result = await createUserWorkspaceFile(
      { rootDir: workspaceRoot },
      skillId,
      'exports/result.csv',
      'a,b\n1,2\n',
    )

    expect(result.relativePath).toBe('userWorkSpace/exports/result.csv')
    expect(result.size).toBe(Buffer.byteLength('a,b\n1,2\n', 'utf-8'))
    expect(result.version).toMatch(/^[a-f0-9]{64}$/)
    expect(
      (
        await stat(
          path.join(
            skillRoot,
            USER_WORKSPACE_DIRECTORY_NAME,
            'exports',
            'result.csv',
          ),
        )
      ).isFile(),
    ).toBe(true)
  })

  it('空内容创建空文件（R10）', async () => {
    const result = await createUserWorkspaceFile(
      { rootDir: workspaceRoot },
      skillId,
      'notes/empty.md',
      '',
    )
    expect(result.size).toBe(0)
  })

  it('wx 语义：文件已存在时不覆盖（FILE_ALREADY_EXISTS）', async () => {
    await createUserWorkspaceFile(
      { rootDir: workspaceRoot },
      skillId,
      'a.txt',
      'original',
    )

    await expect(
      createUserWorkspaceFile(
        { rootDir: workspaceRoot },
        skillId,
        'a.txt',
        'clobbered',
      ),
    ).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' })

    // 原内容保留。
    const { readFile } = await import('node:fs/promises')
    expect(
      await readFile(
        path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'a.txt'),
        'utf-8',
      ),
    ).toBe('original')
  })

  it('二进制扩展名拒绝（图片等产物由捕获工具/脚本产生）', async () => {
    await expect(
      createUserWorkspaceFile(
        { rootDir: workspaceRoot },
        skillId,
        'shot.png',
        'x',
      ),
    ).rejects.toMatchObject({ code: 'FILE_NOT_SUPPORTED' })
  })

  it('内容超限拒绝（FILE_TOO_LARGE）', async () => {
    await expect(
      createUserWorkspaceFile(
        { rootDir: workspaceRoot },
        skillId,
        'big.txt',
        'x'.repeat(1024 * 1024 + 1),
      ),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })

  it('越界路径拒绝', async () => {
    for (const bad of [
      '../x.txt',
      '/abs.txt',
      'C:\\x.txt',
      'userWorkSpace/userWorkSpace/x.txt',
    ]) {
      await expect(
        createUserWorkspaceFile({ rootDir: workspaceRoot }, skillId, bad, ''),
      ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
    }
  })
})
