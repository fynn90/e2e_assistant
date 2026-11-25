/**
 * 解析服务层使用的平台配置目录与文件路径。
 *
 * 用户级配置根目录由 `@authine-e2e-agent/config` 统一解析——CLI 的
 * runtime.json 与本服务的 config.json 必须落在同一目录下（见 PRD v18 §4.5）。
 * 本文件只负责拼接服务层自己的文件名。
 */
import path from 'node:path'
import { getAuthineConfigDirectory } from '@authine-e2e-agent/config'

const AUTHINE_CONFIG_FILE_NAME = 'config.json'
const AUTHINE_SKILLS_DIRECTORY_NAME = 'skills'

export { getAuthineConfigDirectory }

/**
 * 获取平台配置文件绝对路径。
 * @returns 配置文件 `config.json` 的绝对路径。
 * @throws 不抛出异常。
 */
export function getPlatformConfigPath(): string {
  return path.join(getAuthineConfigDirectory(), AUTHINE_CONFIG_FILE_NAME)
}

/**
 * 获取本地技能存储目录绝对路径。
 *
 * 当前全仓暂无调用者：它表达的是「技能存储目录」这一约定（技能默认落在
 * 配置目录的 skills/ 之下），属尚未启用的约定而非死代码，故保留（见 PRD v18 R6/Q3）。
 *
 * @returns 技能根目录绝对路径。
 * @throws 不抛出异常。
 */
export function getSkillStorageDirectory(): string {
  return path.join(getAuthineConfigDirectory(), AUTHINE_SKILLS_DIRECTORY_NAME)
}
