/**
 * 验证 temp/ 临时工作区的路径约束与全终态清理（v7 PRD 4.4 / AC-05）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupTempWorkspace,
  createTempWorkspace,
  listTempWorkspaceEntries,
  resolveTempDirectory,
} from '../src/temp-workspace'

let skillRoot = ''
let tempRoot = ''

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-temp-workspace-'))
  skillRoot = path.join(tempRoot, 'skill-abc123def')
  await mkdir(skillRoot, { recursive: true })
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('createTempWorkspace', () => {
  it('在 Skill 目录下创建 temp/ 并写入候选文件', async () => {
    const workspace = await createTempWorkspace({ skillRoot })

    expect(workspace.directory).toBe(resolveTempDirectory(skillRoot))

    await workspace.writeFile('candidate.spec.ts', 'export const a = 1\n')

    await expect(
      readFile(path.join(workspace.directory, 'candidate.spec.ts'), 'utf-8'),
    ).resolves.toBe('export const a = 1\n')
  })

  it('拒绝逃逸出 temp/ 的相对路径，保护正式 Skill 文件', async () => {
    const workspace = await createTempWorkspace({ skillRoot })

    // 以下路径分别尝试用上级目录、绝对路径和盘符逃逸临时工作区。
    for (const escapePath of [
      '../test.spec.ts',
      '../SKILL.md',
      '/absolute.ts',
      'C:/windows/evil.ts',
      'nested/../../outside.ts',
    ]) {
      await expect(
        workspace.writeFile(escapePath, 'malicious'),
      ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
    }

    // 正式文件绝不能被创建。
    await expect(
      stat(path.join(skillRoot, 'test.spec.ts')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('允许在 temp/ 内创建子目录，写入嵌套文件', async () => {
    const workspace = await createTempWorkspace({ skillRoot })

    await workspace.writeFile('artifacts/report.json', '{"ok":true}')

    await expect(
      readFile(
        path.join(workspace.directory, 'artifacts/report.json'),
        'utf-8',
      ),
    ).resolves.toBe('{"ok":true}')
  })

  it('创建前清理上一次任务遗留的 temp/（PRD 4.4 遗留下次任务前清理）', async () => {
    // 模拟上一轮任务异常中断，temp/ 中残留了候选文件。
    const staleDirectory = resolveTempDirectory(skillRoot)
    await mkdir(staleDirectory, { recursive: true })
    await writeFile(path.join(staleDirectory, 'leftover.spec.ts'), 'stale')

    await createTempWorkspace({ skillRoot })

    await expect(listTempWorkspaceEntries(skillRoot)).resolves.toEqual([])
  })

  it('清理后 temp/ 目录消失，且正式文件不受影响', async () => {
    // 正式产物先就位：清理绝不能碰它们。
    await writeFile(path.join(skillRoot, 'test.spec.ts'), 'official')
    await writeFile(path.join(skillRoot, 'SKILL.md'), '# doc')

    const workspace = await createTempWorkspace({ skillRoot })
    await workspace.writeFile('candidate.spec.ts', 'candidate')
    await workspace.cleanup()

    await expect(stat(workspace.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(path.join(skillRoot, 'test.spec.ts'), 'utf-8'),
    ).resolves.toBe('official')
    await expect(
      readFile(path.join(skillRoot, 'SKILL.md'), 'utf-8'),
    ).resolves.toBe('# doc')
  })

  it('重复清理是幂等的，目录不存在时安全无操作', async () => {
    const workspace = await createTempWorkspace({ skillRoot })

    await workspace.cleanup()
    await expect(workspace.cleanup()).resolves.toBeUndefined()
    await expect(cleanupTempWorkspace(skillRoot)).resolves.toBeUndefined()
  })
})
