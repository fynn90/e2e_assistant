import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { getPlatformRuntimePath } from '../../src/infrastructure/config/config-path'
import {
  inspectPlatformRuntimeState,
  loadPlatformRuntimeState,
  savePlatformRuntimeState,
} from '../../src/infrastructure/config/runtime-store'

let tempRoot = ''
const originalAppData = process.env.APPDATA
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-runtime-test-'))
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

describe('platform runtime store', () => {
  it('persists exactly the contract fields with secure permissions', async () => {
    // 运行态文件不得写入契约之外的任何字段（例如历史版本的实例令牌），
    // 多余字段会成为需要长期维护的隐式协议。
    await savePlatformRuntimeState({
      pid: process.pid,
      port: 5826,
      serverUrl: 'http://127.0.0.1:5826',
      startedAt: '2026-07-16T00:00:00.000Z',
      mode: 'foreground',
    })

    const runtimePath = getPlatformRuntimePath()
    const runtimeContent = await readFile(runtimePath, 'utf-8')

    expect(JSON.parse(runtimeContent)).toEqual({
      pid: process.pid,
      port: 5826,
      serverUrl: 'http://127.0.0.1:5826',
      startedAt: '2026-07-16T00:00:00.000Z',
      mode: 'foreground',
    })

    if (process.platform !== 'win32') {
      expect((await stat(runtimePath)).mode & 0o777).toBe(0o600)
    }
  })

  it('persists and reads back the v19 fields (mode / shutdownToken)', async () => {
    await savePlatformRuntimeState({
      pid: process.pid,
      port: 5826,
      serverUrl: 'http://127.0.0.1:5826',
      startedAt: '2026-07-16T00:00:00.000Z',
      mode: 'background',
      shutdownToken: 'shutdown-token-1',
    })

    await expect(inspectPlatformRuntimeState()).resolves.toEqual({
      state: 'present',
      runtimeState: {
        pid: process.pid,
        port: 5826,
        serverUrl: 'http://127.0.0.1:5826',
        startedAt: '2026-07-16T00:00:00.000Z',
        mode: 'background',
        shutdownToken: 'shutdown-token-1',
      },
    })
  })

  it('degrades a missing or illegal mode to foreground instead of rejecting the record', async () => {
    // 旧记录没有 mode 字段：判「记录损坏」会让升级后的第一次 stop 直接报错。
    for (const mode of [undefined, 'weird-value', 42]) {
      await writeRawRuntime(
        JSON.stringify({
          pid: 100,
          port: 5826,
          serverUrl: 'http://127.0.0.1:5826',
          startedAt: '2026-07-16T00:00:00.000Z',
          ...(mode === undefined ? {} : { mode }),
        }),
      )

      const inspection = await inspectPlatformRuntimeState()

      expect(inspection.state).toBe('present')
      expect(inspection.runtimeState?.mode).toBe('foreground')
      expect(inspection.runtimeState?.shutdownToken).toBeUndefined()
    }
  })

  it('drops a non-string shutdownToken but keeps the record', async () => {
    await writeRawRuntime(
      JSON.stringify({
        pid: 100,
        port: 5826,
        serverUrl: 'http://127.0.0.1:5826',
        startedAt: '2026-07-16T00:00:00.000Z',
        mode: 'background',
        shutdownToken: { not: 'a string' },
      }),
    )

    const inspection = await inspectPlatformRuntimeState()

    expect(inspection.state).toBe('present')
    expect(inspection.runtimeState?.shutdownToken).toBeUndefined()
  })

  it('reports a missing record without throwing', async () => {
    await expect(inspectPlatformRuntimeState()).resolves.toEqual({
      state: 'missing',
      runtimeState: null,
    })
    await expect(loadPlatformRuntimeState()).resolves.toBeNull()
  })

  it('treats a record with corrupted JSON as invalid instead of throwing', async () => {
    // 损坏的记录必须可被后续启动正常覆盖，而不是要求用户手工删除文件。
    await writeRawRuntime('{ this is not json')

    await expect(inspectPlatformRuntimeState()).resolves.toEqual({
      state: 'invalid',
      runtimeState: null,
    })
    await expect(loadPlatformRuntimeState()).resolves.toBeNull()
  })

  it('rejects records whose required fields are missing or illegal', async () => {
    const illegalRecords = [
      {
        port: 5826,
        serverUrl: 'http://127.0.0.1:5826',
        startedAt: '2026-07-16T00:00:00.000Z',
      },
      {
        pid: 0,
        port: 5826,
        serverUrl: 'http://127.0.0.1:5826',
        startedAt: '2026-07-16T00:00:00.000Z',
      },
      {
        pid: 100,
        port: 0,
        serverUrl: 'http://127.0.0.1:5826',
        startedAt: '2026-07-16T00:00:00.000Z',
      },
      {
        pid: 100,
        port: 5826,
        serverUrl: '',
        startedAt: '2026-07-16T00:00:00.000Z',
      },
      {
        pid: 100,
        port: 5826,
        serverUrl: 'http://127.0.0.1:5826',
        startedAt: 123,
      },
    ]

    for (const illegalRecord of illegalRecords) {
      await writeRawRuntime(JSON.stringify(illegalRecord))

      await expect(inspectPlatformRuntimeState()).resolves.toEqual({
        state: 'invalid',
        runtimeState: null,
      })
    }
  })

  it('returns the record when every contract field is valid', async () => {
    await writeRawRuntime(
      JSON.stringify({
        pid: 100,
        port: 5826,
        serverUrl: 'http://127.0.0.1:5826',
        startedAt: '2026-07-16T00:00:00.000Z',
      }),
    )

    await expect(inspectPlatformRuntimeState()).resolves.toEqual({
      state: 'present',
      runtimeState: {
        pid: 100,
        port: 5826,
        serverUrl: 'http://127.0.0.1:5826',
        startedAt: '2026-07-16T00:00:00.000Z',
        // v19：解析结果里 mode 总是有值（缺失即前台），调用方无需再处理 undefined。
        mode: 'foreground',
      },
    })
  })
})

async function writeRawRuntime(content: string): Promise<void> {
  const runtimePath = getPlatformRuntimePath()
  await mkdir(path.dirname(runtimePath), { recursive: true })
  await writeFile(runtimePath, content, 'utf-8')
}
