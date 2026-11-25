/**
 * 开发模式下启动 CLI，并在依赖包或 CLI 自身源码变化时自动重启。
 *
 * 为什么不直接用 `tsx watch`：在 Windows 上，concurrently 以 `cmd.exe` + 常开 stdin 管道
 * 的方式拉起子进程，`tsx watch` 在这种 stdin 形态下会挂起——进程活着但不执行脚本、
 * 不监听端口（实测：单跑 `tsx watch` 正常，套一层 concurrently 即复现）。
 * 本脚本改为自行监听文件变化并重启子进程，不依赖 stdin。
 *
 * 监听范围：
 *   - CLI 自身源码目录 `apps/cli/src`（tsx 直接执行，重启即生效）；
 *   - 各依赖包的构建产物目录 `packages/<包名>/dist`（tsup --watch 重建后触发）。
 *
 * 重启前先结束上一个子进程并等待其退出，避免 `--strict-port` 因端口未释放而报错。
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const workspaceRootPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const cliDirectoryPath = path.join(workspaceRootPath, 'apps/cli')

/**
 * tsx 的可执行入口。
 *
 * 直接 spawn `node_modules/.bin/tsx` 在 Windows 上会命中 POSIX sh 脚本（无扩展名的那个），
 * Node 按 CommonJS 解析它会报语法错误。因此从 CLI 包的 node_modules 里显式定位 tsx 的真实入口。
 *
 * 用 createRequire 而非 import.meta.resolve：后者按「本脚本所在位置」解析，
 * 而 tsx 是 apps/cli 的 devDependency，从 scripts/ 目录里看不见它。
 */
const requireFromCli = createRequire(path.join(cliDirectoryPath, 'package.json'))
const tsxPackageJson = requireFromCli('tsx/package.json')
// bin 可能是字符串（单命令）或对象（多命令）；tsx 当前是字符串。
const tsxBinRelativePath =
  typeof tsxPackageJson.bin === 'string'
    ? tsxPackageJson.bin
    : tsxPackageJson.bin.tsx
const tsxEntryPath = path.join(
  path.dirname(requireFromCli.resolve('tsx/package.json')),
  tsxBinRelativePath.replace(/^\.\//, ''),
)

/** 监听变更后等待多久再重启：让 tsup 把同一次保存产生的多文件变更写完。 */
const RESTART_DEBOUNCE_MS = 300
/** 优雅结束子进程的等待上限；超时后强制结束。 */
const SHUTDOWN_TIMEOUT_MS = 5000

let cliProcess = null
let restartTimer = null
let isShuttingDown = false

/**
 * 启动 CLI 子进程。
 * @returns 启动完成后无返回值。
 * @throws 当子进程无法创建时抛出异常。
 */
function startCliProcess() {
  // v19：`start` 默认后台运行（启动器派生完就退出）。开发 watcher 需要的是
  // 「前台阻塞」语义，因此显式加 --foreground——否则 CLI 子进程立即返回，
  // watcher 会认为它已死，自动重启随之失效。
  cliProcess = spawn(
    process.execPath,
    [
      tsxEntryPath,
      'src/index.ts',
      'start',
      '--foreground',
      '--no-open',
      '--strict-port',
    ],
    {
      cwd: cliDirectoryPath,
      stdio: 'inherit',
      env: process.env,
    },
  )

  cliProcess.on('exit', (code, signal) => {
    if (!isShuttingDown && code !== 0 && code !== null) {
      console.error(`[cli-watch] CLI 进程已退出（code=${code}），等待下次文件变更后重启。`)
    }
    cliProcess = null
  })
}

/**
 * 结束当前 CLI 子进程并等待其退出。
 *
 * 必须等到真正退出：CLI 用 `--strict-port` 启动，若端口尚未释放就重启，
 * 新进程会因端口占用而启动失败。
 *
 * @returns 子进程已退出（或本就没有子进程）时无返回值。
 * @throws 不抛出异常。
 */
async function stopCliProcess() {
  const processToStop = cliProcess

  if (!processToStop || processToStop.exitCode !== null) {
    return
  }

  const hasExited = new Promise((resolve) => {
    processToStop.once('exit', () => resolve(true))
  })

  processToStop.kill('SIGTERM')

  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS),
  )

  if (!(await Promise.race([hasExited, timeout]))) {
    // 优雅结束超时：CLI 通常会在 SIGTERM 时清理运行态记录，超时说明它卡住了。
    processToStop.kill('SIGKILL')
    await hasExited
  }
}

/**
 * 重启 CLI 子进程。
 * @returns 重启完成后无返回值。
 * @throws 不抛出异常。
 */
async function restartCliProcess() {
  console.log('[cli-watch] 检测到变更，正在重启 CLI...')
  await stopCliProcess()
  startCliProcess()
}

/**
 * 安排一次防抖重启：同一次保存可能触发多个文件事件。
 * @param changedPath 触发变更的文件路径（用于日志）。
 * @returns 安排完成后无返回值。
 * @throws 不抛出异常。
 */
function scheduleRestart(changedPath) {
  if (isShuttingDown) {
    return
  }

  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    console.log(`[cli-watch] ${changedPath}`)
    void restartCliProcess()
  }, RESTART_DEBOUNCE_MS)
}

/**
 * 递归监听目录下的文件变更。
 *
 * 只对 `shouldWatch` 认可的文件触发重启——目录里同时会有临时文件、sourcemap 等
 * 与运行无关的产物，不过滤会让它们也触发重启。
 *
 * 注意参数方向：`shouldWatch` 是「值得监听」判定，返回 true 才触发重启。
 * 不要写成「忽略」判定——那会把 `.ts` / `.js` 这些恰好命中的文件全部过滤掉，
 * 表现为「改了文件但从不重启」。
 *
 * @param directoryPath 待监听目录。
 * @param shouldWatch 判断某个文件名是否值得触发重启。
 * @returns 监听器就绪后无返回值。
 * @throws 当目录不存在时抛出异常。
 */
function watchDirectory(directoryPath, shouldWatch) {
  watch(directoryPath, { recursive: true }, (_eventType, fileName) => {
    if (!fileName || !shouldWatch(fileName)) {
      return
    }

    scheduleRestart(path.relative(workspaceRootPath, path.join(directoryPath, fileName)))
  })
}

/**
 * 判断 CLI 自身源码文件是否值得触发重启。
 *
 * 只认 `.ts`：`apps/cli/src` 下还会出现编辑器临时文件等无关内容。
 *
 * @param fileName 变更的文件名（相对被监听目录）。
 * @returns 值得重启时返回 true。
 * @throws 不抛出异常。
 */
export function shouldWatchCliSource(fileName) {
  return fileName.endsWith('.ts')
}

/**
 * 判断依赖包的构建产物是否值得触发重启。
 *
 * 只认 `.js`：`tsup` 同时产出 `.d.ts` 与 sourcemap，监听它们会造成同一轮重建多次重启。
 *
 * @param fileName 变更的文件名（相对被监听目录）。
 * @returns 值得重启时返回 true。
 * @throws 不抛出异常。
 */
export function shouldWatchPackageDist(fileName) {
  return fileName.endsWith('.js') && !fileName.endsWith('.map')
}

/**
 * 需要监听构建产物的依赖包名。
 *
 * 不含 `web`：它是前端产物、由 Vite 自行处理，CLI 只在运行期读取其 dist 目录。
 */
export const WATCHED_PACKAGE_NAMES = [
  'service',
  'web-host',
  'agent',
  'skill-manager',
  'playwright-engine',
  'config',
  'types',
]

/**
 * 结束本进程与全部子进程。
 * @param exitCode 退出码。
 * @returns 退出流程完成后无返回值。
 * @throws 不抛出异常。
 */
async function shutdown(exitCode) {
  if (isShuttingDown) {
    return
  }

  isShuttingDown = true
  clearTimeout(restartTimer)
  await stopCliProcess()
  process.exit(exitCode)
}

/**
 * 判断当前脚本是否由 Node 直接执行，而不是被测试导入。
 * @returns 当前模块为进程入口时返回 true。
 * @throws 不抛出异常。
 */
function isMainModule() {
  return Boolean(
    process.argv[1] &&
      path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]),
  )
}

if (isMainModule()) {
  process.once('SIGINT', () => void shutdown(0))
  process.once('SIGTERM', () => void shutdown(0))

  startCliProcess()

  watchDirectory(path.join(cliDirectoryPath, 'src'), shouldWatchCliSource)

  for (const packageName of WATCHED_PACKAGE_NAMES) {
    const distPath = path.join(workspaceRootPath, 'packages', packageName, 'dist')

    try {
      watchDirectory(distPath, shouldWatchPackageDist)
    } catch {
      // 依赖包尚未构建时没有 dist 目录：跳过即可，它构建后由 tsup --watch 自行产出。
    }
  }
}
