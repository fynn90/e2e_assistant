/**
 * 读取本 CLI 包（`@authine-e2e-agent/cli`）自身的版本号。
 *
 * 为什么从 package.json 运行时读取，而不是构建期注入常量：版本号由发布流程
 * （changesets）唯一维护在 package.json 里，注入会引入第二处需要同步的定义，
 * 一旦漏改就会出现「面板报的版本与 npm 上安装到的版本对不上」这类最难排查的问题。
 *
 * 解析方式是**包自我引用**（self-reference）：Node 依据最近的 package.json 的
 * `name` 字段认出「这就是我自己」，再走该包 `exports` 的白名单。因此本包的
 * package.json 必须导出 `./package.json`，否则这里只会拿到
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`。源码（tsx）与构建产物（dist）两种运行形态
 * 均可解析，与当前工作目录无关。
 */
import { createRequire } from 'node:module'

/** 以本模块所在位置为基准解析，因此不依赖进程的工作目录。 */
const resolveFromCliPackage = createRequire(import.meta.url)

/**
 * 读取 CLI 包自身的版本号。
 *
 * @returns 版本号文本（如 `0.2.1`，不含 `v` 前缀——与 package.json 逐字一致）；
 *   包环境不完整（被整体打进其他产物、exports 白名单缺项）导致解析失败时返回 null。
 * @throws 不抛出异常；解析失败收敛为 null，由调用方决定不渲染该行。
 */
export function getCliPackageVersion(): string | null {
  try {
    const packageManifest: unknown = resolveFromCliPackage(
      '@authine-e2e-agent/cli/package.json',
    )

    if (!packageManifest || typeof packageManifest !== 'object') {
      return null
    }

    const version = (packageManifest as { version?: unknown }).version

    return typeof version === 'string' && version ? version : null
  } catch {
    return null
  }
}
