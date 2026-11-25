/**
 * 服务生命周期编排测试。
 *
 * 覆盖此前完全无测试的两条链路（启动时的「已在运行」判定、停止时的进程结束），
 * 重点是固化本次修复的安全性质：
 *   - 判定服务存活必须依据健康探测确认身份，不能只凭 PID 存在；
 *   - 只有在拿到「服务确实已消失」的正面证据时才允许清理记录或结束进程；
 *   - 无法确认状态时必须保留记录、不结束任何进程，并报出可执行的错误。
 *
 * 全部依赖以替身注入，测试不会触达真实进程、端口或网络。
 */
import { describe, expect, it, vi } from 'vitest'
import process from 'node:process'
import { LOCAL_SERVICE_PROTOCOL_VERSION } from '@authine-e2e-agent/types'
import {
  startPlatformService,
  stopPlatformService,
  type IServiceLifecycleDependencies,
} from '../../src/application/service-lifecycle'
import type { TPlatformRuntimeInspection } from '../../src/infrastructure/config/runtime-store'
import type { TLocalServiceProbeResult } from '../../src/infrastructure/http/service-probe'

const RECORDED_PID = 4242
const RECORDED_PORT = 5826
const RECORDED_SERVER_URL = `http://127.0.0.1:${RECORDED_PORT}`

const PRESENT_RECORD: TPlatformRuntimeInspection = {
  state: 'present',
  runtimeState: {
    pid: RECORDED_PID,
    port: RECORDED_PORT,
    serverUrl: RECORDED_SERVER_URL,
    startedAt: '2026-09-28T01:22:34.557Z',
    // 旧记录形态：无 mode / shutdownToken（v19 §4.1 的防御性默认输入）。
    mode: 'foreground',
  },
}

/** v19 的后台记录形态：带一次性关闭凭据，`stop` 据此走优雅关闭端点。 */
const RECORD_WITH_TOKEN: TPlatformRuntimeInspection = {
  state: 'present',
  runtimeState: {
    pid: RECORDED_PID,
    port: RECORDED_PORT,
    serverUrl: RECORDED_SERVER_URL,
    startedAt: '2026-09-28T01:22:34.557Z',
    mode: 'background',
    shutdownToken: 'test-shutdown-token',
  },
}

/** 构造依赖替身；未显式指定的项都有安全的默认值。 */
function createDependencies(
  overrides: Partial<IServiceLifecycleDependencies> = {},
): IServiceLifecycleDependencies {
  return {
    probeLocalService: async () => ({
      outcome: 'unreachable',
      reason: 'refused',
    }),
    startLocalServer: async (options) => ({
      port: options.port,
      serverUrl: `http://127.0.0.1:${options.port}`,
      closeServer: async () => undefined,
      registerShutdownRequestHandler: () => undefined,
    }),
    inspectPlatformRuntimeState: async () => ({
      state: 'missing',
      runtimeState: null,
    }),
    savePlatformRuntimeState: async () => undefined,
    clearPlatformRuntimeState: async () => undefined,
    isPlatformProcessAlive: () => true,
    resolveBashShellPath: () => '/fake/bash',
    probeBashShell: () => ({ outcome: 'found', path: '/fake/bash' }),
    ensurePlatformConfigStorage: async () => undefined,
    terminateProcess: () => true,
    // 测试默认按 Windows 语义（信号是硬杀）——既有断言的文案据此固化。
    canSignalTriggerGracefulShutdown: () => false,
    generateShutdownToken: () => 'test-shutdown-token',
    requestServiceShutdown: async () => 'unsupported',
    registerShutdownHandlers: () => undefined,
    processExitTimeoutMs: 50,
    processExitIntervalMs: 5,
    gracefulExitTimeoutMs: 50,
    shutdownSelfExitWaitMs: 50,
    exitProcess: () => undefined,
    ...overrides,
  }
}

function probeReturning(result: TLocalServiceProbeResult) {
  return async () => result
}

function confirmedProbe(
  pid: number = RECORDED_PID,
  version: number = LOCAL_SERVICE_PROTOCOL_VERSION,
) {
  return probeReturning({ outcome: 'confirmed', version, pid })
}

describe('startPlatformService', () => {
  it('starts without probing when no record exists', async () => {
    // 冷启动（含每次 e2e）不应为判定付出任何探测开销。
    const probe = vi.fn(
      probeReturning({ outcome: 'unreachable', reason: 'refused' }),
    )
    const savePlatformRuntimeState = vi.fn(async () => undefined)

    const result = await startPlatformService(
      { port: RECORDED_PORT },
      createDependencies({
        probeLocalService: probe,
        savePlatformRuntimeState,
      }),
    )

    expect(probe).not.toHaveBeenCalled()
    expect(result.outcome).toBe('started')
    expect(savePlatformRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({ pid: process.pid, port: RECORDED_PORT }),
    )
  })

  it('reuses a confirmed service and takes the port from the record', async () => {
    const startLocalServer = vi.fn()

    const result = await startPlatformService(
      { port: RECORDED_PORT },
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: confirmedProbe(),
        startLocalServer: startLocalServer as never,
      }),
    )

    expect(result).toEqual({
      outcome: 'reused',
      port: RECORDED_PORT,
      serverUrl: RECORDED_SERVER_URL,
      // 复用分支的进程号、启动时刻与形态均取自运行态记录（面板据此展示）。
      pid: RECORDED_PID,
      startedAt: '2026-09-28T01:22:34.557Z',
      mode: 'foreground',
    })
    expect(startLocalServer).not.toHaveBeenCalled()
  })

  it('rejects a running service whose protocol version differs instead of reusing it', async () => {
    // 复用会让 Web 端在后续请求上撞到协议错误，表现为与「服务未启动」同样费解的故障。
    await expect(
      startPlatformService(
        { port: RECORDED_PORT },
        createDependencies({
          inspectPlatformRuntimeState: async () => PRESENT_RECORD,
          probeLocalService: confirmedProbe(
            RECORDED_PID,
            LOCAL_SERVICE_PROTOCOL_VERSION - 1,
          ),
        }),
      ),
    ).rejects.toThrow(/协议版本/)
  })

  it('persists the port actually bound by the server in non-strict mode', async () => {
    // 非严格模式下端口被占用会自动顺延，记录必须写真实端口而非请求端口。
    const savePlatformRuntimeState = vi.fn(async () => undefined)

    const result = await startPlatformService(
      { port: RECORDED_PORT },
      createDependencies({
        startLocalServer: async () => ({
          port: RECORDED_PORT + 1,
          serverUrl: `http://127.0.0.1:${RECORDED_PORT + 1}`,
          closeServer: async () => undefined,
          registerShutdownRequestHandler: () => undefined,
        }),
        savePlatformRuntimeState,
      }),
    )

    expect(result.port).toBe(RECORDED_PORT + 1)
    expect(savePlatformRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({ port: RECORDED_PORT + 1 }),
    )
  })

  it('starts fresh and reports the stale record when the service is gone', async () => {
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    const result = await startPlatformService(
      { port: RECORDED_PORT },
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: probeReturning({
          outcome: 'unreachable',
          reason: 'refused',
        }),
        clearPlatformRuntimeState,
      }),
    )

    expect(result.outcome).toBe('started-after-stale-record')
    // 不在启动前清理记录：由写入时的原子覆盖完成替换，
    // 避免「记录已删但服务没起来」造成 stop 误报无服务可停。
    expect(clearPlatformRuntimeState).not.toHaveBeenCalled()
  })

  it('starts fresh when another service holds the recorded address', async () => {
    const result = await startPlatformService(
      { port: RECORDED_PORT },
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: probeReturning({
          outcome: 'foreign',
          httpStatus: 404,
        }),
      }),
    )

    expect(result.outcome).toBe('started-after-stale-record')
  })

  it('refuses to start and keeps the record when the port is held but unresponsive', async () => {
    // 无法确认状态时绝不能启动：端口已被占用，强行启动会让新实例顺延端口并覆盖记录，
    // 使仍可能存活的服务失去可管理性。
    const startLocalServer = vi.fn()
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    await expect(
      startPlatformService(
        { port: RECORDED_PORT },
        createDependencies({
          inspectPlatformRuntimeState: async () => PRESENT_RECORD,
          probeLocalService: probeReturning({
            outcome: 'unreachable',
            reason: 'timeout',
          }),
          startLocalServer: startLocalServer as never,
          clearPlatformRuntimeState,
        }),
      ),
    ).rejects.toThrow(/无法确认/)

    expect(startLocalServer).not.toHaveBeenCalled()
    expect(clearPlatformRuntimeState).not.toHaveBeenCalled()
  })

  it('keeps the record when starting the new service fails', async () => {
    // 严格端口模式下端口可能随后被判占用而抛错：
    // 此时必须保留原记录，否则 stop 将误报「没有运行中的服务」。
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    await expect(
      startPlatformService(
        { port: RECORDED_PORT, strictPort: true },
        createDependencies({
          inspectPlatformRuntimeState: async () => PRESENT_RECORD,
          probeLocalService: probeReturning({
            outcome: 'unreachable',
            reason: 'refused',
          }),
          startLocalServer: async () => {
            throw new Error('CLI 端口已被占用。')
          },
          clearPlatformRuntimeState,
        }),
      ),
    ).rejects.toThrow('CLI 端口已被占用。')

    expect(clearPlatformRuntimeState).not.toHaveBeenCalled()
  })

  it('closes the server when persisting the record fails', async () => {
    const closeServer = vi.fn(async () => undefined)

    await expect(
      startPlatformService(
        { port: RECORDED_PORT },
        createDependencies({
          startLocalServer: async () => ({
            port: RECORDED_PORT,
            serverUrl: RECORDED_SERVER_URL,
            closeServer,
            registerShutdownRequestHandler: () => undefined,
          }),
          savePlatformRuntimeState: async () => {
            throw new Error('磁盘不可写')
          },
        }),
      ),
    ).rejects.toThrow('磁盘不可写')

    expect(closeServer).toHaveBeenCalled()
  })

  it('rejects a confirmed service whose pid differs from the record', async () => {
    // PID 被回收后，响应者可能是另一个实例；结束记录中的 PID 会误杀无关进程。
    const startLocalServer = vi.fn()

    await expect(
      startPlatformService(
        { port: RECORDED_PORT },
        createDependencies({
          inspectPlatformRuntimeState: async () => PRESENT_RECORD,
          probeLocalService: confirmedProbe(9999),
          startLocalServer: startLocalServer as never,
        }),
      ),
    ).rejects.toThrow(/不一致/)

    expect(startLocalServer).not.toHaveBeenCalled()
  })

  it('records the foreground mode and hands the shutdown token to the server', async () => {
    // v19 §4.1 / §4.3：记录写入运行形态与一次性凭据，凭据同时传给服务层
    // 用于注册关闭端点——两处必须同值，否则 stop 会拿到 403。
    const savePlatformRuntimeState = vi.fn(async () => undefined)
    const startLocalServer = vi.fn(async (options: { shutdownToken?: string }) => ({
      port: RECORDED_PORT,
      serverUrl: RECORDED_SERVER_URL,
      closeServer: async () => undefined,
      registerShutdownRequestHandler: () => undefined,
    }))
    const generateShutdownToken = () => 'token-from-lifecycle'

    await startPlatformService(
      { port: RECORDED_PORT, mode: 'foreground' },
      createDependencies({
        savePlatformRuntimeState,
        startLocalServer: startLocalServer as never,
        generateShutdownToken,
      }),
    )

    expect(savePlatformRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'foreground',
        shutdownToken: 'token-from-lifecycle',
      }),
    )
    expect(startLocalServer).toHaveBeenCalledWith(
      expect.objectContaining({ shutdownToken: 'token-from-lifecycle' }),
    )
  })

  it('runs the same shutdown routine when the endpoint requests a shutdown', async () => {
    // C3：端点只通知，关闭序列与进程退出由 CLI 执行——两者必须是同一条例程，
    // 否则「优雅停止」与 Ctrl+C 的行为会漂移（§1.3）。
    const exitProcess = vi.fn<(exitCode: number) => void>()
    const closeServer = vi.fn(async () => undefined)
    const clearRuntimeState = vi.fn(async () => undefined)
    // 用持有对象而非裸变量：赋值发生在回调里，TS 会把裸变量窄化为初始值。
    const registered: { handler: (() => void) | null } = { handler: null }

    await startPlatformService(
      { port: RECORDED_PORT },
      createDependencies({
        startLocalServer: async () => ({
          port: RECORDED_PORT,
          serverUrl: RECORDED_SERVER_URL,
          closeServer,
          registerShutdownRequestHandler: (handler) => {
            registered.handler = handler
          },
        }),
        clearPlatformRuntimeState: clearRuntimeState,
        exitProcess,
        registerShutdownHandlers: () => undefined,
      }),
    )

    expect(registered.handler).not.toBeNull()

    registered.handler?.()
    // 关闭例程是异步的；等它跑完关闭与退出两步。
    await vi.waitFor(() => expect(exitProcess).toHaveBeenCalledWith(0))

    expect(closeServer).toHaveBeenCalled()
    expect(clearRuntimeState).toHaveBeenCalled()
  })

  it('defaults the mode to foreground when the environment offers no marker', async () => {
    // 环境变量缺省即前台：误判到这一侧不会让服务意外脱离终端（§3.2）。
    const savePlatformRuntimeState = vi.fn(async () => undefined)

    await startPlatformService(
      { port: RECORDED_PORT },
      createDependencies({ savePlatformRuntimeState }),
    )

    expect(savePlatformRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'foreground' }),
    )
  })
})

describe('stopPlatformService', () => {
  it('reports already stopped when there is no record', async () => {
    const terminateProcess = vi.fn(() => true)

    const result = await stopPlatformService(
      createDependencies({ terminateProcess }),
    )

    expect(result.alreadyStopped).toBe(true)
    expect(terminateProcess).not.toHaveBeenCalled()
  })

  it('clears a corrupted record without ending any process', async () => {
    const terminateProcess = vi.fn(() => true)
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => ({
          state: 'invalid',
          runtimeState: null,
        }),
        terminateProcess,
        clearPlatformRuntimeState,
      }),
    )

    expect(result.alreadyStopped).toBe(true)
    expect(terminateProcess).not.toHaveBeenCalled()
    expect(clearPlatformRuntimeState).toHaveBeenCalled()
  })

  it('ends the recorded process only after confirming its identity', async () => {
    const terminateProcess = vi.fn(() => true)
    const clearPlatformRuntimeState = vi.fn(async () => undefined)
    let isAlive = true

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        clearPlatformRuntimeState,
        isPlatformProcessAlive: () => {
          const wasAlive = isAlive
          isAlive = false
          return wasAlive
        },
      }),
    )

    expect(terminateProcess).toHaveBeenCalledWith(RECORDED_PID)
    expect(result.stopped).toBe(true)
    expect(clearPlatformRuntimeState).toHaveBeenCalled()
  })

  it('never ends a process and keeps the record when the state cannot be confirmed', async () => {
    // 本次修复的核心安全性质：探测无法确认身份时，绝不结束进程、绝不清理记录。
    const terminateProcess = vi.fn(() => true)
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    await expect(
      stopPlatformService(
        createDependencies({
          inspectPlatformRuntimeState: async () => PRESENT_RECORD,
          probeLocalService: probeReturning({
            outcome: 'unreachable',
            reason: 'timeout',
          }),
          terminateProcess,
          clearPlatformRuntimeState,
        }),
      ),
    ).rejects.toThrow(/未执行任何操作/)

    expect(terminateProcess).not.toHaveBeenCalled()
    expect(clearPlatformRuntimeState).not.toHaveBeenCalled()
  })

  it('never ends a process when the responder pid differs from the record', async () => {
    const terminateProcess = vi.fn(() => true)

    await expect(
      stopPlatformService(
        createDependencies({
          inspectPlatformRuntimeState: async () => PRESENT_RECORD,
          probeLocalService: confirmedProbe(9999),
          terminateProcess,
        }),
      ),
    ).rejects.toThrow(/不一致/)

    expect(terminateProcess).not.toHaveBeenCalled()
  })

  it('clears a stale record without ending any process when the service is gone', async () => {
    const terminateProcess = vi.fn(() => true)
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: probeReturning({
          outcome: 'unreachable',
          reason: 'refused',
        }),
        terminateProcess,
        clearPlatformRuntimeState,
      }),
    )

    expect(terminateProcess).not.toHaveBeenCalled()
    expect(clearPlatformRuntimeState).toHaveBeenCalled()
    expect(result.message).toMatch(/未结束任何进程/)
  })

  it('clears the record without ending any process when another service answers', async () => {
    const terminateProcess = vi.fn(() => true)
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: probeReturning({
          outcome: 'foreign',
          httpStatus: 502,
        }),
        terminateProcess,
        clearPlatformRuntimeState,
      }),
    )

    expect(terminateProcess).not.toHaveBeenCalled()
    expect(clearPlatformRuntimeState).toHaveBeenCalled()
  })

  it('treats a vanished process as already stopped and clears the record', async () => {
    // 探测通过后进程恰好退出：结束信号会失败，但服务确实已停止。
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: confirmedProbe(),
        terminateProcess: () => false,
        clearPlatformRuntimeState,
      }),
    )

    expect(result.alreadyStopped).toBe(true)
    expect(clearPlatformRuntimeState).toHaveBeenCalled()
  })

  it('keeps the record when the process does not exit in time', async () => {
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: confirmedProbe(),
        terminateProcess: () => true,
        clearPlatformRuntimeState,
        // 进程始终存活，触发等待超时。
        isPlatformProcessAlive: () => true,
      }),
    )

    expect(result.stopped).toBe(false)
    expect(result.alreadyStopped).toBe(false)
    // 保留记录，避免丢失仍可能存活服务的可管理性。
    expect(clearPlatformRuntimeState).not.toHaveBeenCalled()
  })

  it('request endpoint, then wait for the process to exit', async () => {
    // v19 §4.4 决策表第一行：记录含凭据且端点 2xx → 等待退出（不再发信号）。
    const terminateProcess = vi.fn(() => true)
    const clearPlatformRuntimeState = vi.fn(async () => undefined)
    let isAlive = true

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        clearPlatformRuntimeState,
        requestServiceShutdown: async () => 'accepted',
        isPlatformProcessAlive: () => {
          const wasAlive = isAlive
          isAlive = false
          return wasAlive
        },
      }),
    )

    // 优雅路径不该发信号：Windows 上那是硬杀（F3）。
    expect(terminateProcess).not.toHaveBeenCalled()
    expect(result.stopped).toBe(true)
    expect(result.message).toMatch(/优雅停止/)
    expect(clearPlatformRuntimeState).toHaveBeenCalled()
  })

  it('gives the graceful path a longer exit budget than the signal path', async () => {
    // §4.4 决策表要求 10 秒：服务收到端点请求后要自行走完「中止在跑任务
    // （本身最多 5 秒）→ 关浏览器 → 释放运行时」。沿用信号路径的 5 秒会让
    // 「有任务在跑时优雅停止」必然被报成超时——这正是本版要修的场景。
    // 用「退出发生在什么时候」表达预算差异，而不是数轮询次数：
    // 进程在第 100ms 才退出——超过信号预算（50ms），但落在优雅预算（300ms）内。
    const hasExitedAt = Date.now() + 100

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        requestServiceShutdown: async () => 'accepted',
        isPlatformProcessAlive: () => Date.now() < hasExitedAt,
        processExitTimeoutMs: 50,
        processExitIntervalMs: 5,
        gracefulExitTimeoutMs: 300,
      }),
    )

    expect(result.stopped).toBe(true)
    expect(result.message).toMatch(/优雅停止/)
  })

  it('keeps the existing short budget when falling back to signal', async () => {
    // 回退路径仍用信号预算：那里进程是被告知结束，不需要等关闭序列。
    const alivenessChecks: number[] = []

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        terminateProcess: () => true,
        requestServiceShutdown: async () => 'unsupported',
        isPlatformProcessAlive: () => {
          alivenessChecks.push(1)
          return true
        },
        processExitTimeoutMs: 20,
        processExitIntervalMs: 5,
        gracefulExitTimeoutMs: 5000,
      }),
    )

    expect(result.stopped).toBe(false)
    // 用的是信号预算（20ms / 5ms ≈ 4 次），远小于 graceful 的 5000ms。
    expect(alivenessChecks.length).toBeLessThan(10)
  })

  it('executes the fallback signal path when the endpoint is unsupported', async () => {
    // 决策表：404（旧版本服务）→ 回退信号，并明确告知（S4）。
    const terminateProcess = vi.fn(() => true)
    let isAlive = true

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        requestServiceShutdown: async () => 'unsupported',
        isPlatformProcessAlive: () => {
          const wasAlive = isAlive
          isAlive = false
          return wasAlive
        },
      }),
    )

    expect(terminateProcess).toHaveBeenCalledWith(RECORDED_PID)
    expect(result.stopped).toBe(true)
    expect(result.message).toMatch(/不支持优雅关闭/)
    expect(result.message).toMatch(/强制结束方式/)
  })

  it('describes the fallback accurately on POSIX (signal is catchable there)', async () => {
    // macOS / Linux 上 SIGTERM 可被捕获，服务会执行自身的收尾流程——
    // 说成「不会执行服务侧清理」会让用户误判资源状态（v19 §4.4 S4）。
    const terminateProcess = vi.fn(() => true)
    let isAlive = true

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        requestServiceShutdown: async () => 'unsupported',
        canSignalTriggerGracefulShutdown: () => true,
        isPlatformProcessAlive: () => {
          const wasAlive = isAlive
          isAlive = false
          return wasAlive
        },
      }),
    )

    expect(result.message).not.toMatch(/Windows/)
    expect(result.message).not.toMatch(/强制结束方式/)
    expect(result.message).toMatch(/服务会执行自身的收尾流程/)
  })

  it('falls back to signal when the endpoint rejects the credential', async () => {
    // 决策表：403（记录可能已被替换）→ 回退信号。
    const terminateProcess = vi.fn(() => true)
    let isAlive = true

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        requestServiceShutdown: async () => 'rejected',
        isPlatformProcessAlive: () => {
          const wasAlive = isAlive
          isAlive = false
          return wasAlive
        },
      }),
    )

    expect(terminateProcess).toHaveBeenCalledWith(RECORDED_PID)
    expect(result.message).toMatch(/凭据不匹配/)
  })

  it('treats a service that exits on its own after an unreachable endpoint as stopped', async () => {
    // 决策表：网络错误 → 先等 3 秒看是否自行退出；退出了就按成功处理，不发信号。
    const terminateProcess = vi.fn(() => true)
    const clearPlatformRuntimeState = vi.fn(async () => undefined)
    let isAlive = true

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        clearPlatformRuntimeState,
        requestServiceShutdown: async () => 'unreachable',
        isPlatformProcessAlive: () => {
          const wasAlive = isAlive
          isAlive = false
          return wasAlive
        },
      }),
    )

    expect(terminateProcess).not.toHaveBeenCalled()
    expect(result.stopped).toBe(true)
    expect(result.message).toMatch(/自行退出/)
    expect(clearPlatformRuntimeState).toHaveBeenCalled()
  })

  it('falls back to signal when the endpoint is unreachable and the process stays alive', async () => {
    // 决策表：网络错误且进程未退出 → 回退信号（并说明回退原因）。
    // 观察窗口内始终存活；结束信号发出后（terminateProcess 被调用）才判退出。
    let signalSent = false
    const terminateProcess = vi.fn(() => {
      signalSent = true
      return true
    })

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        requestServiceShutdown: async () => 'unreachable',
        isPlatformProcessAlive: () => !signalSent,
      }),
    )

    expect(terminateProcess).toHaveBeenCalledWith(RECORDED_PID)
    expect(result.stopped).toBe(true)
    expect(result.message).toMatch(/关闭端点无响应/)
  })

  it('uses the POSIX wording when an unreachable endpoint falls back to signal', async () => {
    let signalSent = false
    const terminateProcess = vi.fn(() => {
      signalSent = true
      return true
    })

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        requestServiceShutdown: async () => 'unreachable',
        canSignalTriggerGracefulShutdown: () => true,
        isPlatformProcessAlive: () => !signalSent,
      }),
    )

    expect(result.message).toMatch(/关闭端点无响应/)
    expect(result.message).not.toMatch(/Windows/)
    expect(result.message).toMatch(/服务会执行自身的收尾流程/)
  })

  it('keeps the existing signal path when the record has no shutdown token', async () => {
    // 决策表最后一行：记录无凭据（旧版本服务）→ 直接走既有信号路径，文案不变。
    // PRESENT_RECORD 恰好就是「无凭据」的形态。
    const requestServiceShutdown = vi.fn(async () => 'accepted' as const)
    const terminateProcess = vi.fn(() => true)
    let isAlive = true

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => PRESENT_RECORD,
        probeLocalService: confirmedProbe(),
        terminateProcess,
        requestServiceShutdown,
        isPlatformProcessAlive: () => {
          const wasAlive = isAlive
          isAlive = false
          return wasAlive
        },
      }),
    )

    expect(requestServiceShutdown).not.toHaveBeenCalled()
    expect(terminateProcess).toHaveBeenCalledWith(RECORDED_PID)
    expect(result.message).toBe('Authine E2E Agent Platform 服务已停止。')
  })

  it('keeps the record when the graceful stop times out', async () => {
    // 端点接受了请求但进程迟迟不退：保留记录，避免丢失可管理性。
    const clearPlatformRuntimeState = vi.fn(async () => undefined)

    const result = await stopPlatformService(
      createDependencies({
        inspectPlatformRuntimeState: async () => RECORD_WITH_TOKEN,
        probeLocalService: confirmedProbe(),
        clearPlatformRuntimeState,
        // 进程始终存活：等待退出的轮询超时。
        isPlatformProcessAlive: () => true,
      }),
    )

    expect(result.stopped).toBe(false)
    expect(result.message).toMatch(/超时/)
    expect(clearPlatformRuntimeState).not.toHaveBeenCalled()
  })

  it('refuses to stop the CLI process itself', async () => {
    const terminateProcess = vi.fn(() => true)

    await expect(
      stopPlatformService(
        createDependencies({
          inspectPlatformRuntimeState: async () => ({
            state: 'present',
            runtimeState: {
              pid: process.pid,
              port: RECORDED_PORT,
              serverUrl: RECORDED_SERVER_URL,
              startedAt: '2026-09-28T01:22:34.557Z',
              mode: 'foreground' as const,
            },
          }),
          probeLocalService: confirmedProbe(process.pid),
          terminateProcess,
        }),
      ),
    ).rejects.toThrow(/拒绝执行停止操作/)

    expect(terminateProcess).not.toHaveBeenCalled()
  })
})
