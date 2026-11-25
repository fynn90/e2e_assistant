/**
 * 目录探测测试：验证单目录空判定与目录项解析，覆盖各平台都会走到的分支。
 *
 * 这些用例不依赖创建符号链接的权限，因此在 Windows 上同样能执行，
 * 弥补符号链接用例在 Windows 被跳过留下的覆盖缺口。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isDirectoryWritable,
  probeDirectory,
  resolveDirectoryEntry,
} from '../../src/workspace/directory-probe'

let tempRoot = ''

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-directory-probe-'))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('probeDirectory', () => {
  it('reports a fresh directory as empty and accessible', async () => {
    const emptyDirectory = path.join(tempRoot, 'empty')
    await mkdir(emptyDirectory)

    await expect(probeDirectory(emptyDirectory)).resolves.toEqual({
      empty: true,
      accessible: true,
    })
  })

  it('reports a directory holding a real file as non-empty', async () => {
    await writeFile(path.join(tempRoot, 'real.txt'), 'content')

    await expect(probeDirectory(tempRoot)).resolves.toEqual({
      empty: false,
      accessible: true,
    })
  })

  it.each(['.DS_Store', 'Thumbs.db'])(
    'ignores %s so macOS and Windows metadata does not make a directory look occupied',
    async (metadataFileName) => {
      const metadataDirectory = path.join(tempRoot, 'metadata-only')
      await mkdir(metadataDirectory)
      await writeFile(path.join(metadataDirectory, metadataFileName), '')

      await expect(probeDirectory(metadataDirectory)).resolves.toEqual({
        empty: true,
        accessible: true,
      })
    },
  )

  it('reports a missing directory as inaccessible', async () => {
    await expect(
      probeDirectory(path.join(tempRoot, 'missing')),
    ).resolves.toEqual({
      empty: false,
      accessible: false,
    })
  })

  it('reports a file path as inaccessible', async () => {
    const filePath = path.join(tempRoot, 'file.txt')
    await writeFile(filePath, 'content')

    await expect(probeDirectory(filePath)).resolves.toEqual({
      empty: false,
      accessible: false,
    })
  })
})

describe('isDirectoryWritable', () => {
  it('reports a writable directory as writable', async () => {
    await expect(isDirectoryWritable(tempRoot)).resolves.toBe(true)
  })

  it('reports a missing directory as not writable', async () => {
    await expect(
      isDirectoryWritable(path.join(tempRoot, 'missing')),
    ).resolves.toBe(false)
  })
})

describe('resolveDirectoryEntry', () => {
  it('resolves a real directory into a directory entry', async () => {
    await mkdir(path.join(tempRoot, 'real-dir'))

    const entry = await resolveDirectoryEntry({
      parentDirectory: tempRoot,
      entryName: 'real-dir',
      isSymbolicLink: false,
    })

    expect(entry).toEqual({
      name: 'real-dir',
      absolutePath: path.join(tempRoot, 'real-dir'),
      empty: true,
      accessible: true,
      symbolicLink: false,
    })
  })

  it('returns null for a regular file', async () => {
    await writeFile(path.join(tempRoot, 'file.txt'), 'content')

    const entry = await resolveDirectoryEntry({
      parentDirectory: tempRoot,
      entryName: 'file.txt',
      isSymbolicLink: false,
    })

    expect(entry).toBeNull()
  })

  it('returns null for an entry that cannot be stat-ed', async () => {
    // 失效的符号链接会走到这一分支，其判定逻辑与平台无关。
    const entry = await resolveDirectoryEntry({
      parentDirectory: tempRoot,
      entryName: 'does-not-exist',
      isSymbolicLink: true,
    })

    expect(entry).toBeNull()
  })

  it('preserves the symbolic link flag reported by the caller', async () => {
    await mkdir(path.join(tempRoot, 'linked-dir'))

    const entry = await resolveDirectoryEntry({
      parentDirectory: tempRoot,
      entryName: 'linked-dir',
      isSymbolicLink: true,
    })

    expect(entry?.symbolicLink).toBe(true)
  })
})
