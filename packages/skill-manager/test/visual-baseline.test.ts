/**
 * 视觉基线产物（v12 引入，v14 换根到 userWorkSpace）的单元测试。
 *
 * 重点覆盖安全边界与目录语义：
 *   - 分组目录分段与文件名的白名单（目录穿越的第一道防线）；
 *   - 路径归一化后的前缀校验（双保险）；
 *   - 多层分组目录的创建；
 *   - 单张基线的体积上限；
 *   - 未捕获过基线时列出为空（而非报错）；
 *   - v14：落盘根为 userWorkSpace、normalizeBaselineUserPath 的 D2 归一化。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_VISUAL_BASELINE_BYTES,
  USER_WORKSPACE_DIRECTORY_NAME,
  assertSafeBaselineFileName,
  assertSafeBaselineSegments,
  listVisualBaselines,
  normalizeBaselineUserPath,
  readVisualBaseline,
  resolveUserWorkspaceArtifactDirectory,
  writeVisualBaseline,
} from '../src/index'

/** 一个最小 PNG 字节序列（内容不重要，测试只关心读写与边界）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

let skillRoot: string

beforeEach(async () => {
  skillRoot = await mkdtemp(path.join(os.tmpdir(), 'visual-baseline-'))
})

afterEach(async () => {
  await rm(skillRoot, { recursive: true, force: true })
})

describe('assertSafeBaselineSegments', () => {
  it('接受合法的分组分段并去除空白项', () => {
    expect(assertSafeBaselineSegments(['preview'])).toEqual(['preview'])
    expect(assertSafeBaselineSegments(['login', 'success'])).toEqual([
      'login',
      'success',
    ])
    expect(assertSafeBaselineSegments(['  preview  ', ''])).toEqual(['preview'])
    expect(assertSafeBaselineSegments([])).toEqual([])
  })

  it('拒绝目录穿越与非法字符', () => {
    for (const bad of [
      ['..'],
      ['a/b'],
      ['a\\b'],
      ['a:b'],
      ['.'],
      ['a b'],
      ['x'.repeat(65)],
    ]) {
      expect(() => assertSafeBaselineSegments(bad)).toThrow(/不合法/)
    }
  })
})

describe('assertSafeBaselineFileName', () => {
  it('只接受 .png 结尾的安全文件名', () => {
    expect(assertSafeBaselineFileName('candidate-a.png')).toBe(
      'candidate-a.png',
    )
    expect(assertSafeBaselineFileName('a_b_c.png')).toBe('a_b_c.png')
  })

  it('拒绝非 png、路径分隔符与穿越写法', () => {
    for (const bad of [
      'a.jpg',
      'a',
      'a.png.png',
      '../a.png',
      'a/b.png',
      'a\\b.png',
      '.png',
      'a b.png',
    ]) {
      expect(() => assertSafeBaselineFileName(bad)).toThrow(/不合法/)
    }
  })
})

describe('normalizeBaselineUserPath（v14 D2 归一化）', () => {
  it('相对 userWorkSpace 解析并剥离一次前导 userWorkSpace 段', () => {
    expect(normalizeBaselineUserPath('preview')).toEqual({
      segments: ['preview'],
    })
    expect(normalizeBaselineUserPath('baselines/preview')).toEqual({
      segments: ['baselines', 'preview'],
    })
    expect(normalizeBaselineUserPath('userWorkSpace/preview')).toEqual({
      segments: ['preview'],
    })
    expect(normalizeBaselineUserPath('USERWORKSPACE/preview')).toEqual({
      segments: ['preview'],
    })
  })

  it('末段为 .png 文件名时拆分目录与文件', () => {
    expect(normalizeBaselineUserPath('preview/x.png')).toEqual({
      segments: ['preview'],
      fileName: 'x.png',
    })
    expect(normalizeBaselineUserPath('userWorkSpace/baselines/a.png')).toEqual({
      segments: ['baselines'],
      fileName: 'a.png',
    })
  })

  it('拒绝越界、绝对路径、重复 userWorkSpace 与非法段', () => {
    for (const bad of [
      '../outside',
      '/abs',
      'C:\\x',
      'userWorkSpace/userWorkSpace/x',
      'preview/../x',
      '',
      'preview/a b',
      'preview/a.png.png',
    ]) {
      expect(() => normalizeBaselineUserPath(bad)).toThrow()
    }
  })
})

describe('resolveUserWorkspaceArtifactDirectory', () => {
  it('在 userWorkSpace 下创建单层与多层分组目录（v14 换根）', async () => {
    const single = await resolveUserWorkspaceArtifactDirectory(skillRoot, [
      'preview',
    ])
    expect(single).toBe(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'preview'),
    )

    const nested = await resolveUserWorkspaceArtifactDirectory(skillRoot, [
      'login',
      'success',
    ])
    expect(nested).toBe(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME, 'login', 'success'),
    )

    // 隐式创建：用户无需手工建目录。
    const entries = await readdir(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME),
    )
    expect(entries).toContain('preview')
    expect(entries).toContain('login')
  })

  it('非法分段被拒绝', async () => {
    await expect(
      resolveUserWorkspaceArtifactDirectory(skillRoot, ['..']),
    ).rejects.toThrow(/不合法/)
  })
})

describe('writeVisualBaseline', () => {
  it('写入后返回 userWorkSpace 前缀的 POSIX 相对路径，并可原样读回', async () => {
    const relativePath = await writeVisualBaseline({
      skillRoot,
      segments: ['preview'],
      fileName: 'candidate-a.png',
      content: PNG_BYTES,
    })

    expect(relativePath).toBe('userWorkSpace/preview/candidate-a.png')

    const readBack = await readVisualBaseline({
      skillRoot,
      segments: ['preview'],
      fileName: 'candidate-a.png',
    })
    expect(Buffer.from(readBack).equals(Buffer.from(PNG_BYTES))).toBe(true)
  })

  it('多层分组同样可写可读', async () => {
    const relativePath = await writeVisualBaseline({
      skillRoot,
      segments: ['login', 'success'],
      fileName: 'home.png',
      content: PNG_BYTES,
    })

    expect(relativePath).toBe('userWorkSpace/login/success/home.png')
  })

  it('同一分组的多个候选互不覆盖（多候选语义的基础）', async () => {
    await writeVisualBaseline({
      skillRoot,
      segments: ['preview'],
      fileName: 'a.png',
      content: PNG_BYTES,
    })
    await writeVisualBaseline({
      skillRoot,
      segments: ['preview'],
      fileName: 'b.png',
      content: PNG_BYTES,
    })

    expect(await listVisualBaselines(skillRoot, ['preview'])).toEqual([
      'a.png',
      'b.png',
    ])
  })

  it('超出体积上限时拒绝写入', async () => {
    await expect(
      writeVisualBaseline({
        skillRoot,
        segments: ['preview'],
        fileName: 'big.png',
        content: new Uint8Array(MAX_VISUAL_BASELINE_BYTES + 1),
      }),
    ).rejects.toThrow(/体积上限/)
  })

  it('非法文件名被拒绝且不产生任何文件', async () => {
    await expect(
      writeVisualBaseline({
        skillRoot,
        segments: ['preview'],
        fileName: '../escape.png',
        content: PNG_BYTES,
      }),
    ).rejects.toThrow(/不合法/)

    // 穿越失败后不应留下目录外的任何痕迹。
    expect(await listVisualBaselines(skillRoot, ['preview'])).toEqual([])
  })
})

describe('readVisualBaseline', () => {
  it('文件不存在时抛出 FILE_NOT_FOUND', async () => {
    await expect(
      readVisualBaseline({
        skillRoot,
        segments: ['preview'],
        fileName: 'nope.png',
      }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })

  it('非法分段或文件名被拒绝', async () => {
    await expect(
      readVisualBaseline({ skillRoot, segments: ['..'], fileName: 'a.png' }),
    ).rejects.toThrow(/不合法/)
    await expect(
      readVisualBaseline({
        skillRoot,
        segments: ['preview'],
        fileName: '../a.png',
      }),
    ).rejects.toThrow(/不合法/)
  })
})

describe('listVisualBaselines', () => {
  it('未捕获过基线时返回空数组（目录不存在不是错误）', async () => {
    expect(await listVisualBaselines(skillRoot, ['never-captured'])).toEqual([])
    expect(await listVisualBaselines(skillRoot)).toEqual([])
  })

  it('只列出 .png 且按名称升序', async () => {
    await writeVisualBaseline({
      skillRoot,
      segments: ['p'],
      fileName: 'c.png',
      content: PNG_BYTES,
    })
    await writeVisualBaseline({
      skillRoot,
      segments: ['p'],
      fileName: 'a.png',
      content: PNG_BYTES,
    })
    await writeVisualBaseline({
      skillRoot,
      segments: ['p'],
      fileName: 'b.png',
      content: PNG_BYTES,
    })

    expect(await listVisualBaselines(skillRoot, ['p'])).toEqual([
      'a.png',
      'b.png',
      'c.png',
    ])
  })
})
