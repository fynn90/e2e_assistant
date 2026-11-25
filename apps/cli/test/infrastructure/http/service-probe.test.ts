import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import process from 'node:process'
import {
  LOCAL_SERVICE_IDENTITY,
  LOCAL_SERVICE_PROTOCOL_VERSION,
} from '@charlie_deng/e2e-assistant-types'
import { probeLocalService } from '../../../src/infrastructure/http/service-probe'

// 探测是 socket 客户端，必须打真实监听；用 app.request() 无法覆盖网络层行为。
const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

describe('local service probe', () => {
  it('confirms a service that reports the platform identity', async () => {
    const { port } = await startJsonServer({
      status: 200,
      body: {
        service: LOCAL_SERVICE_IDENTITY,
        status: 'ok',
        version: LOCAL_SERVICE_PROTOCOL_VERSION,
        pid: process.pid,
      },
    })

    await expect(
      probeLocalService({ serverUrl: `http://127.0.0.1:${port}` }),
    ).resolves.toEqual({
      outcome: 'confirmed',
      version: LOCAL_SERVICE_PROTOCOL_VERSION,
      pid: process.pid,
    })
  })

  it('still confirms a real CLI whose protocol version differs', async () => {
    // 版本不匹配是「真实的 CLI 但版本不同」，不是「别的服务」；
    // 若把它归为 foreign，调用方会把记录当陈旧清理掉，从而掩盖版本冲突。
    const { port } = await startJsonServer({
      status: 200,
      body: {
        service: LOCAL_SERVICE_IDENTITY,
        status: 'ok',
        version: 3,
        pid: 4242,
      },
    })

    await expect(
      probeLocalService({ serverUrl: `http://127.0.0.1:${port}` }),
    ).resolves.toEqual({
      outcome: 'confirmed',
      version: 3,
      pid: 4242,
    })
  })

  it('reports a missing pid as null while still confirming identity', async () => {
    const { port } = await startJsonServer({
      status: 200,
      body: {
        service: LOCAL_SERVICE_IDENTITY,
        status: 'ok',
        version: LOCAL_SERVICE_PROTOCOL_VERSION,
      },
    })

    await expect(
      probeLocalService({ serverUrl: `http://127.0.0.1:${port}` }),
    ).resolves.toEqual({
      outcome: 'confirmed',
      version: LOCAL_SERVICE_PROTOCOL_VERSION,
      pid: null,
    })
  })

  it('treats another service answering with its own identity as foreign', async () => {
    const { port } = await startJsonServer({
      status: 200,
      body: { service: 'some-other-tool', status: 'ok', version: 1 },
    })

    await expect(
      probeLocalService({ serverUrl: `http://127.0.0.1:${port}` }),
    ).resolves.toEqual({
      outcome: 'foreign',
      httpStatus: 200,
    })
  })

  it('treats an HTML error response as foreign rather than unreachable', async () => {
    // 关键区分：拿到了 HTTP 应答就说明该地址上有服务在监听，
    // 因此绝不能被归为 unreachable——那会让调用方误以为可以安全清理记录。
    const { port } = await startRawServer({
      statusCode: 404,
      contentType: 'text/html',
      body: '<!doctype html><title>Not Found</title>',
    })

    await expect(
      probeLocalService({ serverUrl: `http://127.0.0.1:${port}` }),
    ).resolves.toEqual({
      outcome: 'foreign',
      httpStatus: 404,
    })
  })

  it('treats a 200 response with a non-JSON body as foreign', async () => {
    const { port } = await startRawServer({
      statusCode: 200,
      contentType: 'text/plain',
      body: 'hello',
    })

    await expect(
      probeLocalService({ serverUrl: `http://127.0.0.1:${port}` }),
    ).resolves.toEqual({
      outcome: 'foreign',
      httpStatus: 200,
    })
  })

  it('reports a refused connection when nothing is listening', async () => {
    const freePort = await findFreePort()

    await expect(
      probeLocalService({ serverUrl: `http://127.0.0.1:${freePort}` }),
    ).resolves.toEqual({
      outcome: 'unreachable',
      reason: 'refused',
    })
  })

  it('reports a timeout when the port is held but never answers', async () => {
    // 端口被占用却不回应：既不能判定服务已消失，也不能判定它是本服务。
    // 这一情形必须与 refused 区分开，调用方会据此采取保守策略。
    const acceptedSockets = new Set<net.Socket>()
    const hungServer = net.createServer((socket) => {
      // 故意接受连接但不发送任何响应；记录 socket 以便测试结束时强制关闭，
      // 否则被探测放弃的连接会让 server.close() 一直等待。
      acceptedSockets.add(socket)
      socket.on('close', () => acceptedSockets.delete(socket))
    })
    const hungPort = await listenOnLoopback(hungServer)

    await expect(
      probeLocalService({
        serverUrl: `http://127.0.0.1:${hungPort}`,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ outcome: 'unreachable', reason: 'timeout' })

    for (const acceptedSocket of acceptedSockets) {
      acceptedSocket.destroy()
    }

    await closeServer(hungServer)
    servers.splice(servers.indexOf(hungServer as http.Server), 1)
  })

  it('refuses to request a malformed or non-loopback URL without fetching', async () => {
    // 记录中的地址来自磁盘文件，只允许「http + 回环主机 + 显式端口」这一种形状，
    // 避免把文件内容当作任意 URL 发出去。
    const requestUrls: string[] = []
    const fetchImplementation = (async (input: string | URL | Request) => {
      requestUrls.push(String(input))
      throw new Error('不应发起请求')
    }) as unknown as typeof fetch

    const malformedUrls = [
      '',
      'not-a-url',
      'https://127.0.0.1:5826',
      'http://example.com:5826',
      'http://127.0.0.1',
      'http://169.254.169.254:80',
    ]

    for (const malformedUrl of malformedUrls) {
      await expect(
        probeLocalService({ serverUrl: malformedUrl, fetchImplementation }),
      ).resolves.toEqual({ outcome: 'unreachable', reason: 'invalid-url' })
    }

    expect(requestUrls).toEqual([])
  })

  it('normalizes an accepted loopback URL to its origin before requesting', async () => {
    // 带路径或结尾斜杠的记录应被规范化到根地址，避免拼出 /health/health 之类的地址。
    const requestUrls: string[] = []
    const fetchImplementation = (async (input: string | URL | Request) => {
      requestUrls.push(String(input))
      return new Response('not json', { status: 200 })
    }) as unknown as typeof fetch

    await probeLocalService({
      serverUrl: 'http://127.0.0.1:5826/health',
      fetchImplementation,
    })
    await probeLocalService({
      serverUrl: 'http://localhost:5826/',
      fetchImplementation,
    })
    await probeLocalService({
      serverUrl: 'http://[::1]:5826',
      fetchImplementation,
    })

    expect(requestUrls).toEqual([
      'http://127.0.0.1:5826/health',
      'http://localhost:5826/health',
      'http://[::1]:5826/health',
    ])
  })
})

interface IStartJsonServerOptions {
  status: number
  body: unknown
}

/** 启动一个返回固定 JSON 的回环服务，返回其监听端口。 */
async function startJsonServer (
  options: IStartJsonServerOptions,
): Promise<{ port: number }> {
  return await startRawServer({
    statusCode: options.status,
    contentType: 'application/json',
    body: JSON.stringify(options.body),
  })
}

interface IStartRawServerOptions {
  statusCode: number
  contentType: string
  body: string
}

/** 启动一个返回指定原始响应的回环服务，返回其监听端口。 */
async function startRawServer (
  options: IStartRawServerOptions,
): Promise<{ port: number }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(options.statusCode, {
      'Content-Type': options.contentType,
    })
    response.end(options.body)
  })

  return { port: await listenOnLoopback(server) }
}

/** 在回环地址的随机空闲端口上启动服务，返回实际端口并登记以便统一关闭。 */
async function listenOnLoopback (
  server: http.Server | net.Server,
): Promise<number> {
  servers.push(server as http.Server)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('无法获取临时服务的监听端口。')
  }

  return address.port
}

/** 取一个当前空闲的回环端口（先监听再释放）。 */
async function findFreePort (): Promise<number> {
  const probeServer = net.createServer()
  const port = await listenOnLoopback(probeServer)

  await closeServer(probeServer)
  servers.splice(servers.indexOf(probeServer as http.Server), 1)

  return port
}

function closeServer (server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}
