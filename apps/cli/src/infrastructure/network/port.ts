/**
 * 读取 CLI 命令参数使用的默认端口。
 *
 * 环境变量属于 CLI 语义：服务层不读 `AUTHINE_CLI_PORT`，
 * 它只在「决定要不要起、起在哪个首选端口」时由 CLI 解析并作为参数传入
 * （见 PRD v18 §4.3 E1 / §6.1.1）。
 */

/**
 * 读取 CLI 使用的默认端口配置。
 * @returns 环境变量 AUTHINE_CLI_PORT 的值，不存在时返回 5826。
 * @throws 不直接抛出异常，非法端口会在服务启动时由端口校验统一报告。
 */
export function getDefaultCliPort(): string {
  return process.env.AUTHINE_CLI_PORT ?? '5826'
}
