/**
 * 验证开发端口预检脚本的端口解析、交互决策和占用进程关闭流程。
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { afterEach, test } from 'node:test'
import {
  defaultIsPortOccupied,
  getDevPortTargets,
  runDevPortPreflight,
} from './check-dev-ports.mjs'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

/**
 * 创建用于模拟端口占用的临时 TCP 服务。
 * @returns {Promise<{server: net.Server, port: number}>} 已开始监听的 TCP 服务和实际端口。
 * @throws 当服务无法监听回环地址时抛出异常。
 */
async function createListeningServer() {
  const server = net.createServer()
  await new Promise((resolveResult, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveResult())
  })
  servers.push(server)
  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('无法获取临时 TCP 服务的监听端口。')
  }

  return { server, port: address.port }
}

/**
 * 关闭测试中创建的 TCP 服务。
 * @param {net.Server} server 待关闭的 TCP 服务。
 * @returns {Promise<void>} 服务关闭后无返回值。
 * @throws 当服务关闭失败时抛出异常。
 */
function closeServer(server) {
  return new Promise((resolveResult, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolveResult()
    })
  })
}

/**
 * 创建收集预检输出的模拟控制台对象。
 * @returns {{logs: string[], errors: string[], log: (message: string) => void, error: (message: string) => void}} 输出记录对象。
 * @throws 不抛出异常。
 */
function createOutputCollector() {
  const logs = []
  const errors = []

  return {
    logs,
    errors,
    log(message) {
      logs.push(message)
    },
    error(message) {
      errors.push(message)
    },
  }
}

test('默认读取 Web 和 CLI 开发端口，并允许自定义端口', () => {
  assert.deepEqual(getDevPortTargets({}), [
    { name: 'Web', port: 5176, environmentVariable: 'AUTHINE_WEB_PORT' },
    { name: 'CLI', port: 5826, environmentVariable: 'AUTHINE_CLI_PORT' },
  ])
  assert.deepEqual(getDevPortTargets({ AUTHINE_WEB_PORT: '5177', AUTHINE_CLI_PORT: '5827' }), [
    { name: 'Web', port: 5177, environmentVariable: 'AUTHINE_WEB_PORT' },
    { name: 'CLI', port: 5827, environmentVariable: 'AUTHINE_CLI_PORT' },
  ])
})

test('相同端口会合并为一个检查目标，非法端口会被拒绝', () => {
  assert.deepEqual(getDevPortTargets({ AUTHINE_WEB_PORT: '6000', AUTHINE_CLI_PORT: '6000' }), [
    { name: 'Web/CLI', port: 6000, environmentVariable: 'AUTHINE_WEB_PORT' },
  ])
  assert.throws(
    () => getDevPortTargets({ AUTHINE_WEB_PORT: 'not-a-port' }),
    /AUTHINE_WEB_PORT 必须是 1 到 65535 之间的整数/,
  )
})

test('TCP 探测能够识别被占用和已释放的端口', async () => {
  const { server, port } = await createListeningServer()

  assert.equal(await defaultIsPortOccupied(port), true)
  await closeServer(server)
  servers.splice(servers.indexOf(server), 1)
  assert.equal(await defaultIsPortOccupied(port), false)
})

test('非交互终端发现占用端口时不会关闭进程', async () => {
  let confirmed = false
  let terminated = false
  const output = createOutputCollector()

  const canStart = await runDevPortPreflight({
    environment: { AUTHINE_WEB_PORT: '5176', AUTHINE_CLI_PORT: '5826' },
    isPortOccupied: async (port) => port === 5176,
    findListeningPids: async () => [12345],
    confirmClose: async () => {
      confirmed = true
      return true
    },
    terminateProcess: () => {
      terminated = true
      return true
    },
    isInteractive: false,
    output,
  })

  assert.equal(canStart, false)
  assert.equal(confirmed, false)
  assert.equal(terminated, false)
  assert.match(output.errors.join('\n'), /不可交互/)
})

test('用户拒绝关闭时会阻止开发服务启动', async () => {
  let terminated = false
  const output = createOutputCollector()

  const canStart = await runDevPortPreflight({
    environment: { AUTHINE_WEB_PORT: '5176', AUTHINE_CLI_PORT: '5826' },
    isPortOccupied: async (port) => port === 5826,
    findListeningPids: async () => [54321],
    confirmClose: async () => false,
    terminateProcess: () => {
      terminated = true
      return true
    },
    isInteractive: true,
    output,
  })

  assert.equal(canStart, false)
  assert.equal(terminated, false)
  assert.match(output.logs.join('\n'), /已取消关闭/)
})

test('确认关闭后会终止去重的 PID 并等待所有端口释放', async () => {
  const terminatedProcessIds = []
  const releasedPorts = []
  const output = createOutputCollector()

  const canStart = await runDevPortPreflight({
    environment: { AUTHINE_WEB_PORT: '5176', AUTHINE_CLI_PORT: '5826' },
    isPortOccupied: async () => true,
    findListeningPids: async (port) => port === 5176 ? [10001, 10002] : [10002],
    confirmClose: async () => true,
    terminateProcess: (pid) => {
      terminatedProcessIds.push(pid)
      return true
    },
    waitForPortRelease: async (port) => {
      releasedPorts.push(port)
      return true
    },
    isInteractive: true,
    output,
  })

  assert.equal(canStart, true)
  assert.deepEqual(terminatedProcessIds, [10001, 10002])
  assert.deepEqual(releasedPorts, [5176, 5826])
  assert.match(output.logs.join('\n'), /占用进程已关闭/)
})

test('无法识别 PID 时不会尝试关闭未知进程', async () => {
  let confirmed = false
  const output = createOutputCollector()

  const canStart = await runDevPortPreflight({
    environment: { AUTHINE_WEB_PORT: '5176', AUTHINE_CLI_PORT: '5826' },
    isPortOccupied: async (port) => port === 5176,
    findListeningPids: async () => [],
    confirmClose: async () => {
      confirmed = true
      return true
    },
    isInteractive: true,
    output,
  })

  assert.equal(canStart, false)
  assert.equal(confirmed, false)
  assert.match(output.errors.join('\n'), /未能识别/)
})
