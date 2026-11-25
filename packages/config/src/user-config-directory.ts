/**
 * 解析用户级配置根目录（跨包共享）。
 *
 * 本函数是 CLI 与服务层共同遵守的目录约定——两侧各自拼接自己的文件名：
 * CLI 用 runtime.json（进程管理），服务层用 config.json（平台配置）。
 * 两者必须落在同一目录下，因此解析逻辑必须唯一，不能各写一份。
 *
 * 环境变量（APPDATA / XDG_CONFIG_HOME）在调用时读取而非模块加载时读取，
 * 使测试与 e2e 可以在运行中通过设置环境变量隔离配置目录。
 */
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const AUTHINE_CONFIG_DIRECTORY_NAME = 'e2e_assistant'

/**
 * 解析当前操作系统下的用户级配置根目录。
 *
 * @returns 当前系统建议使用的配置根目录绝对路径。
 * @throws 不抛出异常。
 */
export function getUserConfigRootDirectory (): string {
  if (process.platform === 'win32') {
    return resolveWindowsConfigRootDirectory()
  }

  return resolvePosixConfigRootDirectory()
}

/**
 * 获取平台配置目录的绝对路径（用户级配置根目录下的固定目录名）。
 *
 * 两侧各自在此之下拼接自己的文件名：CLI 用 runtime.json，服务层用 config.json。
 *
 * @returns 跨平台统一的 Authine 配置目录绝对路径。
 * @throws 不抛出异常。
 */
export function getAuthineConfigDirectory (): string {
  return path.join(getUserConfigRootDirectory(), AUTHINE_CONFIG_DIRECTORY_NAME)
}

/**
 * 解析 Windows 下的用户级配置根目录。
 * @returns Windows 推荐的配置根目录绝对路径。
 * @throws 不抛出异常。
 */
function resolveWindowsConfigRootDirectory (): string {
  const temp_appDataDirectory = process.env.APPDATA?.trim()

  if (temp_appDataDirectory) {
    return temp_appDataDirectory
  }

  return path.join(homedir(), 'AppData', 'Roaming')
}

/**
 * 解析 macOS 与 Linux 下的用户级配置根目录。
 * @returns POSIX 系统推荐的配置根目录绝对路径。
 * @throws 不抛出异常。
 */
function resolvePosixConfigRootDirectory (): string {
  const temp_xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()

  if (temp_xdgConfigHome) {
    return temp_xdgConfigHome
  }

  return path.join(homedir(), '.config')
}
