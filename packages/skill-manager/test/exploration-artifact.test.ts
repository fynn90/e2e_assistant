/**
 * 页面探查产物（v12-pre）的单元测试。
 *
 * 重点覆盖安全边界与落盘位置：
 *   - 会话 ID 与文件名白名单（目录穿越的第一道防线）；
 *   - 路径归一化后的前缀校验（双保险）；
 *   - 单张截图的体积上限；
 *   - **产物落在 temp/ 之下**（用户不可见，随任务终态清理）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXPLORATION_DIRECTORY_NAME,
  TEMP_DIRECTORY_NAME,
  assertSafeScreenshotFileName,
  cleanupTempWorkspace,
  readExplorationScreenshot,
  resolveExplorationSessionDirectory,
  writeExplorationScreenshot,
} from '../src/index'

/** 一个最小 PNG 字节序列（内容不重要，测试只关心读写与边界）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

let skillRoot: string

beforeEach(async () => {
  skillRoot = await mkdtemp(path.join(os.tmpdir(), 'exploration-test-'))
})

afterEach(async () => {
  await rm(skillRoot, { recursive: true, force: true })
})

describe('writeExplorationScreenshot', () => {
  it('写入截图，落在 temp/exploration 下并返回相对 temp/ 的路径', async () => {
    const relativePath = await writeExplorationScreenshot({
      skillRoot,
      sessionId: 'sess_1',
      fileName: '1758400000000-00.png',
      content: PNG_BYTES,
    })

    expect(relativePath).toBe('exploration/sess_1/1758400000000-00.png')
    expect(
      existsSync(
        path.join(
          skillRoot,
          TEMP_DIRECTORY_NAME,
          EXPLORATION_DIRECTORY_NAME,
          'sess_1',
          '1758400000000-00.png',
        ),
      ),
    ).toBe(true)
    // 产物必须位于 temp/ 之内：任务终态删 temp/ 时随之消失（用户不可见、不长期保留）。
    expect(existsSync(path.join(skillRoot, EXPLORATION_DIRECTORY_NAME))).toBe(
      false,
    )
  })

  it('拒绝会话 ID 中的目录穿越', async () => {
    for (const sessionId of ['../escape', 'a/b', 'a\\b', '..', '']) {
      await expect(
        writeExplorationScreenshot({
          skillRoot,
          sessionId,
          fileName: '1758400000000-00.png',
          content: PNG_BYTES,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
    }
  })

  it('拒绝非白名单格式的文件名', async () => {
    for (const fileName of [
      'shot.png',
      '../escape.png',
      '1758400000000-00.png.exe',
      '1758400000000.png',
      '1758400000000-00.PNG',
    ]) {
      await expect(
        writeExplorationScreenshot({
          skillRoot,
          sessionId: 'sess_1',
          fileName,
          content: PNG_BYTES,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
    }
  })

  it('超过单张体积上限时拒绝保存', async () => {
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1)

    await expect(
      writeExplorationScreenshot({
        skillRoot,
        sessionId: 'sess_1',
        fileName: '1758400000000-00.png',
        content: oversized,
      }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_SUPPORTED' })
  })
})

describe('readExplorationScreenshot', () => {
  it('读取已写入的截图字节', async () => {
    await writeExplorationScreenshot({
      skillRoot,
      sessionId: 'sess_1',
      fileName: '1758400000000-00.png',
      content: PNG_BYTES,
    })

    const content = await readExplorationScreenshot({
      skillRoot,
      sessionId: 'sess_1',
      fileName: '1758400000000-00.png',
    })

    expect(Array.from(content)).toEqual(Array.from(PNG_BYTES))
  })

  it('文件不存在时报 404 语义的错误码', async () => {
    await expect(
      readExplorationScreenshot({
        skillRoot,
        sessionId: 'sess_1',
        fileName: '1758400000000-00.png',
      }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })

  it('路径非法时优先报路径错误，而不是泄漏文件是否存在', async () => {
    await expect(
      readExplorationScreenshot({
        skillRoot,
        sessionId: '../escape',
        fileName: '1758400000000-00.png',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_PATH' })
  })
})

describe('resolveExplorationSessionDirectory', () => {
  it('返回 temp/ 之下的绝对路径并自动创建目录', async () => {
    const directory = await resolveExplorationSessionDirectory(
      skillRoot,
      'sess_1',
    )

    expect(directory).toBe(
      path.join(
        skillRoot,
        TEMP_DIRECTORY_NAME,
        EXPLORATION_DIRECTORY_NAME,
        'sess_1',
      ),
    )
    expect(existsSync(directory)).toBe(true)
  })
})

describe('assertSafeScreenshotFileName', () => {
  it('接受合法文件名并原样返回', () => {
    expect(assertSafeScreenshotFileName('1758400000000-00.png')).toBe(
      '1758400000000-00.png',
    )
  })
})

describe('与 temp/ 生命周期的关系', () => {
  it('清理 temp/ 时探查截图一并消失（任务终态不保留）', async () => {
    await writeExplorationScreenshot({
      skillRoot,
      sessionId: 'sess_1',
      fileName: '1758400000000-00.png',
      content: PNG_BYTES,
    })

    const screenshotPath = path.join(
      skillRoot,
      TEMP_DIRECTORY_NAME,
      EXPLORATION_DIRECTORY_NAME,
      'sess_1',
      '1758400000000-00.png',
    )
    expect(existsSync(screenshotPath)).toBe(true)

    // 任务终态清理 temp/（由 temp-workspace 的 cleanup 负责）：
    // 探查产物随之消失，无需（也不应有）独立的淘汰机制。
    await cleanupTempWorkspace(skillRoot, [])

    expect(existsSync(screenshotPath)).toBe(false)
    expect(existsSync(path.join(skillRoot, TEMP_DIRECTORY_NAME))).toBe(false)
  })
})
