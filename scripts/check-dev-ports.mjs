/**
 * 在开发服务启动前检查 Web 与 CLI 端口，并经用户确认后尝试关闭占用进程。
 */
import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import process from 'node:process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const DEFAULT_WEB_PORT = 5176
const DEFAULT_CLI_PORT = 5826
const PORT_RELEASE_TIMEOUT_MS = 5000
const PORT_RELEASE_INTERVAL_MS = 200

/**
 * 读取开发模式需要检查的 Web 与 CLI 端口配置。
 * @param {NodeJS.ProcessEnv} environment 环境变量集合。
 * @returns {{name: string, port: number, environmentVariable: string}[]} 去重后的开发服务端口列表。
 * @throws 当端口配置不是 1 到 65535 之间的整数时抛出异常。
 */
export function getDevPortTargets(environment = process.env) {
  const targets = [
    {
      name: 'Web',
      port: parseConfiguredPort(environment.AUTHINE_WEB_PORT, DEFAULT_WEB_PORT, 'AUTHINE_WEB_PORT'),
      environmentVariable: 'AUTHINE_WEB_PORT',
    },
    {
      name: 'CLI',
      port: parseConfiguredPort(environment.AUTHINE_CLI_PORT, DEFAULT_CLI_PORT, 'AUTHINE_CLI_PORT'),
      environmentVariable: 'AUTHINE_CLI_PORT',
    },
  ]

  const uniqueTargets = new Map()

  for (const target of targets) {
    const existingTarget = uniqueTargets.get(target.port)

    if (existingTarget) {
      existingTarget.name = `${existingTarget.name}/${target.name}`
      continue
    }

    uniqueTargets.set(target.port, { ...target })
  }

  return [...uniqueTargets.values()]
}

/**
 * 执行开发端口预检，并在必要时询问用户是否关闭占用进程。
 * @param {object} options 预检依赖和交互选项。
 * @param {NodeJS.ProcessEnv} [options.environment] 用于读取端口的环境变量集合。
 * @param {(port: number) => Promise<boolean>} [options.isPortOccupied] 端口占用探测函数。
 * @param {(port: number) => Promise<number[]>} [options.findListeningPids] 监听进程查询函数。
 * @param {(occupiedPorts: object[]) => Promise<boolean>} [options.confirmClose] 用户确认函数。
 * @param {(pid: number) => boolean} [options.terminateProcess] 进程终止函数。
 * @param {(port: number) => Promise<boolean>} [options.waitForPortRelease] 端口释放等待函数。
 * @param {boolean} [options.isInteractive] 是否允许交互式询问。
 * @param {{log: Function, error: Function}} [options.output] 输出对象。
 * @returns {Promise<boolean>} 端口均可用或占用进程已成功关闭时返回 true，否则返回 false。
 * @throws 当端口配置非法或预检依赖抛出未处理异常时抛出异常。
 */
export async function runDevPortPreflight(options = {}) {
  const output = options.output ?? console
  const targets = getDevPortTargets(options.environment ?? process.env)
  const isPortOccupied = options.isPortOccupied ?? defaultIsPortOccupied
  const findListeningPids = options.findListeningPids ?? findListeningProcessIds
  const confirmClose = options.confirmClose ?? askToClosePorts
  const terminateProcess = options.terminateProcess ?? terminateListeningProcess
  const waitForPortRelease = options.waitForPortRelease ?? waitUntilPortReleased
  const isInteractive = options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const occupiedPorts = []

  for (const target of targets) {
    if (await isPortOccupied(target.port)) {
      occupiedPorts.push({
        ...target,
        pids: await findListeningPids(target.port),
      })
    }
  }

  if (occupiedPorts.length === 0) {
    return true
  }

  printOccupiedPorts(output, occupiedPorts)

  if (!isInteractive) {
    output.error('当前终端不可交互，未自动关闭任何进程。请手动停止占用进程或修改端口后重试。')
    return false
  }

  const processIds = [...new Set(occupiedPorts.flatMap((target) => target.pids))]

  if (processIds.length === 0) {
    output.error('未能识别占用端口的进程 PID，无法安全执行关闭操作。请手动停止占用进程后重试。')
    return false
  }

  if (!(await confirmClose(occupiedPorts))) {
    output.log('已取消关闭占用进程，开发服务不会启动。')
    return false
  }

  const failedProcessIds = processIds.filter((pid) => !terminateProcess(pid))

  if (failedProcessIds.length > 0) {
    output.error(`以下进程无法关闭：${failedProcessIds.join(', ')}。请手动停止后重试。`)
    return false
  }

  const unreleasedPorts = []

  for (const target of occupiedPorts) {
    if (!(await waitForPortRelease(target.port))) {
      unreleasedPorts.push(target)
    }
  }

  if (unreleasedPorts.length > 0) {
    output.error(
      `以下端口关闭后仍被占用：${unreleasedPorts.map((target) => target.port).join(', ')}。请手动检查进程后重试。`,
    )
    return false
  }

  output.log('占用进程已关闭，开发服务即将启动。')
  return true
}

/**
 * 解析环境变量中的端口文本并执行范围校验。
 * @param {string | undefined} configuredPort 环境变量中的端口文本。
 * @param {number} fallbackPort 未配置时使用的默认端口。
 * @param {string} environmentVariable 环境变量名称，用于错误提示。
 * @returns {number} 合法的端口号。
 * @throws 当端口不是合法整数或超出 TCP 端口范围时抛出异常。
 */
function parseConfiguredPort(configuredPort, fallbackPort, environmentVariable) {
  const port = configuredPort === undefined || configuredPort.trim() === ''
    ? fallbackPort
    : Number(configuredPort)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${environmentVariable} 必须是 1 到 65535 之间的整数，当前值为：${configuredPort ?? ''}`)
  }

  return port
}

/**
 * 通过尝试监听回环地址判断端口是否已被占用。
 * @param {number} port 待检查的端口号。
 * @returns {Promise<boolean>} 端口被占用或无法安全探测时返回 true，否则返回 false。
 * @throws 不向调用方抛出网络异常，探测异常会按端口不可安全使用处理。
 */
export function defaultIsPortOccupied(port) {
  if (process.platform === 'win32') {
    return findWindowsListeningProcessIds(port).then(async (processIds) => {
      if (processIds.length > 0) {
        return true
      }

      return probePortAvailability(port)
    })
  }

  return probePortAvailability(port)
}

/**
 * 通过尝试监听回环地址判断端口是否已被占用。
 * @param {number} port 待检查的端口号。
 * @returns {Promise<boolean>} 端口被占用时返回 true，否则返回 false。
 * @throws 不向调用方抛出网络异常，探测异常会按端口不可安全使用处理。
 */
function probePortAvailability(port) {
  return new Promise((resolveResult) => {
    const probeServer = net.createServer()
    let settled = false

    const finish = (occupied) => {
      if (settled) {
        return
      }

      settled = true
      resolveResult(occupied)
    }

    probeServer.once('error', () => finish(true))
    probeServer.once('listening', () => {
      probeServer.close((error) => finish(Boolean(error)))
    })
    probeServer.listen(port, '127.0.0.1')
  })
}

/**
 * 查询指定端口上的监听进程 PID。
 * @param {number} port 待查询的端口号。
 * @returns {Promise<number[]>} 去重后的监听进程 PID 列表；查询工具不可用时返回空数组。
 * @throws 不向调用方抛出系统命令异常，查询失败会返回空数组并由上层给出安全提示。
 */
export async function findListeningProcessIds(port) {
  if (process.platform === 'win32') {
    return findWindowsListeningProcessIds(port)
  }

  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-t',
    ])
    return parseProcessIds(stdout)
  } catch {
    return []
  }
}

/**
 * 使用 Windows netstat 输出查询指定端口的监听 PID。
 * @param {number} port 待查询的端口号。
 * @returns {Promise<number[]>} 去重后的监听进程 PID 列表。
 * @throws 不向调用方抛出命令执行异常，查询失败返回空数组。
 */
async function findWindowsListeningProcessIds(port) {
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const processIds = []

    for (const line of stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/)

      if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') {
        continue
      }

      const localPort = getEndpointPort(columns[1])
      const state = columns[3].toUpperCase()
      const pid = Number(columns[4])

      if (localPort === port && state === 'LISTENING' && Number.isInteger(pid) && pid > 0) {
        processIds.push(pid)
      }
    }

    return [...new Set(processIds)]
  } catch {
    return []
  }
}

/**
 * 从 netstat 的地址文本中提取端口号。
 * @param {string} endpoint 本地监听地址，例如 `127.0.0.1:5176` 或 `[::]:5176`。
 * @returns {number | null} 解析出的端口号，无法解析时返回 null。
 * @throws 不抛出异常。
 */
function getEndpointPort(endpoint) {
  const match = endpoint.match(/:(\d+)$/)
  return match ? Number(match[1]) : null
}

/**
 * 将命令输出中的每行 PID 转换为去重后的数字列表。
 * @param {string} processOutput 进程查询命令输出。
 * @returns {number[]} 合法且去重后的 PID 列表。
 * @throws 不抛出异常。
 */
function parseProcessIds(processOutput) {
  return [...new Set(
    processOutput
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  )]
}

/**
 * 打印已占用端口和对应进程信息。
 * @param {{log: Function}} output 输出对象。
 * @param {{name: string, port: number, pids: number[]}[]} occupiedPorts 已占用端口信息。
 * @returns {void} 打印完成后无返回值。
 * @throws 不抛出异常。
 */
function printOccupiedPorts(output, occupiedPorts) {
  output.log('\n检测到开发端口已被占用：')

  for (const target of occupiedPorts) {
    const processDescription = target.pids.length > 0 ? `PID ${target.pids.join(', ')}` : 'PID 未知'
    output.log(`  - ${target.name} 端口 ${target.port}（${processDescription}）`)
  }
}

/**
 * 通过标准输入询问用户是否关闭端口占用进程。
 * @param {{name: string, port: number, pids: number[]}[]} occupiedPorts 已占用端口信息。
 * @returns {Promise<boolean>} 用户输入 y、yes 或“是”时返回 true，否则返回 false。
 * @throws 当标准输入输出无法创建交互界面时抛出异常。
 */
async function askToClosePorts(occupiedPorts) {
  const readline = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const answer = await readline.question(
      `是否尝试关闭以上端口的占用进程（${occupiedPorts.flatMap((target) => target.pids).join(', ')}）？[y/N] `,
    )
    return /^(y|yes|是)$/i.test(answer.trim())
  } finally {
    readline.close()
  }
}

/**
 * 向指定进程发送温和终止信号。
 * @param {number} pid 待终止的进程 PID。
 * @returns {boolean} 信号发送成功时返回 true，否则返回 false。
 * @throws 不向调用方抛出进程信号异常。
 */
export function terminateListeningProcess(pid) {
  if (pid === process.pid) {
    return false
  }

  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/**
 * 等待端口释放，避免开发服务与旧进程发生启动竞态。
 * @param {number} port 待等待的端口号。
 * @param {object} options 等待参数。
 * @param {number} [options.timeoutMs] 最大等待时间。
 * @param {number} [options.intervalMs] 两次探测之间的间隔。
 * @returns {Promise<boolean>} 在超时前释放时返回 true，否则返回 false。
 * @throws 不向调用方抛出探测异常。
 */
export async function waitUntilPortReleased(
  port,
  { timeoutMs = PORT_RELEASE_TIMEOUT_MS, intervalMs = PORT_RELEASE_INTERVAL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    if (!(await defaultIsPortOccupied(port))) {
      return true
    }

    await new Promise((resolveResult) => setTimeout(resolveResult, intervalMs))
  }

  return !(await defaultIsPortOccupied(port))
}

/**
 * 判断当前脚本是否由 Node 直接执行，而不是被测试或其他模块导入。
 * @returns {boolean} 当前模块为进程入口时返回 true，否则返回 false。
 * @throws 不抛出异常。
 */
function isMainModule() {
  return Boolean(
    process.argv[1] &&
      resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]),
  )
}

if (isMainModule()) {
  try {
    const canStart = await runDevPortPreflight()

    if (!canStart) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`开发端口预检失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
