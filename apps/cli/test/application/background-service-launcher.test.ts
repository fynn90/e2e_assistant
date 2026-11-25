/**
 * 后台服务启动器测试（v19 §3.2–§3.4）。
 *
 * 锁定的性质：复用分支不派生不轮转（日志与记录的归属唯一）、状态无法确认时
 * 拒绝派生、就绪判据的四条缺一不可（记录新鲜度 / 存活 / 探测身份 / pid 一致）、
 * 失败时必须把「为什么」摆给用户。
 *
 * 全新依赖以替身注入，测试不派生真实进程、不触达真实端口。
 */
import { describe, expect, it, vi } from 'vitest'
import { LOCAL_SERVICE_PROTOCOL_VERSION } from '@fynn90-e2e_assistant/types'
import {
  launchBackgroundService,
  type IBackgroundLauncherDependencies,
  type ISpawnedServiceProcess,
} from '../../src/application/background-service-launcher'
import type {
  IPlatformRuntimeState,
  TPlatformRuntimeInspection,
} from '../../src/infrastructure/config/runtime-store'
import type { TLocalServiceProbeResult } from '../../src/infrastructure/http/service-probe'

/** 派生子进程的替身 pid；就绪记录必须指向它（否则会被判为不是本次服务）。 */
const CHILD_PID = 7777
const RECORDED_PID = CHILD_PID
const RECORDED_PORT = 5826
const RECORDED_SERVER_URL = `http://127.0.0.1:${RECORDED_PORT}`
const LOG_PATH = 'C:/fake-config/logs/service.log'

function createBackgroundRecord (): TPlatformRuntimeInspection {
  return {
    state: 'present',
    runtimeState: {
      pid: RECORDED_PID,
      port: RECORDED_PORT,
      serverUrl: RECORDED_SERVER_URL,
      startedAt: '2026-09-28T01:22:34.557Z',
      mode: 'background',
      shutdownToken: 'token-from-record',
    },
  }
}

/**
 * 「本次启动之后写入」的后台记录。
 *
 * v21 起就绪判据以**写入时刻**识别本次服务（Windows 隐藏控制台派生下，派生壳 PID
 * 与服务 PID 不同），因此需要按调用时刻生成时间戳。
 *
 * @param overrides - 需要覆盖的记录字段（例如 pid）。
 * @returns 时间戳为当前时刻的后台记录。
 */
function freshBackgroundRecord (
  overrides: Partial<IPlatformRuntimeState> = {},
): TPlatformRuntimeInspection {
  return {
    state: 'present',
    runtimeState: {
      pid: RECORDED_PID,
      port: RECORDED_PORT,
      serverUrl: RECORDED_SERVER_URL,
      startedAt: new Date().toISOString(),
      mode: 'background',
      shutdownToken: 'token-from-record',
      ...overrides,
    },
  }
}

/** 尚未就绪时的记录读取结果（启动中的服务还没有记录）。 */
function missingRecord (): TPlatformRuntimeInspection {
  return { state: 'missing', runtimeState: null }
}

/**
 * 构造依赖替身；未显式指定的项都有安全的默认值（端口空闲、立即就绪）。
 *
 * @param overrides - 需要覆盖的依赖项。
 * @returns 依赖集合。
 */
function createDependencies (
  overrides: Partial<IBackgroundLauncherDependencies> = {},
): IBackgroundLauncherDependencies {
  return {
    ensurePlatformConfigStorage: async () => undefined,
    inspectPlatformRuntimeState: async () => missingRecord(),
    isPlatformProcessAlive: () => true,
    probeLocalService: async () => ({
      outcome: 'unreachable',
      reason: 'refused',
    }),
    ensureSecureDirectory: async () => undefined,
    ensureSecureFile: async () => undefined,
    rotateServiceLogIfNeeded: async () => ({
      rotated: false,
      failureReason: null,
    }),
    readServiceLogTail: async () => 'fake log tail',
    getServiceLogPath: () => LOG_PATH,
    probeBashShell: () => ({ outcome: 'found', path: '/fake/bash' }),
    ensureHiddenLaunchScript: async () => undefined,
    clearPlatformRuntimeState: async () => undefined,
    spawnBackgroundServiceProcess: () => createChildStub(),
    terminateProcess: () => true,
    readyTimeoutMs: 1000,
    readyPollIntervalMs: 1,
    sleep: async () => undefined,
    ...overrides,
  }
}

/**
 * 子进程替身。
 *
 * @param exitCode - 退出的码；传 `'never'` 表示永不退出（用于触发就绪超时路径）。
 * @returns 子进程句柄替身。
 */
function createChildStub (
  exitCode: null | number | 'never' = 'never',
): ISpawnedServiceProcess {
  return {
    pid: CHILD_PID,
    waitForExit: () =>
      exitCode === 'never'
        ? new Promise<number | null>(() => { })
        : Promise.resolve(exitCode),
  }
}

function probeReturning (result: TLocalServiceProbeResult) {
  return async () => result
}

/**
 * 构造「下一次读取就绪记录」的读取实现。
 *
 * 首次读取（派生前的探测）必须返回未运行，否则会短路到复用分支；
 * 之后的读取返回给定的记录，用于驱动就绪判据。
 *
 * @param readyRecord - 派生后各次读取返回的记录；缺省为后台记录。
 * @returns 读取实现。
 */
function inspectBecomingReady (
  readyRecord: () => TPlatformRuntimeInspection = freshBackgroundRecord,
): () => Promise<TPlatformRuntimeInspection> {
  let hasLaunched = false

  return async () => {
    if (!hasLaunched) {
      hasLaunched = true
      return missingRecord()
    }

    return readyRecord()
  }
}

function confirmedProbe (
  pid: number = RECORDED_PID,
  version: number = LOCAL_SERVICE_PROTOCOL_VERSION,
) {
  return probeReturning({
    outcome: 'confirmed',
    version,
    pid,
  })
}

describe('launchBackgroundService', () => {
  it('reuses a running background service without spawning or rotating the log', async () => {
    // 复用分支不轮转日志：日志文件的归属跟随服务进程，轮转会让正在运行的服务
    // 突然换文件（§3.2）。
    const spawnBackgroundServiceProcess = vi.fn(() => createChildStub())
    const rotateServiceLogIfNeeded = vi.fn(async () => ({
      rotated: true,
      failureReason: null,
    }))
    const clearPlatformRuntimeState = vi.fn(async () => undefined)
    const ensureHiddenLaunchScript = vi.fn(async () => undefined)

    const result = await launchBackgroundService(
      { port: RECORDED_PORT, shouldOpen: false },
      createDependencies({
        inspectPlatformRuntimeState: async () => createBackgroundRecord(),
        probeLocalService: confirmedProbe(),
        spawnBackgroundServiceProcess,
        rotateServiceLogIfNeeded,
        clearPlatformRuntimeState,
        ensureHiddenLaunchScript,
      }),
    )

    expect(result).toEqual({
      outcome: 'reused',
      port: RECORDED_PORT,
      serverUrl: RECORDED_SERVER_URL,
      logPath: LOG_PATH,
      // 复用分支的进程号与启动时刻取自运行态记录（面板据此展示）。
      pid: RECORDED_PID,
      startedAt: '2026-09-28T01:22:34.557Z',
      // 复用分支不重新探测 bash：被复用的服务早在自己启动时就探过了。
      shellProbe: { outcome: 'not-applicable' },
    })
    expect(spawnBackgroundServiceProcess).not.toHaveBeenCalled()
    expect(rotateServiceLogIfNeeded).not.toHaveBeenCalled()
    // 复用分支不得碰运行态记录与启动脚本：正在运行的服务仍然是记录的所有者。
    expect(clearPlatformRuntimeState).not.toHaveBeenCalled()
    expect(ensureHiddenLaunchScript).not.toHaveBeenCalled()
  })

  it('refuses to spawn when the state cannot be confirmed', async () => {
    // 无法确认状态时端口可能被未知服务占用；派生会让新实例顺延端口并
    // 覆盖记录，使仍可能存活的服务失去可管理性。
    const spawnBackgroundServiceProcess = vi.fn(() => createChildStub())

    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: async () => createBackgroundRecord(),
          probeLocalService: probeReturning({
            outcome: 'unreachable',
            reason: 'timeout',
          }),
          spawnBackgroundServiceProcess,
        }),
      ),
    ).rejects.toThrow(/无法确认/)

    expect(spawnBackgroundServiceProcess).not.toHaveBeenCalled()
  })

  it('spawns, waits for readiness and reports the running address', async () => {
    const spawnBackgroundServiceProcess = vi.fn(() => createChildStub())

    const result = await launchBackgroundService(
      { port: RECORDED_PORT, shouldOpen: false },
      createDependencies({
        inspectPlatformRuntimeState: inspectBecomingReady(),
        probeLocalService: confirmedProbe(),
        spawnBackgroundServiceProcess,
      }),
    )

    expect(result.outcome).toBe('started')
    expect(result.port).toBe(RECORDED_PORT)
    expect(result.serverUrl).toBe(RECORDED_SERVER_URL)
    expect(spawnBackgroundServiceProcess).toHaveBeenCalledWith(
      expect.objectContaining({ port: RECORDED_PORT, logPath: LOG_PATH }),
    )
  })

  it('rotates the log before spawning a new process', async () => {
    const rotateServiceLogIfNeeded = vi.fn(async () => ({
      rotated: true,
      failureReason: null,
    }))

    await launchBackgroundService(
      { port: RECORDED_PORT, shouldOpen: false },
      createDependencies({
        inspectPlatformRuntimeState: inspectBecomingReady(),
        probeLocalService: confirmedProbe(),
        rotateServiceLogIfNeeded,
      }),
    )

    expect(rotateServiceLogIfNeeded).toHaveBeenCalledTimes(1)
  })

  it('does not treat a foreground record as ready', async () => {
    // 就绪判据第一条要求 mode === 'background'。构造「派生后立刻出现一条前台记录」
    // 的场景（记录里没有本进程的模式标记）——启动器必须继续等，直到超时。
    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: inspectBecomingReady(() => ({
            state: 'present',
            runtimeState: {
              pid: RECORDED_PID,
              port: RECORDED_PORT,
              serverUrl: RECORDED_SERVER_URL,
              startedAt: '2026-09-28T01:22:34.557Z',
              mode: 'foreground',
            },
          })),
          probeLocalService: confirmedProbe(),
          readyTimeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(/超时/)
  })

  it('does not treat a dead pid as ready', async () => {
    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: inspectBecomingReady(),
          // 记录在但进程已死：唯一能信的是探测与存活的组合。
          isPlatformProcessAlive: () => false,
          probeLocalService: confirmedProbe(),
          readyTimeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(/超时/)
  })

  it('does not treat an unconfirmed probe as ready', async () => {
    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: inspectBecomingReady(),
          probeLocalService: probeReturning({
            outcome: 'unreachable',
            reason: 'timeout',
          }),
          readyTimeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(/超时/)
  })

  it('does not treat a stale record as ready', async () => {
    // 上一轮留下的陈旧记录：即使 pid 存活、探测也确认，写入时刻早于本次启动就
    // 不能当作本次服务（派生前已清理记录，这里是并发启动/清理失败的第二道防线）。
    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: inspectBecomingReady(() => ({
            state: 'present',
            runtimeState: {
              pid: RECORDED_PID,
              port: RECORDED_PORT,
              serverUrl: RECORDED_SERVER_URL,
              startedAt: '2026-09-28T01:22:34.557Z',
              mode: 'background',
            },
          })),
          probeLocalService: confirmedProbe(),
          readyTimeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(/超时/)
  })

  it('treats a fresh record with a different pid as ready', async () => {
    // Windows 上服务经 wscript 以隐藏控制台派生：派生壳 PID 与服务 PID 不同，
    // 因此「记录 pid 不等于派生 PID」不再是拒绝理由，写入时刻才是判据。
    const servicePid = RECORDED_PID + 1

    const result = await launchBackgroundService(
      { port: RECORDED_PORT, shouldOpen: false },
      createDependencies({
        inspectPlatformRuntimeState: inspectBecomingReady(() =>
          freshBackgroundRecord({ pid: servicePid }),
        ),
        probeLocalService: confirmedProbe(servicePid),
      }),
    )

    expect(result.outcome).toBe('started')
    expect(result.pid).toBe(servicePid)
  })

  it('does not treat a pid mismatch as ready', async () => {
    // 端口上应答的是另一个实例：记录里的 pid 与响应者不符，不能据此宣布就绪。
    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: inspectBecomingReady(),
          probeLocalService: confirmedProbe(9999),
          readyTimeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(/超时/)
  })

  it('reports the exit code and log tail when the child exits before readiness', async () => {
    const readServiceLogTail = vi.fn(async () => '启动失败：端口已被占用')

    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: async () => missingRecord(),
          spawnBackgroundServiceProcess: () => createChildStub(1),
          readServiceLogTail,
          readyTimeoutMs: 500,
        }),
      ),
    ).rejects.toThrow(/退出码 1[\s\S]*端口已被占用/)

    expect(readServiceLogTail).toHaveBeenCalled()
  })

  it('terminates the child and prints the log tail on readiness timeout', async () => {
    // 超时不留半死的后台进程（场景 8）。
    const terminateProcess = vi.fn(() => true)
    const readServiceLogTail = vi.fn(async () => '最后一行日志')

    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: async () => missingRecord(),
          terminateProcess,
          readServiceLogTail,
          readyTimeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(/超时[\s\S]*最后一行日志/)

    expect(terminateProcess).toHaveBeenCalledWith(CHILD_PID)
  })

  it('terminates the freshly recorded service process on readiness timeout', async () => {
    // Windows 派生壳与服务不是同一个 PID：超时必须先结束记录里的服务进程，
    // 否则会留下一个已经开始监听、却永远不被管理起来的半死服务。
    const servicePid = RECORDED_PID + 1
    const terminateProcess = vi.fn(() => true)

    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: inspectBecomingReady(() =>
            freshBackgroundRecord({ pid: servicePid }),
          ),
          probeLocalService: probeReturning({
            outcome: 'unreachable',
            reason: 'timeout',
          }),
          terminateProcess,
          readyTimeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(/超时/)

    expect(terminateProcess).toHaveBeenCalledWith(servicePid)
    expect(terminateProcess).toHaveBeenCalledWith(CHILD_PID)
  })

  it('hardens the log file permissions before spawning (POSIX)', async () => {
    // 日志可能含工作区路径与接口调用记录：与 runtime.json 同级（0600）。
    // 用 ensureSecureFile 而非只靠 openSync 的 mode——后者对已存在文件无效，
    // 而 .1 轮转件与升级前留下的日志都应被一并收敛。
    const ensureSecureFile = vi.fn(async () => undefined)
    const ensureSecureDirectory = vi.fn(async () => undefined)

    await launchBackgroundService(
      { port: RECORDED_PORT, shouldOpen: false },
      createDependencies({
        inspectPlatformRuntimeState: inspectBecomingReady(),
        probeLocalService: confirmedProbe(),
        ensureSecureDirectory,
        ensureSecureFile,
      }),
    )

    expect(ensureSecureFile).toHaveBeenCalledWith(LOG_PATH)
    // 目录先于文件收敛。
    expect(ensureSecureDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      ensureSecureFile.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('fails with the path when the log directory cannot be created', async () => {
    // 不静默降级为「不落盘」：后台服务的日志是它唯一的可观测面。
    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: async () => missingRecord(),
          ensureSecureDirectory: async () => {
            throw new Error('EACCES')
          },
        }),
      ),
    ).rejects.toThrow(/日志目录[\s\S]*EACCES/)
  })

  it('rejects a running service whose protocol version differs', async () => {
    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: async () => createBackgroundRecord(),
          probeLocalService: confirmedProbe(
            RECORDED_PID,
            LOCAL_SERVICE_PROTOCOL_VERSION - 1,
          ),
        }),
      ),
    ).rejects.toThrow(/协议版本/)
  })

  it('rejects reuse when strict port requires a different port', async () => {
    await expect(
      launchBackgroundService(
        { port: RECORDED_PORT + 1, strictPort: true, shouldOpen: false },
        createDependencies({
          inspectPlatformRuntimeState: async () => createBackgroundRecord(),
          probeLocalService: confirmedProbe(),
        }),
      ),
    ).rejects.toThrow(/已运行在端口/)
  })
})
