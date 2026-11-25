/**
 * 本地服务的端口解析：在首选端口不可用时顺延，或在严格模式下要求端口必须可用。
 *
 * 位置说明：端口解析与监听是同一件事——`server.ts` 在选定端口上执行 `serve()`，
 * 因此这三个函数与服务监听同处 http/ 层，而不是留在调用方（CLI）。
 * 调用方只负责「决定要用哪个首选端口」并把结果传进来（见 PRD v18 §6.1.1）。
 */
import net from 'node:net'

interface IPortOptions {
  port: number
}

interface IFindAvailablePortOptions {
  preferredPort: number
}

/**
 * 在首选端口不可用时查找下一个可用端口。
 * @param options 端口探测参数，包含首选端口。
 * @returns 可供本地服务监听的端口号。
 * @throws 当首选端口不在合法范围内，或没有可用端口时抛出异常。
 */
export async function findAvailablePort(
  options: IFindAvailablePortOptions,
): Promise<number> {
  validatePort(options.preferredPort)

  let currentPort = options.preferredPort

  while (!(await isPortAvailable(currentPort))) {
    currentPort += 1

    if (currentPort > 65535) {
      throw new Error('没有可用的本地端口。')
    }
  }

  return currentPort
}

/**
 * 要求指定端口必须可用，用于 Web 与 CLI 必须共享端口的开发模式。
 * @param options 端口校验参数，包含必须监听的端口。
 * @returns 校验通过的端口号。
 * @throws 当端口参数非法或端口已被占用时抛出带有处理建议的异常。
 */
export async function requireAvailablePort(
  options: IPortOptions,
): Promise<number> {
  validatePort(options.port)

  if (!(await isPortAvailable(options.port))) {
    throw new Error(
      `CLI 端口 ${options.port} 已被占用。请停止占用该端口的服务，或设置 AUTHINE_CLI_PORT 为其他端口后重试。`,
    )
  }

  return options.port
}

/**
 * 校验端口号是否位于 TCP 合法范围内。
 * @param port 待校验的端口号。
 * @returns 参数合法时无返回值。
 * @throws 当端口不是 1 到 65535 之间的整数时抛出异常。
 */
function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1 到 65535 之间的整数。')
  }
}

/**
 * 通过短暂创建 TCP 服务判断回环地址上的端口是否可监听。
 * @param port 待探测的端口号。
 * @returns 端口可监听时返回 true，否则返回 false。
 * @throws 不直接抛出网络异常，所有监听错误都会转换为 false。
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const portProbeServer = net.createServer()

    portProbeServer.once('error', () => resolve(false))
    portProbeServer.once('listening', () => {
      portProbeServer.close(() => resolve(true))
    })
    portProbeServer.listen(port, '127.0.0.1')
  })
}
