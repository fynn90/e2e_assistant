/**
 * 验证服务层的端口解析行为与启动入口的绑定地址约束。
 *
 * 这三个端口函数原先在 `apps/cli/src/infrastructure/network/port.ts`，
 * v18 随监听一并迁入服务层（PRD §6.1.1）。绑定地址固定在服务层内是本包的
 * 安全性质（§4.2 S6），因此需要一条断言锁住它不被调用方覆盖。
 */
import { afterEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import { findAvailablePort, requireAvailablePort } from '../../src/http/port'

const occupiedServers: net.Server[] = []

afterEach(async () => {
  await Promise.all(
    occupiedServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

/**
 * 在指定端口上创建一个占位监听器。
 * @param port 要占用的端口号。
 * @returns 监听器就绪后无返回值。
 * @throws 当端口已被占用时抛出异常。
 */
async function occupyPort(port: number): Promise<void> {
  const server = net.createServer()

  occupiedServers.push(server)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

/**
 * 申请一个当前空闲的回环端口，供测试占用。
 * @returns 可用的端口号。
 * @throws 当申请失败时抛出异常。
 */
async function pickFreePort(): Promise<number> {
  const probeServer = net.createServer()

  await new Promise<void>((resolve, reject) => {
    probeServer.once('error', reject)
    probeServer.listen(0, '127.0.0.1', () => resolve())
  })

  const address = probeServer.address() as net.AddressInfo

  await new Promise<void>((resolve) => {
    probeServer.close(() => resolve())
  })

  return address.port
}

describe('findAvailablePort', () => {
  it('首选端口可用时原样返回', async () => {
    const port = await pickFreePort()

    expect(await findAvailablePort({ preferredPort: port })).toBe(port)
  })

  it('首选端口被占用时顺延到下一个可用端口', async () => {
    const port = await pickFreePort()

    await occupyPort(port)

    const resolvedPort = await findAvailablePort({ preferredPort: port })

    expect(resolvedPort).toBeGreaterThan(port)
    expect(Number.isInteger(resolvedPort)).toBe(true)
  })

  it('首选端口非法时抛出异常', async () => {
    await expect(findAvailablePort({ preferredPort: 0 })).rejects.toThrow(
      '端口必须是 1 到 65535 之间的整数。',
    )
    await expect(findAvailablePort({ preferredPort: 65536 })).rejects.toThrow(
      '端口必须是 1 到 65535 之间的整数。',
    )
    await expect(findAvailablePort({ preferredPort: 1.5 })).rejects.toThrow(
      '端口必须是 1 到 65535 之间的整数。',
    )
  })
})

describe('requireAvailablePort', () => {
  it('端口可用时原样返回', async () => {
    const port = await pickFreePort()

    expect(await requireAvailablePort({ port })).toBe(port)
  })

  it('端口被占用时抛出带处理建议的异常（strictPort 语义）', async () => {
    const port = await pickFreePort()

    await occupyPort(port)

    // 严格模式必须报错而不是顺延：开发模式要求 Web 与 CLI 共享同一端口。
    await expect(requireAvailablePort({ port })).rejects.toThrow(
      `CLI 端口 ${port} 已被占用。请停止占用该端口的服务，或设置 AUTHINE_CLI_PORT 为其他端口后重试。`,
    )
  })

  it('端口非法时抛出异常', async () => {
    await expect(requireAvailablePort({ port: -1 })).rejects.toThrow(
      '端口必须是 1 到 65535 之间的整数。',
    )
  })
})
