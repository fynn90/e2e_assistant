/**
 * 解析 CLI 侧使用的配置目录与运行态文件路径。
 *
 * 用户级配置根目录与 e2e_assistant 目录名由 `@charlie_deng/e2e-assistant-config` 统一解析——
 * 本进程的 runtime.json 与服务层的 config.json 必须落在同一目录下（PRD v18 §4.5）。
 * 本文件只负责拼接 CLI 自己的文件名。
 */
import path from 'node:path'
import { getAuthineConfigDirectory } from '@charlie_deng/e2e-assistant-config'

const AUTHINE_RUNTIME_FILE_NAME = 'runtime.json'
const AUTHINE_CONFIG_FILE_NAME = 'config.json'

export { getAuthineConfigDirectory }

/**
 * 获取运行态文件绝对路径。
 * @returns 运行态文件 `runtime.json` 的绝对路径。
 * @throws 不抛出异常。
 */
export function getPlatformRuntimePath (): string {
  return path.join(getAuthineConfigDirectory(), AUTHINE_RUNTIME_FILE_NAME)
}

/**
 * 获取平台配置文件绝对路径。
 *
 * CLI 不读写 config.json（那是服务层的职责），但启动前要确保该文件所在的
 * 配置目录已按安全权限初始化，故需要拼接它的路径用于目录预检。
 *
 * @returns 配置文件 `config.json` 的绝对路径。
 * @throws 不抛出异常。
 */
export function getPlatformConfigPath (): string {
  return path.join(getAuthineConfigDirectory(), AUTHINE_CONFIG_FILE_NAME)
}
