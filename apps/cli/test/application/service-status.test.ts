/**
 * 只读状态查询的测试。
 *
 * 最重要的是**只读性质**：`status` 可能是用户排查问题时敲的第一条命令，
 * 它不该在用户决定怎么做之前就动磁盘上的记录。本测试以两条断言锁定它：
 *   1. 静态断言 service-status.ts 的源码里不出现任何写入函数；
 *   2. 行为断言三态判定正确且不抛出。
 *
 * 静态断言看似笨拙，但它正是「不清理记录」这条安全性质的机器化检查——
 * 一旦有人在只读路径里加了 clear/save，这里会立刻失败。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readServiceStatus } from '../../src/application/service-status'
import type { TServiceProbe } from '../../src/application/service-identity'
import type { TPlatformRuntimeInspection } from '../../src/infrastructure/config/runtime-store'

const RECORDED_PID = 4242
const RECORDED_PORT = 5826
const RECORDED_SERVER_URL = `http://127.0.0.1:${RECORDED_PORT}`

/** v19 的后台记录形态。 */
const PRESENT_RECORD: TPlatformRuntimeInspection = {
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

/**
 * 构造探测替身，返回指定的探测结果。
 *
 * @param result - 探测应返回的结果。
 * @returns 探测函数。
 */
function probeReturning(
  result: Awaited<ReturnType<TServiceProbe>>,
): TServiceProbe {
  return async () => result
}

/**
 * 构造状态读取的依赖替身。
 *
 * @param inspection - 记录读取结果。
 * @returns 依赖覆盖项。
 */
function createOverrides(inspection: TPlatformRuntimeInspection): {
  inspectRuntimeState: () => Promise<TPlatformRuntimeInspection>
} {
  return { inspectRuntimeState: async () => inspection }
}

describe('readServiceStatus', () => {
  it('探测确认且 PID 一致时判定为 active，并带出服务自报的版本', async () => {
    const status = await readServiceStatus({
      ...createOverrides(PRESENT_RECORD),
      probe: probeReturning({
        outcome: 'confirmed',
        version: 6,
        pid: RECORDED_PID,
      }),
    })

    expect(status.state).toBe('active')
    expect(status.state === 'active' && status.version).toBe(6)
  })

  it('无记录时判定为 absent，且成因为「从未启动」', async () => {
    const status = await readServiceStatus({
      ...createOverrides({ state: 'missing', runtimeState: null }),
    })

    expect(status).toEqual({ state: 'absent', reason: 'no-record' })
  })

  it('记录损坏时判定为 absent，且成因区别于「从未启动」', async () => {
    // 与 log 命令的刻意差异：status 的职责是把状态说清楚，
    // 两种成因需要不同的提示文案。
    const status = await readServiceStatus({
      ...createOverrides({ state: 'invalid', runtimeState: null }),
    })

    expect(status).toEqual({ state: 'absent', reason: 'record-invalid' })
  })

  it('连接被拒绝时判定为 absent，成因为服务已消失', async () => {
    const status = await readServiceStatus({
      ...createOverrides(PRESENT_RECORD),
      probe: probeReturning({ outcome: 'unreachable', reason: 'refused' }),
    })

    expect(status).toEqual({ state: 'absent', reason: 'service-gone' })
  })

  it('别的服务占用端口时判定为 absent', async () => {
    const status = await readServiceStatus({
      ...createOverrides(PRESENT_RECORD),
      probe: probeReturning({ outcome: 'foreign', httpStatus: 502 }),
    })

    expect(status.state).toBe('absent')
  })

  it('探测超时时判定为 unknown，并带出原因', async () => {
    const status = await readServiceStatus({
      ...createOverrides(PRESENT_RECORD),
      probe: probeReturning({ outcome: 'unreachable', reason: 'timeout' }),
    })

    expect(status.state).toBe('unknown')
    expect(status.state === 'unknown' && status.detail).toContain('探测')
  })

  it('PID 与记录不一致时判定为 unknown（不可据此结束进程）', async () => {
    const status = await readServiceStatus({
      ...createOverrides(PRESENT_RECORD),
      probe: probeReturning({
        outcome: 'confirmed',
        version: 6,
        pid: RECORDED_PID + 1,
      }),
    })

    expect(status.state).toBe('unknown')
    expect(status.state === 'unknown' && status.detail).toContain('不一致')
  })

  it('探测抛错时收敛为 unknown，而不是让异常冒泡', async () => {
    // 必须收敛：命令抛异常时包装器会把退出码置 1，与「服务未运行」撞车，
    // 脚本会误读成「没在跑」并据此去启动它。unknown 的退出码是 2，语义诚实。
    const status = await readServiceStatus({
      ...createOverrides(PRESENT_RECORD),
      probe: async () => {
        throw new Error('boom')
      },
    })

    expect(status.state).toBe('unknown')
    expect(status.state === 'unknown' && status.detail).toContain('boom')
  })
})

/**
 * 读入源码并剥掉注释，只留可执行代码。
 *
 * 必须剥注释：这些文件的 JSDoc 会**正文明说**「本模块绝不调用
 * clearPlatformRuntimeState」——若连注释一起匹配，那条说明自己就会让断言失败。
 *
 * @param sourcePath - 相对包根的文件路径。
 * @returns 去掉注释后的源码。
 */
function readCodeWithoutComments(sourcePath: string): string {
  return readFileSync(path.join(process.cwd(), sourcePath), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

describe('只读性质', () => {
  it('源码不引用任何写盘函数或结束进程的调用', () => {
    // 这条断言是「status 不改变状态」的机器化检查。若有人在只读路径里
    // 加了 clear / save / 日志轮转 / 结束进程，这里会立刻失败。
    const source = readCodeWithoutComments('src/application/service-status.ts')

    expect(source).not.toContain('clearPlatformRuntimeState')
    expect(source).not.toContain('savePlatformRuntimeState')
    expect(source).not.toContain('rotateServiceLogIfNeeded')
    expect(source).not.toContain('terminateProcess')
  })

  it('命令层也不引用任何写盘函数或结束进程的调用', () => {
    const source = readCodeWithoutComments('src/commands/status-command.ts')

    expect(source).not.toContain('clearPlatformRuntimeState')
    expect(source).not.toContain('savePlatformRuntimeState')
    expect(source).not.toContain('rotateServiceLogIfNeeded')
    expect(source).not.toContain('terminateProcess')
  })

  it('查询过程只读记录一次，不产生任何写入', async () => {
    const inspectRuntimeState = vi.fn(async () => PRESENT_RECORD)

    await readServiceStatus({
      inspectRuntimeState,
      probe: probeReturning({ outcome: 'unreachable', reason: 'refused' }),
    })

    expect(inspectRuntimeState).toHaveBeenCalledTimes(1)
  })
})
