/**
 * 打开系统默认浏览器，失败不视为启动失败。
 *
 * 存在的理由（macOS / Linux 兼容）：无图形环境的 Linux（服务器、容器、未装
 * xdg-open 的精简发行版）上 `open()` 会抛错——但服务已经起来了。把「打不开
 * 浏览器」报成「启动失败」，会让一次成功的启动显示为失败、并以退出码 1 误导
 * 脚本；后台模式下服务其实还在跑，用户却以为没起来。
 *
 * 因此本函数只做一件事：打开成功则静默，失败则打印可手动访问的地址。
 */
import open from 'open'
import { renderNoticeLine } from '../../presentation/console/message-line'

/** 打开器签名；与 `open` 的默认导出一致，测试可注入替身。 */
export type TOpenBrowser = (serverUrl: string) => Promise<unknown>

/**
 * 打开浏览器；失败时提示地址，不向上抛错。
 *
 * 「打不开浏览器」是功能降级而非操作失败，因此走 `warn` 级别而非 `error`——
 * `error` 会让人以为服务没起来，而它其实跑得好好的。
 *
 * @param serverUrl - 要打开的服务地址。
 * @param openBrowser - 打开实现；缺省用 `open` 包，测试注入替身。
 * @param log - 输出通道；缺省 console.log，测试注入以捕获文案。
 * @returns 打开流程结束后无返回值。
 * @throws 不抛出异常；打开失败只输出提示。
 */
export async function openBrowserQuietly(
  serverUrl: string,
  openBrowser: TOpenBrowser = open,
  log: (message: string) => void = console.log,
): Promise<void> {
  try {
    await openBrowser(serverUrl)
  } catch {
    log(
      renderNoticeLine({
        level: 'warn',
        message: `未能自动打开浏览器（当前环境可能没有可用的浏览器），请手动访问：${serverUrl}`,
      }),
    )
  }
}
