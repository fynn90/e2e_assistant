/**
 * 验证服务启动入口的绑定地址约束。
 *
 * 绑定地址固定在服务层（PRD v18 §4.2 S6）：服务能读写用户工作区文件，
 * 绑回环是它的安全性质——集中在此处意味着任何客户端都无法把它误暴露到网络；
 * 若交给调用方，安全就退化为调用方的纪律。本测试锁住这条性质。
 */
import { afterEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import { startLocalServer, type IStartedLocalServer } from '../../src/index'
import { LOCAL_SERVICE_PROTOCOL_VERSION } from '@authine-e2e-agent/types'

let startedServer: IStartedLocalServer | null = null

afterEach(async () => {
  if (startedServer) {
    await startedServer.closeServer()
    startedServer = null
  }
})

describe('startLocalServer', () => {
  it('在回环地址上监听并回报实际端口与可用的 /health', async () => {
    // 端口 0 由操作系统分配空闲端口，避免与其他测试/进程抢占。
    startedServer = await startLocalServer({ port: 6121 })

    expect(startedServer.port).toBe(6121)
    expect(startedServer.serverUrl).toBe('http://127.0.0.1:6121')

    const healthResponse = await fetch(`${startedServer.serverUrl}/health`)
    const healthBody = (await healthResponse.json()) as {
      service: string
      status: string
      version: number
      pid: number
    }

    // /health 是跨包线协议，字段与取值必须逐字不变（PRD §4.7 V1/V3）。
    expect(healthBody.service).toBe('authine-e2e-agent-cli')
    expect(healthBody.status).toBe('ok')
    expect(healthBody.version).toBe(LOCAL_SERVICE_PROTOCOL_VERSION)
    expect(healthBody.pid).toBe(process.pid)
  })

  it('首选端口被占用且非严格模式时顺延到其他端口', async () => {
    const firstServer = await startLocalServer({ port: 6122 })
    startedServer = firstServer

    const secondServer = await startLocalServer({ port: 6122 })

    try {
      expect(secondServer.port).toBeGreaterThan(6122)
      // 两个服务各自可用：顺延不应影响先启动的那个。
      expect((await fetch(`${firstServer.serverUrl}/health`)).status).toBe(200)
      expect((await fetch(`${secondServer.serverUrl}/health`)).status).toBe(200)
    } finally {
      await secondServer.closeServer()
    }
  })

  it('严格模式下首选端口被占用时抛出异常而不是顺延', async () => {
    startedServer = await startLocalServer({ port: 6123 })

    await expect(
      startLocalServer({ port: 6123, strictPort: true }),
    ).rejects.toThrow('已被占用')
  })

  it('closeServer 释放端口，可再次在同端口启动', async () => {
    const firstServer = await startLocalServer({ port: 6124 })

    await firstServer.closeServer()

    // 端口已释放：同一端口应能再次监听。
    startedServer = await startLocalServer({ port: 6124 })

    expect(startedServer.port).toBe(6124)
  })

  it('存在永不结束的连接时 closeServer 仍在数秒内返回', async () => {
    // v19 修 F4：`close()` 会等待既有连接结束，而 SSE 是永不结束的响应，
    // 只调 close() 会让 Ctrl+C 挂住。closeServer 必须主动销毁连接。
    startedServer = await startLocalServer({ port: 6125 })

    // 裸 socket 发一个「不完整的请求」：连接建立但请求永不结束，
    // 与 SSE 的性质一致（连接在，响应不结束）。
    const socket = net.connect(6125, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1:6125\r\n') // 故意不写结束空行

    // 关键断言：closeServer 不被这条悬挂连接拖住。
    await expect(startedServer.closeServer()).resolves.toBeUndefined()
    startedServer = null

    socket.destroy()
  })

  it('closeServer 可重复调用（幂等）', async () => {
    // 关闭端点与信号可能同时到达，重复关闭不得抛错。
    startedServer = await startLocalServer({ port: 6126 })

    await startedServer.closeServer()
    await expect(startedServer.closeServer()).resolves.toBeUndefined()
    startedServer = null
  })

  it('关闭端点收到合法请求时通知宿主（不自行退出进程）', async () => {
    // C3：端点只做「校验 → 应答 → 通知宿主」。服务层不含 process.exit，
    // 是否结束进程由宿主决定——本用例断言通知确实到达宿主。
    let shutdownRequestCount = 0
    startedServer = await startLocalServer({
      port: 6127,
      shutdownToken: 'integration-shutdown-token',
    })
    startedServer.registerShutdownRequestHandler(() => {
      shutdownRequestCount += 1
    })

    const response = await fetch('http://127.0.0.1:6127/api/shutdown', {
      method: 'POST',
      headers: { 'x-authine-shutdown-token': 'integration-shutdown-token' },
    })

    expect(response.status).toBe(202)

    // 端点延迟一拍再通知（让 202 先写回客户端）。
    await expect.poll(() => shutdownRequestCount, { timeout: 3000 }).toBe(1)
  })

  it('未提供 shutdownToken 时不注册关闭端点', async () => {
    startedServer = await startLocalServer({ port: 6128 })

    const response = await fetch('http://127.0.0.1:6128/api/shutdown', {
      method: 'POST',
    })

    expect(response.status).toBe(404)
  })
})
