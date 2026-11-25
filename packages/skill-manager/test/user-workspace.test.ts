/**
 * userWorkSpace 目录（v14）的单元测试。
 *
 * 覆盖 PRD 4.2/4.3 的核心规则：
 *   - 创建事务（W6/W7）：新建 Skill 后必然包含空 userWorkSpace；
 *   - 幂等补建（W8-W11）四态矩阵：已存在 / 缺失 / 被同名文件占用 / silent 与 strict 语义；
 *   - 删除保护（W12/W15/W17）：根目录与大小写变体被拒、子内容可删、整删 Skill 随删；
 *   - 存在性检查（D7）：userWorkspacePathExists 的越界与存在判定；
 *   - 文件树标注（W20-W22）：protection/notice 与占位合成节点。
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSkill,
  deleteSkill,
  deleteSkillEntry,
  ensureUserWorkSpace,
  fatalIssueFor,
  listSkillFiles,
  userWorkspacePathExists,
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
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'user-workspace-'))
  skillId = 'abc123def'
  skillRoot = path.join(workspaceRoot, `Skill_${skillId}`)
  await mkdir(skillRoot, { recursive: true })
  await seedSkill()
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('创建事务（W6/W7，场景 1）', () => {
  it('新建 Skill 后根目录包含空 userWorkSpace', async () => {
    const { skillDirectoryPath } = await createSkill({
      rootDir: workspaceRoot,
      title: '新建技能',
    })

    const workspaceStat = await stat(
      path.join(skillDirectoryPath, USER_WORKSPACE_DIRECTORY_NAME),
    )
    expect(workspaceStat.isDirectory()).toBe(true)
    // 空目录：创建事务只建目录不放内容（场景 1 预期结果）。
    expect(
      await readdir(
        path.join(skillDirectoryPath, USER_WORKSPACE_DIRECTORY_NAME),
      ),
    ).toEqual([])

    // 与 manifest / e2e_schema / env 一同在 staging 中创建并原子发布（场景 1）。
    expect(
      (await stat(path.join(skillDirectoryPath, 'manifest.json'))).isFile(),
    ).toBe(true)
    expect(
      (await stat(path.join(skillDirectoryPath, 'env.json'))).isFile(),
    ).toBe(true)
  })
})

describe('ensureUserWorkSpace（W8-W11 四态矩阵）', () => {
  it('已存在：幂等返回 ready，不重建', async () => {
    await mkdir(path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME))
    await writeFile(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'keep.txt'),
      'x',
    )

    const status = await ensureUserWorkSpace(
      { rootDir: workspaceRoot },
      skillId,
      'silent',
    )
    expect(status).toEqual({ state: 'ready' })

    // W9：已有文件不受影响。
    expect(
      await readFile(
        path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'keep.txt'),
        'utf-8',
      ),
    ).toBe('x')
  })

  it('缺失：补建并返回 ready（存量 Skill，场景 2）', async () => {
    const status = await ensureUserWorkSpace(
      { rootDir: workspaceRoot },
      skillId,
      'silent',
    )
    expect(status).toEqual({ state: 'ready' })
    expect(
      (
        await stat(path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME))
      ).isDirectory(),
    ).toBe(true)
  })

  it('被同名普通文件占用：不覆盖不删除（W10，场景 13）', async () => {
    await writeFile(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME),
      'occupied',
    )

    const silent = await ensureUserWorkSpace(
      { rootDir: workspaceRoot },
      skillId,
      'silent',
    )
    expect(silent).toMatchObject({
      state: 'unavailable',
      issue: { code: 'USER_WORKSPACE_OCCUPIED' },
    })
    // 文件原样保留。
    expect(
      await readFile(
        path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME),
        'utf-8',
      ),
    ).toBe('occupied')

    // W11：strict 模式抛出明确错误（依赖能力必须明确失败）。
    await expect(
      ensureUserWorkSpace({ rootDir: workspaceRoot }, skillId, 'strict'),
    ).rejects.toMatchObject({ code: 'USER_WORKSPACE_OCCUPIED' })
  })

  it('strict 模式下 ready 不抛出', async () => {
    await expect(
      ensureUserWorkSpace({ rootDir: workspaceRoot }, skillId, 'strict'),
    ).resolves.toEqual({ state: 'ready' })
  })
})

describe('删除保护（W12/W15/W17）', () => {
  beforeEach(async () => {
    await mkdir(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'screenshots'),
      {
        recursive: true,
      },
    )
    await writeFile(
      path.join(
        skillRoot,
        USER_WORKSPACE_DIRECTORY_NAME,
        'screenshots',
        'a.png',
      ),
      'x',
    )
  })

  it('拒绝删除 userWorkSpace 根目录（场景 7）', async () => {
    await expect(
      deleteSkillEntry(
        { rootDir: workspaceRoot },
        skillId,
        USER_WORKSPACE_DIRECTORY_NAME,
      ),
    ).rejects.toMatchObject({ code: 'FILE_READ_ONLY' })
    // 根目录仍在。
    expect(
      (
        await stat(path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME))
      ).isDirectory(),
    ).toBe(true)
  })

  it('大小写变体同样被拒（Windows 不敏感文件系统）', async () => {
    await expect(
      deleteSkillEntry({ rootDir: workspaceRoot }, skillId, 'UserWorkSpace'),
    ).rejects.toMatchObject({ code: 'FILE_READ_ONLY' })
    await expect(
      deleteSkillEntry({ rootDir: workspaceRoot }, skillId, 'USERWORKSPACE'),
    ).rejects.toMatchObject({ code: 'FILE_READ_ONLY' })
  })

  it('子目录递归删除且根目录保留（W15，场景 6）', async () => {
    const result = await deleteSkillEntry(
      { rootDir: workspaceRoot },
      skillId,
      `${USER_WORKSPACE_DIRECTORY_NAME}/screenshots`,
    )
    expect(result).toEqual({
      relativePath: `${USER_WORKSPACE_DIRECTORY_NAME}/screenshots`,
      kind: 'directory',
    })
    await expect(
      stat(path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'screenshots')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      (
        await stat(path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME))
      ).isDirectory(),
    ).toBe(true)
  })

  it('删除整个 Skill 时 userWorkSpace 随之一并删除（W17，场景 16）', async () => {
    await deleteSkill({ rootDir: workspaceRoot }, skillId)
    await expect(stat(skillRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('userWorkspacePathExists（D7）', () => {
  it('存在的相对路径返回 true', async () => {
    await mkdir(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'preview'),
      {
        recursive: true,
      },
    )
    await writeFile(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'preview', 'a.png'),
      'x',
    )

    expect(
      await userWorkspacePathExists(
        { rootDir: workspaceRoot },
        skillId,
        'preview/a.png',
      ),
    ).toBe(true)
    // 带一次前导 userWorkSpace 段同样可解析（D2）。
    expect(
      await userWorkspacePathExists(
        { rootDir: workspaceRoot },
        skillId,
        'userWorkSpace/preview/a.png',
      ),
    ).toBe(true)
  })

  it('不存在的路径返回 false', async () => {
    expect(
      await userWorkspacePathExists(
        { rootDir: workspaceRoot },
        skillId,
        'nope/a.png',
      ),
    ).toBe(false)
  })

  it('越界与非法路径返回 false', async () => {
    expect(
      await userWorkspacePathExists(
        { rootDir: workspaceRoot },
        skillId,
        '../x',
      ),
    ).toBe(false)
    expect(
      await userWorkspacePathExists(
        { rootDir: workspaceRoot },
        skillId,
        '/abs',
      ),
    ).toBe(false)
  })
})

describe('文件树标注（W20-W22）', () => {
  it('真实目录节点带 protection 标记', async () => {
    await mkdir(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'exports'),
      {
        recursive: true,
      },
    )

    const tree = await listSkillFiles({ rootDir: workspaceRoot }, skillId)
    const workspaceNode = tree.find(
      (node) => node.relativePath === USER_WORKSPACE_DIRECTORY_NAME,
    )
    expect(workspaceNode).toMatchObject({
      kind: 'directory',
      protection: 'user-workspace-root',
    })
  })

  it('补建失败（被同名文件占用）时文件节点同样带 protection 与 notice（W10/W20）', async () => {
    await writeFile(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME),
      'occupied',
    )

    const tree = await listSkillFiles({ rootDir: workspaceRoot }, skillId)
    // 被占用时扫描产出的是文件节点：protection/notice 是「受保护根」语义，
    // 与 kind 无关，不能因为是文件就漏加标记（否则前端会为其渲染删除按钮）。
    const workspaceNode = tree.find(
      (node) =>
        node.relativePath.toLowerCase() ===
        USER_WORKSPACE_DIRECTORY_NAME.toLowerCase(),
    )
    expect(workspaceNode?.kind).toBe('file')
    expect(workspaceNode).toMatchObject({
      kind: 'file',
      protection: 'user-workspace-root',
    })
    // 占用属 unavailable 状态：必须附降级原因供前端 Tooltip 展示（W20）。
    expect(workspaceNode?.notice).toContain('占用')
  })
})

describe('可用性判定矩阵（v15：四态 × 三模式）', () => {
  const issue = {
    code: 'USER_WORKSPACE_NOT_WRITABLE',
    message: '目录不可写。',
  } as const

  /**
   * 这组用例守护的核心是 v15 的一条边界：**生成不再因为「目录不可写」而失败**。
   * 生成链路不写 userWorkSpace，把执行期才成立的前提搬到生成入口去拦，
   * 只会让用户撞上一个与自己当前操作无关的错误。执行链路（strict）必须保持严格，
   * 否则不可写会在测试跑到一半时以脚本错误爆出来，更难定位。
   */
  it('ready 对所有模式都不致命', () => {
    for (const mode of ['silent', 'generation', 'strict'] as const) {
      expect(fatalIssueFor(mode, { state: 'ready' })).toBeNull()
    }
  })

  it('silent 永不致命（W11：浏览可继续）', () => {
    expect(
      fatalIssueFor('silent', { state: 'ready-degraded', issue }),
    ).toBeNull()
    expect(fatalIssueFor('silent', { state: 'unavailable', issue })).toBeNull()
  })

  it('generation 只对 unavailable 致命，容忍 ready-degraded', () => {
    expect(
      fatalIssueFor('generation', { state: 'ready-degraded', issue }),
    ).toBeNull()
    expect(
      fatalIssueFor('generation', { state: 'unavailable', issue }),
    ).toEqual(issue)
  })

  it('strict（执行）对 degraded 与 unavailable 都致命', () => {
    expect(fatalIssueFor('strict', { state: 'ready-degraded', issue })).toEqual(
      issue,
    )
    expect(fatalIssueFor('strict', { state: 'unavailable', issue })).toEqual(
      issue,
    )
  })
})
