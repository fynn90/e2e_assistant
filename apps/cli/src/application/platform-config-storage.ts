/**
 * 启动前的配置存储预检：确保平台配置目录已按安全权限创建。
 *
 * CLI 不读写 config.json 的内容（平台配置的读写是服务层职责），但在启动服务前
 * 需要保证该目录存在且可写——若不可写，早失败能以「Authine CLI 执行失败：<原因>」
 * 的既有形式给出明确提示，而不是等到服务启动后由某个 API 请求报错。
 *
 * 与 `secure-file.ts` / `storage-error.ts` 一同由服务层复制而来：它们是稳定的
 * 工具代码，复制两个副本的成本低于「CLI 访问服务层内部模块」的架构代价
 * （见 PRD v18 §4.5 与 V18 技术方案 §6.3）。
 */
import { getAuthineConfigDirectory, getPlatformConfigPath } from '../infrastructure/config/config-path'
import { buildStorageAccessError } from '../infrastructure/config/storage-error'
import {
  ensureSecureDirectory,
  ensureSecureFile,
} from '../infrastructure/config/secure-file'

/**
 * 初始化平台配置存储：创建安全的配置目录与空的配置文件。
 *
 * @returns 初始化完成后无返回值。
 * @throws 当配置目录不可写或文件创建失败时抛出带有处理建议的异常。
 */
export async function ensurePlatformConfigStorage(): Promise<void> {
  const configDirectoryPath = getAuthineConfigDirectory()
  const configPath = getPlatformConfigPath()

  try {
    await ensureSecureDirectory(configDirectoryPath)
    await ensureSecureFile(configPath)
  } catch (error) {
    throw buildStorageAccessError({
      actionLabel: '初始化配置存储',
      targetPath: configPath,
      error,
    })
  }
}
