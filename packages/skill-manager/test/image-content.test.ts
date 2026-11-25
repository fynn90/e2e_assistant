/**
 * Skill 内图片字节读取（v13）的单元测试。
 *
 * 重点覆盖安全与边界：
 *   - 路径穿越与符号链接由 `resolveSafeSkillFilePath` 拦截；
 *   - 非图片扩展名一律拒绝（即便它是文本文件）；
 *   - 体积上限同时依据 stat 与实际读取长度判定；
 *   - 正常读取返回准确的 MIME 与字节。
 */
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PREVIEW_IMAGE_BYTES,
  readSkillImageFile,
} from '../src/image-content'

/** 一个最小 PNG 字节序列（内容不重要，测试只关心读写与边界）。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let workspaceRoot: string
let skillId: string
let skillRoot: string

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'image-content-'))
  skillId = 'abc123def'
  skillRoot = path.join(workspaceRoot, `Skill_${skillId}`)
  await mkdir(skillRoot, { recursive: true })

  // resolveSkill 需要 skill.list.json 索引与 manifest.json 才能解析出目录
  await writeFile(
    path.join(workspaceRoot, 'skill.list.json'),
    JSON.stringify([
      {
        id: skillId,
        title: 'Skill',
        description: '',
        version: '1.0.0',
        directoryName: `Skill_${skillId}`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    'utf-8',
  )
  await writeFile(
    path.join(skillRoot, 'manifest.json'),
    JSON.stringify({
      id: skillId,
      title: 'Skill',
      description: '',
      version: '1.0.0',
      directoryName: `Skill_${skillId}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf-8',
  )
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('readSkillImageFile', () => {
  it('读取图片字节并返回 MIME 与大小', async () => {
    await writeFile(path.join(skillRoot, 'shot.png'), PNG_BYTES)

    const image = await readSkillImageFile(
      { rootDir: workspaceRoot },
      skillId,
      'shot.png',
    )

    expect(image.relativePath).toBe('shot.png')
    expect(image.mimeType).toBe('image/png')
    expect(image.size).toBe(PNG_BYTES.byteLength)
    expect(Buffer.compare(Buffer.from(image.bytes), PNG_BYTES)).toBe(0)
  })

  it('大小写不敏感的扩展名同样识别', async () => {
    await writeFile(path.join(skillRoot, 'SHOT.PNG'), PNG_BYTES)

    const image = await readSkillImageFile(
      { rootDir: workspaceRoot },
      skillId,
      'SHOT.PNG',
    )

    expect(image.mimeType).toBe('image/png')
  })

  it('支持嵌套分组目录（与 baselines/<分组>/ 结构一致）', async () => {
    await mkdir(path.join(skillRoot, 'baselines', 'preview'), {
      recursive: true,
    })
    await writeFile(
      path.join(skillRoot, 'baselines', 'preview', 'a.jpg'),
      PNG_BYTES,
    )

    const image = await readSkillImageFile(
      { rootDir: workspaceRoot },
      skillId,
      'baselines/preview/a.jpg',
    )

    expect(image.mimeType).toBe('image/jpeg')
    expect(image.relativePath).toBe('baselines/preview/a.jpg')
  })

  it.each(['a.pdf', 'b.zip', 'c.svg', 'd.txt'])(
    '拒绝非图片扩展名 %s',
    async (fileName) => {
      await writeFile(path.join(skillRoot, fileName), PNG_BYTES)

      await expect(
        readSkillImageFile({ rootDir: workspaceRoot }, skillId, fileName),
      ).rejects.toMatchObject({ code: 'FILE_NOT_SUPPORTED' })
    },
  )

  it('拒绝路径穿越', async () => {
    for (const relativePath of [
      '../outside.png',
      '/abs.png',
      'a/../../b.png',
      'C:/x.png',
    ]) {
      await expect(
        readSkillImageFile({ rootDir: workspaceRoot }, skillId, relativePath),
      ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
    }
  })

  it('文件不存在时报错', async () => {
    await expect(
      readSkillImageFile({ rootDir: workspaceRoot }, skillId, 'missing.png'),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })

  it('符号链接一律拒绝（杜绝借链接逃出 Skill 目录）', async () => {
    const outsideFile = path.join(workspaceRoot, 'outside.png')
    await writeFile(outsideFile, PNG_BYTES)
    const linkPath = path.join(skillRoot, 'link.png')

    try {
      await symlink(outsideFile, linkPath)
    } catch {
      // Windows 无权限创建符号链接时跳过该用例，不误报失败
      return
    }

    await expect(
      readSkillImageFile({ rootDir: workspaceRoot }, skillId, 'link.png'),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
  })

  it('超过体积上限时拒绝', async () => {
    const oversized = Buffer.alloc(MAX_PREVIEW_IMAGE_BYTES + 1)
    await writeFile(path.join(skillRoot, 'big.png'), oversized)

    await expect(
      readSkillImageFile({ rootDir: workspaceRoot }, skillId, 'big.png'),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })
})
