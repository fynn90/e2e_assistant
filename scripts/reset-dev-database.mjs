/**
 * 开发阶段数据库重置脚本：删除本地 SQLite 数据文件，由服务下次启动时重建。
 *
 * 背景：表结构变更后无法依赖 `CREATE TABLE IF NOT EXISTS` 自动补列——
 * 它对已存在的表整体跳过，旧库会在首次写入时报「no such column」。
 * 开发阶段不实现列迁移，直接重建库更简单可靠。
 *
 * 覆盖范围（工作区下的 .e2e-agent 目录）：
 *   - work-blocks.db  Agent 工作过程展示存储（会话列表、历史时间线）
 *   - sessions.db     模型多轮上下文存储（断点续跑历史）
 *
 * 该目录下的数据均为可再生数据：删除后历史会话记录丢失，但 Skill 文件、
 * 用例配置等业务产物不受影响。
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

/** 工作区内 Agent 运行时数据目录名（与 RUNTIME_DATA_DIR 保持一致）。 */
const RUNTIME_DATA_DIR = '.e2e-agent'

/** 该目录下需要清理的数据库文件主名（含 -wal / -shm 附属文件）。 */
const DATABASE_FILE_BASES = ['work-blocks.db', 'sessions.db']

/** SQLite WAL 模式的附属文件后缀。 */
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm']

/** Authine CLI 配置目录名（与 config-path.ts 保持一致）。 */
const AUTHINE_CONFIG_DIRECTORY_NAME = 'e2e_assistant'

/**
 * 解析当前系统的用户级配置根目录（与 CLI 的 config-path.ts 逻辑一致）。
 * @returns {string} 配置根目录绝对路径。
 * @throws 不抛出异常。
 */
function getUserConfigRootDirectory () {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    return appData || path.join(homedir(), 'AppData', 'Roaming')
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
  return xdgConfigHome || path.join(homedir(), '.config')
}

/**
 * 读取平台配置里的工作区目录。
 * @returns {string | null} 工作区绝对路径；配置缺失或不可读时返回 null。
 * @throws 不抛出异常，读取失败按「未知工作区」处理。
 */
function readWorkspaceDirectory () {
  const configPath = path.join(
    getUserConfigRootDirectory(),
    AUTHINE_CONFIG_DIRECTORY_NAME,
    'config.json',
  )

  if (!existsSync(configPath)) {
    return null
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'))
    const directory = typeof raw.projectDirectory === 'string' ? raw.projectDirectory.trim() : ''
    return directory ? path.resolve(directory) : null
  } catch {
    return null
  }
}

/**
 * 列出指定工作区下需要删除的数据库文件。
 * @param {string} workspace 工作区绝对路径。
 * @returns {string[]} 实际存在的待删除文件绝对路径。
 * @throws 不抛出异常。
 */
function listDatabaseFiles (workspace) {
  const dataDirectory = path.join(workspace, RUNTIME_DATA_DIR)

  if (!existsSync(dataDirectory)) {
    return []
  }

  const entries = new Set(readdirSync(dataDirectory))

  return DATABASE_FILE_BASES.flatMap((base) =>
    [base, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${base}${suffix}`)]
      .filter((name) => entries.has(name))
      .map((name) => path.join(dataDirectory, name)),
  )
}

/**
 * 交互确认：避免误删尚未备份的开发数据。
 * @param {string[]} files 待删除文件列表。
 * @returns {Promise<boolean>} 用户确认时返回 true。
 * @throws 当标准输入输出无法创建交互界面时抛出异常。
 */
async function confirmRemoval (files) {
  if (process.env.AUTHINE_RESET_YES === '1') {
    return true
  }

  // 非交互环境（CI、管道）下不阻塞，直接拒绝，强制显式传 --yes。
  if (!process.stdin.isTTY) {
    return false
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const answer = await readline.question(
      `将删除以上 ${files.length} 个文件（不可恢复）。是否继续？[y/N] `,
    )
    return /^(y|yes|是)$/i.test(answer.trim())
  } finally {
    readline.close()
  }
}

/**
 * 执行数据库重置。
 * @param {{yes?: boolean}} options 运行选项；yes 为 true 时跳过交互确认。
 * @returns {Promise<number>} 进程退出码：0 成功，1 失败。
 * @throws 当文件删除失败时抛出异常。
 */
export async function resetDevDatabase ({ yes = false } = {}) {
  const workspace = readWorkspaceDirectory()

  if (!workspace) {
    console.error('未找到平台配置中的工作区目录（projectDirectory）。请先运行 e2e_assistant start 完成配置。')
    return 1
  }

  console.log(`工作区：${workspace}`)

  const files = listDatabaseFiles(workspace)

  if (files.length === 0) {
    console.log('未发现本地数据库文件，无需清理（服务启动时会自动创建）。')
    return 0
  }

  console.log('待删除的数据库文件：')
  for (const file of files) {
    console.log(`  - ${file}`)
  }

  const confirmed = yes || (await confirmRemoval(files))

  if (!confirmed) {
    console.log('已取消，未删除任何文件。')
    return 1
  }

  // 逐个删除：Windows 上若服务仍在运行，文件句柄被占用会报 EBUSY。
  const failures = []

  for (const file of files) {
    try {
      rmSync(file, { force: true })
      console.log(`已删除：${file}`)
    } catch (error) {
      failures.push({ file, message: error instanceof Error ? error.message : String(error) })
    }
  }

  if (failures.length > 0) {
    console.error('\n以下文件删除失败（通常是服务仍在运行，请先执行 e2e_assistant stop）：')
    for (const failure of failures) {
      console.error(`  - ${failure.file}：${failure.message}`)
    }
    return 1
  }

  console.log('\n数据库已重置完成。下次启动服务时将按最新表结构自动重建。')
  return 0
}

/**
 * 判断当前脚本是否由 Node 直接执行，而不是被测试导入。
 * @returns {boolean} 当前模块为进程入口时返回 true。
 * @throws 不抛出异常。
 */
function isMainModule () {
  return Boolean(
    process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]),
  )
}

if (isMainModule()) {
  try {
    const exitCode = await resetDevDatabase({ yes: process.argv.includes('--yes') })
    process.exitCode = exitCode
  } catch (error) {
    console.error(`数据库重置失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
