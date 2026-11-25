/**
 * 目录浏览领域逻辑测试：验证单层列举、空目录判定、错误码与边界情况。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDirectory,
  listDirectory,
  resolveWindowsDriveShortcut,
} from '../../src/workspace/directory-browser'
import { DirectoryBrowserError } from '../../src/shared/errors/directory-browser-error'

const execFileAsync = promisify(execFile)

let tempRoot = ''

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-directory-browser-'))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

/**
 * 断言异步操作抛出指定错误码的 DirectoryBrowserError。
 * @param operation 待执行的异步操作。
 * @param expectedCode 期望的错误码。
 * @returns 断言完成后无返回值。
 * @throws 当操作未抛出异常或错误码不匹配时由断言抛出异常。
 */
async function expectDirectoryBrowserError(
  operation: () => Promise<unknown>,
  expectedCode: DirectoryBrowserError['code'],
): Promise<void> {
  await expect(operation()).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof DirectoryBrowserError && error.code === expectedCode,
  )
}

/**
 * 在 Windows 上创建 junction 链接，用于覆盖链接目录的解析分支。
 *
 * @param options 链接路径与目标路径。
 * @returns 创建完成后无返回值。
 * @throws 当 mklink 命令执行失败时抛出异常。
 */
async function createWindowsJunction(options: {
  linkPath: string
  targetPath: string
}): Promise<void> {
  await execFileAsync('cmd', [
    '/c',
    'mklink',
    '/J',
    options.linkPath,
    options.targetPath,
  ])
}

describe('listDirectory', () => {
  it('lists only direct subdirectories and excludes files', async () => {
    await mkdir(path.join(tempRoot, 'alpha'))
    await mkdir(path.join(tempRoot, 'beta'))
    await writeFile(path.join(tempRoot, 'notes.txt'), 'content')

    const listing = await listDirectory({ directoryPath: tempRoot })

    expect(listing.directories.map((entry) => entry.name)).toEqual([
      'alpha',
      'beta',
    ])
    expect(listing.currentPath).toBe(path.resolve(tempRoot))
    expect(listing.truncated).toBe(false)
  })

  it('does not recurse into nested directories', async () => {
    const parentDirectory = path.join(tempRoot, 'parent')
    await mkdir(path.join(parentDirectory, 'child'), { recursive: true })

    const listing = await listDirectory({ directoryPath: tempRoot })

    expect(listing.directories).toHaveLength(1)
    expect(listing.directories[0].name).toBe('parent')
  })

  it('marks empty directories and ignores operating system metadata files', async () => {
    await mkdir(path.join(tempRoot, 'truly-empty'))
    const metadataOnlyDirectory = path.join(tempRoot, 'metadata-only')
    await mkdir(metadataOnlyDirectory)
    await writeFile(path.join(metadataOnlyDirectory, '.DS_Store'), '')
    await writeFile(path.join(metadataOnlyDirectory, 'Thumbs.db'), '')
    await mkdir(path.join(tempRoot, 'occupied'))
    await writeFile(path.join(tempRoot, 'occupied', 'file.txt'), 'content')

    const listing = await listDirectory({ directoryPath: tempRoot })
    const emptyFlags = Object.fromEntries(
      listing.directories.map((entry) => [entry.name, entry.empty]),
    )

    expect(emptyFlags).toEqual({
      'truly-empty': true,
      'metadata-only': true,
      occupied: false,
    })
  })

  it('reports the current directory emptiness and writability', async () => {
    const emptyDirectory = path.join(tempRoot, 'current')
    await mkdir(emptyDirectory)

    const listing = await listDirectory({ directoryPath: emptyDirectory })

    expect(listing.currentEmpty).toBe(true)
    expect(listing.currentWritable).toBe(true)
    expect(listing.directories).toEqual([])
  })

  it('marks a non-empty current directory as not empty', async () => {
    await writeFile(path.join(tempRoot, 'existing.txt'), 'content')

    const listing = await listDirectory({ directoryPath: tempRoot })

    expect(listing.currentEmpty).toBe(false)
  })

  it('returns null parent for a file system root', async () => {
    const fileSystemRoot = path.parse(path.resolve(tempRoot)).root

    const listing = await listDirectory({ directoryPath: fileSystemRoot })

    expect(listing.parentPath).toBeNull()
    expect(listing.rootPath).toBe(fileSystemRoot)
  })

  it('reports the file system root of the current path', async () => {
    const nestedDirectory = path.join(tempRoot, 'nested')
    await mkdir(nestedDirectory)

    const listing = await listDirectory({ directoryPath: nestedDirectory })

    expect(listing.rootPath).toBe(path.parse(path.resolve(tempRoot)).root)
  })

  it.runIf(process.platform === 'win32')(
    'treats a bare current-drive letter as the drive root instead of the process working directory',
    async () => {
      // 单独盘符是盘符相对路径：当前盘会被 path.resolve 解析为进程工作目录，
      // 必须显式补全为 'D:\' 才符合用户预期。
      const driveLetter = path
        .resolve(tempRoot)
        .slice(0, 2)
        .replace(/[\\/]$/, '')

      const listing = await listDirectory({ directoryPath: driveLetter })

      expect(listing.currentPath).toBe(`${driveLetter}${path.sep}`)
      expect(listing.rootPath).toBe(`${driveLetter}${path.sep}`)
    },
  )

  it.runIf(process.platform === 'win32')(
    'treats a bare non-current-drive letter as that drive root',
    async () => {
      // 注意必须带冒号：不带冒号的 'D' 是相对路径，应与 'D:' 区分处理。
      const currentDriveLetter = path
        .resolve(tempRoot)
        .slice(0, 1)
        .toUpperCase()
      // 选一个与当前盘不同的盘符，覆盖「非当前盘」解析分支。
      const otherDriveLetter = `${currentDriveLetter === 'D' ? 'C' : 'D'}:`

      try {
        const listing = await listDirectory({ directoryPath: otherDriveLetter })

        expect(listing.rootPath).toBe(`${otherDriveLetter}${path.sep}`)
      } catch (error) {
        // 该盘符可能在本机不存在；此时必须报「目录不存在」，
        // 而不是静默解析到进程工作目录（那正是本用例要防的回归）。
        expect(error).toBeInstanceOf(DirectoryBrowserError)
        expect((error as DirectoryBrowserError).code).toBe(
          'DIRECTORY_NOT_FOUND',
        )
      }
    },
  )

  it.runIf(process.platform === 'win32')(
    'rejects a bare drive letter without a colon as a relative path',
    async () => {
      // 'D' 不含冒号，是相对路径，不能与盘符简写 'D:' 混为一谈。
      await expectDirectoryBrowserError(
        () => listDirectory({ directoryPath: 'D' }),
        'INVALID_REQUEST',
      )
    },
  )

  it('returns the parent directory for a nested path', async () => {
    const nestedDirectory = path.join(tempRoot, 'nested')
    await mkdir(nestedDirectory)

    const listing = await listDirectory({ directoryPath: nestedDirectory })

    expect(listing.parentPath).toBe(path.resolve(tempRoot))
  })

  it('truncates the listing when it exceeds the entry limit', async () => {
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) => mkdir(path.join(tempRoot, name))),
    )

    const listing = await listDirectory({
      directoryPath: tempRoot,
      maxEntries: 2,
    })

    expect(listing.truncated).toBe(true)
    expect(listing.directories.map((entry) => entry.name)).toEqual(['a', 'b'])
  })

  it('normalizes relative paths into absolute ones', async () => {
    const listing = await listDirectory({
      directoryPath: `${tempRoot}${path.sep}.`,
    })

    expect(listing.currentPath).toBe(path.resolve(tempRoot))
  })

  it('handles directories with non-ASCII and space characters', async () => {
    const unicodeDirectory = path.join(tempRoot, '测试 目录')
    await mkdir(unicodeDirectory)

    const listing = await listDirectory({ directoryPath: tempRoot })

    expect(listing.directories.map((entry) => entry.name)).toEqual([
      '测试 目录',
    ])
    expect(listing.directories[0].absolutePath).toBe(
      path.resolve(unicodeDirectory),
    )
  })

  it('reports a missing directory as DIRECTORY_NOT_FOUND', async () => {
    await expectDirectoryBrowserError(
      () =>
        listDirectory({ directoryPath: path.join(tempRoot, 'does-not-exist') }),
      'DIRECTORY_NOT_FOUND',
    )
  })

  it('reports a file path as DIRECTORY_NOT_ACCESSIBLE', async () => {
    const filePath = path.join(tempRoot, 'file.txt')
    await writeFile(filePath, 'content')

    await expectDirectoryBrowserError(
      () => listDirectory({ directoryPath: filePath }),
      'DIRECTORY_NOT_ACCESSIBLE',
    )
  })

  it('reports an empty path as INVALID_REQUEST', async () => {
    await expectDirectoryBrowserError(
      () => listDirectory({ directoryPath: '   ' }),
      'INVALID_REQUEST',
    )
  })

  it.each([
    ['relative directory', 'workspace'],
    ['nested relative path', 'workspace/nested'],
    ['current directory', '.'],
    ['parent directory', '..'],
    ['home shorthand', '~'],
  ])('rejects the non-absolute path %s', async (_label, directoryPath) => {
    // 相对路径必须被拒绝，而不是静默按 CLI 进程工作目录解析：
    // 该工作目录取决于用户如何启动 CLI，静默解析会让用户选到意料之外的目录。
    await expectDirectoryBrowserError(
      () => listDirectory({ directoryPath }),
      'INVALID_REQUEST',
    )
  })

  it.runIf(process.platform === 'win32')(
    'rejects a drive-relative path such as C:workspace',
    async () => {
      // 'C:workspace' 是盘符相对路径而非绝对路径，必须与 'C:\workspace' 区分开。
      await expectDirectoryBrowserError(
        () => listDirectory({ directoryPath: 'C:workspace' }),
        'INVALID_REQUEST',
      )
    },
  )

  it('accepts an absolute path with forward slashes', async () => {
    const forwardSlashPath = path.resolve(tempRoot).replace(/\\/g, '/')
    await mkdir(path.join(tempRoot, 'alpha'))

    const listing = await listDirectory({ directoryPath: forwardSlashPath })

    expect(listing.directories.map((entry) => entry.name)).toEqual(['alpha'])
  })

  it.skipIf(process.platform === 'win32')(
    'lists directory symlinks and marks them as symbolic links',
    async () => {
      const targetDirectory = path.join(tempRoot, 'target')
      await mkdir(targetDirectory)
      await symlink(targetDirectory, path.join(tempRoot, 'link'))

      const listing = await listDirectory({ directoryPath: tempRoot })
      const symlinkEntry = listing.directories.find(
        (entry) => entry.name === 'link',
      )

      expect(symlinkEntry?.symbolicLink).toBe(true)
      expect(symlinkEntry?.empty).toBe(true)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'ignores symlinks that point to files or are broken',
    async () => {
      const targetFile = path.join(tempRoot, 'target.txt')
      await writeFile(targetFile, 'content')
      await symlink(targetFile, path.join(tempRoot, 'file-link'))
      await symlink(
        path.join(tempRoot, 'missing'),
        path.join(tempRoot, 'broken-link'),
      )

      const listing = await listDirectory({ directoryPath: tempRoot })

      expect(listing.directories).toEqual([])
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'lists Windows junctions as symbolic link directories',
    async () => {
      const targetDirectory = path.join(tempRoot, 'junction-target')
      await mkdir(targetDirectory)
      // Windows 上创建目录软链接通常需要管理员权限或开发者模式，
      // 而 junction 不需要，因此用 junction 覆盖链接目录的解析分支。
      await createWindowsJunction({
        linkPath: path.join(tempRoot, 'junction-link'),
        targetPath: targetDirectory,
      })

      const listing = await listDirectory({ directoryPath: tempRoot })
      const junctionEntry = listing.directories.find(
        (entry) => entry.name === 'junction-link',
      )

      expect(junctionEntry).toBeDefined()
      expect(junctionEntry?.symbolicLink).toBe(true)
      expect(junctionEntry?.empty).toBe(true)
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'ignores Windows junctions that point to files',
    async () => {
      const targetFile = path.join(tempRoot, 'junction-file-target.txt')
      await writeFile(targetFile, 'content')
      await createWindowsJunction({
        linkPath: path.join(tempRoot, 'junction-file-link'),
        targetPath: targetFile,
      })

      const listing = await listDirectory({ directoryPath: tempRoot })

      expect(listing.directories.map((entry) => entry.name)).not.toContain(
        'junction-file-link',
      )
    },
  )
})

describe('resolveWindowsDriveShortcut', () => {
  it.each(['C:', 'D:', 'e:', 'Z:'])(
    'expands the drive shortcut %s to its root on Windows',
    (driveShortcut) => {
      expect(resolveWindowsDriveShortcut(driveShortcut, 'win32')).toBe(
        `${driveShortcut}\\`,
      )
    },
  )

  it.each(['darwin', 'linux'] as const)(
    'returns null for the drive shortcut on %s where a colon is a legal file name character',
    (platform) => {
      // 在 macOS/Linux 上必须返回 null：那里的 'D:' 是普通相对目录名，
      // 补全成 'D:/' 会被 path.resolve 静默解析到 CLI 进程工作目录下。
      expect(resolveWindowsDriveShortcut('D:', platform)).toBeNull()
    },
  )

  it.each(['D', 'D:\\', 'D:\\workspace', 'workspace', '', '/posix/path'])(
    'returns null for the non-shortcut input %s',
    (input) => {
      expect(resolveWindowsDriveShortcut(input, 'win32')).toBeNull()
    },
  )
})

describe('createDirectory', () => {
  it('creates a subdirectory and returns its absolute path', async () => {
    const created = await createDirectory({
      parentPath: tempRoot,
      name: 'new-folder',
    })
    const listing = await listDirectory({ directoryPath: created.absolutePath })

    expect(created.absolutePath).toBe(path.resolve(tempRoot, 'new-folder'))
    expect(listing.currentEmpty).toBe(true)
  })

  it('creates directories with non-ASCII names', async () => {
    const created = await createDirectory({
      parentPath: tempRoot,
      name: '新建 目录',
    })
    const listing = await listDirectory({ directoryPath: tempRoot })

    expect(listing.directories.map((entry) => entry.name)).toEqual([
      '新建 目录',
    ])
  })

  it('rejects an existing directory name', async () => {
    await createDirectory({ parentPath: tempRoot, name: 'duplicate' })

    await expectDirectoryBrowserError(
      () => createDirectory({ parentPath: tempRoot, name: 'duplicate' }),
      'DIRECTORY_ALREADY_EXISTS',
    )
  })

  it('rejects an empty name', async () => {
    await expectDirectoryBrowserError(
      () => createDirectory({ parentPath: tempRoot, name: '   ' }),
      'INVALID_REQUEST',
    )
  })

  it.each(['../escape', 'nested/child', 'nested\\child', '.', '..'])(
    'rejects the unsafe directory name %s',
    async (unsafeName) => {
      await expectDirectoryBrowserError(
        () => createDirectory({ parentPath: tempRoot, name: unsafeName }),
        'INVALID_REQUEST',
      )
    },
  )

  it('reports a missing parent directory', async () => {
    await expectDirectoryBrowserError(
      () =>
        createDirectory({
          parentPath: path.join(tempRoot, 'missing'),
          name: 'child',
        }),
      'DIRECTORY_NOT_FOUND',
    )
  })
})
