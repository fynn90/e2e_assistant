/**
 * 后台服务日志文件的路径 / 轮转 / 尾部读取 / 跟随测试（v19 §3.3 / AC-03）。
 *
 * 用临时目录隔离配置目录（沿用既有 `APPDATA` / `XDG_CONFIG_HOME` 手法），
 * 不触碰真实用户的日志文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  followServiceLog,
  getServiceLogPath,
  readServiceLogTail,
  rotateServiceLogIfNeeded,
  SERVICE_LOG_ROTATE_THRESHOLD_BYTES,
} from '../../src/infrastructure/log/log-file'

let tempRoot = ''
const originalAppData = process.env.APPDATA
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-log-test-'))
  process.env.APPDATA = path.join(tempRoot, 'app-data')
  process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config-home')
})

afterEach(async () => {
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  await rm(tempRoot, { recursive: true, force: true })
})

async function writeLog(content: string): Promise<void> {
  const logPath = getServiceLogPath()
  await mkdir(path.dirname(logPath), { recursive: true })
  await writeFile(logPath, content, 'utf-8')
}

describe('getServiceLogPath', () => {
  it('落在配置目录的 logs 子目录下', () => {
    // 不引入第二个用户级根目录（PRD Q3）。
    const logPath = getServiceLogPath()

    expect(path.basename(logPath)).toBe('service.log')
    expect(path.basename(path.dirname(logPath))).toBe('logs')
    // 落在被隔离的临时配置目录内（不触碰真实用户目录）。
    expect(logPath.startsWith(tempRoot)).toBe(true)
  })
})

describe('rotateServiceLogIfNeeded', () => {
  it('超过阈值时轮转为 service.log.1', async () => {
    await writeLog('x'.repeat(SERVICE_LOG_ROTATE_THRESHOLD_BYTES + 1))

    const result = await rotateServiceLogIfNeeded()

    expect(result).toEqual({ rotated: true, failureReason: null })
    // 当前文件已不存在（等待新内容写入），旧文件保存内容。
    await expect(stat(getServiceLogPath())).rejects.toThrow()
    expect((await stat(`${getServiceLogPath()}.1`)).size).toBe(
      SERVICE_LOG_ROTATE_THRESHOLD_BYTES + 1,
    )
  })

  it('未超过阈值时不轮转', async () => {
    await writeLog('x'.repeat(1024))

    expect(await rotateServiceLogIfNeeded()).toEqual({
      rotated: false,
      failureReason: null,
    })
    expect((await stat(getServiceLogPath())).size).toBe(1024)
  })

  it('文件不存在时不轮转，也不算失败', async () => {
    // 从未后台启动过时属正常情况，不该给用户报「轮转失败」。
    expect(await rotateServiceLogIfNeeded()).toEqual({
      rotated: false,
      failureReason: null,
    })
  })

  it('轮转失败时返回原因而不是自行打印', async () => {
    // 构造失败：把 .1 的目标位置占成一个**非空目录**——`rm(force: true)` 删不掉
    // 非空目录，rename 随之失败。日志文件本身要超过阈值，否则根本走不到轮转。
    await writeLog('x'.repeat(SERVICE_LOG_ROTATE_THRESHOLD_BYTES + 1))
    const rotatedLogPath = `${getServiceLogPath()}.1`
    await mkdir(path.join(rotatedLogPath, 'occupied'), { recursive: true })

    const result = await rotateServiceLogIfNeeded()

    expect(result.rotated).toBe(false)
    expect(result.failureReason).toContain('轮转失败')
  })

  it('已存在 .1 时被覆盖（只留一份旧文件）', async () => {
    // 只留一份旧文件：体积不能随轮转次数无限累积（R3）。
    await writeLog('x'.repeat(SERVICE_LOG_ROTATE_THRESHOLD_BYTES + 1))
    const rotatedLogPath = `${getServiceLogPath()}.1`
    await writeFile(rotatedLogPath, 'old-content', 'utf-8')

    await rotateServiceLogIfNeeded()

    expect((await stat(rotatedLogPath)).size).toBe(
      SERVICE_LOG_ROTATE_THRESHOLD_BYTES + 1,
    )
  })
})

describe('readServiceLogTail', () => {
  it('返回最后 N 行', async () => {
    await writeLog(['line-1', 'line-2', 'line-3', 'line-4'].join('\n'))

    expect(await readServiceLogTail({ maxLines: 2 })).toBe('line-3\nline-4')
    expect(await readServiceLogTail({ maxLines: 100 })).toBe(
      'line-1\nline-2\nline-3\nline-4',
    )
  })

  it('文件不存在时返回 null（区分「空日志」与「没有日志」）', async () => {
    expect(await readServiceLogTail({ maxLines: 10 })).toBeNull()
  })

  it('末尾换行不被当作额外的空行', async () => {
    await writeLog('line-1\nline-2\n')

    expect(await readServiceLogTail({ maxLines: 2 })).toBe('line-1\nline-2')
  })
})

describe('followServiceLog', () => {
  it('追加的行被回调（只回调完整行）', async () => {
    await writeLog('existing\n')
    const received: string[] = []
    const abortController = new AbortController()

    const followPromise = followServiceLog({
      signal: abortController.signal,
      pollIntervalMs: 5,
      onLines: (lines) => received.push(...lines),
    })

    await waitFor(() => true)
    await appendFile(getServiceLogPath(), 'new-line-1\n', 'utf-8')
    await waitFor(() => received.length >= 1)
    abortController.abort()
    await followPromise

    expect(received).toEqual(['new-line-1'])
  })

  it('半行不回调，写完整后才回调', async () => {
    await writeLog('')
    const received: string[] = []
    const abortController = new AbortController()

    const followPromise = followServiceLog({
      signal: abortController.signal,
      pollIntervalMs: 5,
      onLines: (lines) => received.push(...lines),
    })

    await waitFor(() => true)
    // 只写半行：跟随器应保持沉默（否则一行会被拆成两次打印）。
    await appendFile(
      getServiceLogPath(),
      'partial line without newline',
      'utf-8',
    )
    await waitFor(() => true, 3)
    expect(received).toEqual([])

    // 补上换行与下一行：两行一次性到达。
    await appendFile(
      getServiceLogPath(),
      ' is now complete\nsecond-line\n',
      'utf-8',
    )
    await waitFor(() => received.length >= 2)
    abortController.abort()
    await followPromise

    expect(received).toEqual([
      'partial line without newline is now complete',
      'second-line',
    ])
  })

  it('日志被轮转后从新文件头继续，不卡死', async () => {
    // §4.3 异常表：log 跟随中日志被轮转 → 自动从头跟随新文件，不中断。
    await writeLog('before-rotate\n')
    const received: string[] = []
    const abortController = new AbortController()

    const followPromise = followServiceLog({
      signal: abortController.signal,
      pollIntervalMs: 5,
      onLines: (lines) => received.push(...lines),
    })

    await waitFor(() => true)
    await appendFile(getServiceLogPath(), 'line-before\n', 'utf-8')
    await waitFor(() => received.includes('line-before'))

    // 模拟轮转：新文件更小，偏移必须重置。
    await writeFile(getServiceLogPath(), '', 'utf-8')
    await waitFor(() => true, 2)
    await appendFile(getServiceLogPath(), 'line-after-rotate\n', 'utf-8')
    await waitFor(() => received.includes('line-after-rotate'))

    abortController.abort()
    await followPromise

    expect(received).toContain('line-before')
    expect(received).toContain('line-after-rotate')
  })

  it('signal 中止后跟随循环退出', async () => {
    await writeLog('existing\n')
    const abortController = new AbortController()

    const followPromise = followServiceLog({
      signal: abortController.signal,
      pollIntervalMs: 5,
      onLines: () => undefined,
    })

    abortController.abort()

    await expect(followPromise).resolves.toBeUndefined()
  })
})

/**
 * 等待条件成立（或等待若干轮询周期）。
 *
 * @param predicate - 条件；恒真时表示「只等一拍」。
 * @param maxAttempts - 最大尝试次数。
 * @returns 条件成立或无更多尝试时兑现。
 */
async function waitFor(
  predicate: () => boolean,
  maxAttempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
