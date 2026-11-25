/**
 * bash 可执行文件探测：CLI 启动时定位 bash.exe 并记录路径。
 *
 * Windows 上 pi-agent-core 的 NodeExecutionEnv 缺省只按固定位置探测 bash
 * （Program Files 下的 Git Bash 或 PATH），探测不到会导致 Agent 的 bash
 * 工具不可用（工具调用直接返回 shell_unavailable 错误）。本模块在服务启动
 * 阶段按更强的候选顺序主动探测一次，把结果交给调用方，并由组合根作为
 * shellPath 显式传入 agent 包，避免运行时探测失败。
 *
 * Windows 探测顺序（与 pi-agent-core 兼容，命中面更大）：
 *   1. Program Files 下的 Git Bash 固定位置；
 *   2. 注册表 GitForWindows 的 InstallPath（Git for Windows 安装器写入，
 *      覆盖自定义安装盘符的场景）；
 *   3. PATH 上的 git.exe 位置反推 Git 安装根（覆盖便携版/未写注册表的场景）；
 *   4. PATH 上的 bash.exe（pi-agent-core 的缺省兜底途径）。
 *
 * 探测失败不阻断启动：bash 之外的文件读写、页面核对等功能不受影响，
 * 仅 bash 工具在运行期返回不可用错误。
 *
 * **本模块不打印任何内容**：它返回结构化的探测结果，由 presentation 层决定
 * 怎么呈现。原因有二——一是分层（终端文案属于展示职责），二是后台模式下
 * 子进程的 stdout 会写进日志文件，在那里打印的提示既不在用户眼前、又混进
 * 了服务日志，读者并不知道它是「本次启动的提示」还是「服务的输出」。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

/** bash 探测所需的环境信息（抽出结构便于纯函数测试）。 */
export interface IBashProbeEnvironment {
  /** 当前平台标识（process.platform）。 */
  platform: NodeJS.Platform
  /** Program Files 目录（process.env.ProgramFiles）。 */
  programFiles?: string
  /** Program Files (x86) 目录（process.env['ProgramFiles(x86)']）。 */
  programFilesX86?: string
}

/**
 * 收集 Windows 下的固定 bash 候选路径（与 pi-agent-core 的探测顺序一致）。
 *
 * @param env - 平台与 Program Files 环境变量。
 * @returns 候选 bash 绝对路径数组；非 Windows 平台返回空数组
 *   （NodeExecutionEnv 在非 Windows 下自行使用 /bin/bash，无需显式指定）。
 * @throws 不抛出异常。
 */
export function collectFixedBashCandidates(
  env: IBashProbeEnvironment,
): string[] {
  if (env.platform !== 'win32') {
    return []
  }

  // 固定候选按优先级排列：64 位与 32 位 Program Files 下的 Git Bash。
  const candidates: string[] = []
  if (env.programFiles) {
    candidates.push(join(env.programFiles, 'Git', 'bin', 'bash.exe'))
  }
  if (env.programFilesX86) {
    candidates.push(join(env.programFilesX86, 'Git', 'bin', 'bash.exe'))
  }
  return candidates
}

/**
 * 由 Git 安装根目录推导 bash 候选路径。
 *
 * @param gitRoot - Git 安装根目录（如 D:\soft\Git）；空值/空白视为未知。
 * @returns 依次包含 usr\bin\bash.exe 与 bin\bash.exe 的候选数组；
 *   无法推导时返回空数组。
 * @throws 不抛出异常。
 */
export function bashCandidatesFromGitRoot(
  gitRoot: string | undefined,
): string[] {
  if (!gitRoot || gitRoot.trim().length === 0) {
    return []
  }

  // 统一为反斜杠并去掉尾部斜杠，避免拼接出 `D:\soft\Git\\bin` 形态。
  const normalizedRoot = gitRoot.replace(/\//g, '\\').replace(/[\\]+$/, '')
  return [
    join(normalizedRoot, 'usr', 'bin', 'bash.exe'),
    join(normalizedRoot, 'bin', 'bash.exe'),
  ]
}

/**
 * 从 git.exe 的绝对路径反推 Git 安装根目录。
 *
 * 识别 Git for Windows 的常见安装形态：`<root>\cmd\git.exe`（PATH wrapper）、
 * `<root>\mingw64\bin\git.exe` / `<root>\mingw32\bin\git.exe`（Git Bash 内部
 * PATH）与 `<root>\bin\git.exe`。
 *
 * @param gitExePath - git.exe 的绝对路径（正斜杠会归一为反斜杠）。
 * @returns Git 安装根目录；形态无法识别时返回 undefined。
 * @throws 不抛出异常。
 */
export function gitRootFromGitExePath(gitExePath: string): string | undefined {
  const normalizedPath = gitExePath.replace(/\//g, '\\')
  // Windows 路径大小写不敏感，按小写匹配形态后缀。
  const normalized = normalizedPath.toLowerCase()
  const knownSuffixes = [
    '\\cmd\\git.exe',
    '\\mingw64\\bin\\git.exe',
    '\\mingw32\\bin\\git.exe',
    '\\bin\\git.exe',
  ]
  const matchedSuffix = knownSuffixes.find((suffix) =>
    normalized.endsWith(suffix),
  )
  if (!matchedSuffix) {
    return undefined
  }
  return normalizedPath.slice(0, normalizedPath.length - matchedSuffix.length)
}

/**
 * 把一批 git.exe 位置批量转换为去重后的 bash 候选路径。
 *
 * @param gitExePaths - PATH 上找到的 git.exe 路径列表（按命中顺序）。
 * @returns bash 候选路径数组（保持优先级顺序、去除重复）。
 * @throws 不抛出异常。
 */
export function collectGitDerivedBashCandidates(
  gitExePaths: readonly string[],
): string[] {
  const candidates: string[] = []
  for (const gitExePath of gitExePaths) {
    const gitRoot = gitRootFromGitExePath(gitExePath)
    if (!gitRoot) {
      continue
    }
    for (const candidate of bashCandidatesFromGitRoot(gitRoot)) {
      if (!candidates.includes(candidate)) {
        candidates.push(candidate)
      }
    }
  }
  return candidates
}

/**
 * 解析 where 命令的输出，按行拆分为候选路径（保留原始顺序）。
 *
 * @param stdout - where 命令的标准输出文本。
 * @returns 去除首尾空白后的非空路径数组；空输出返回空数组。
 * @throws 不抛出异常。
 */
export function parseWhereOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * bash 探测结果。
 *
 * 三态而不是「路径或 undefined」：调用方需要区分「非 Windows 无需探测」
 * 与「Windows 上没找到」——前者不该给用户任何提示，后者需要给修复指引。
 */
export type TBashShellProbe =
  | { outcome: 'not-applicable' }
  | { outcome: 'found'; path: string }
  | { outcome: 'missing' }

/**
 * 探测 bash 可执行文件（服务启动阶段调用一次）。
 *
 * 探测顺序见文件头说明：固定位置 → 注册表 InstallPath → git.exe 反推 →
 * PATH 上的 bash.exe。探测结果由组合根作为 shellPath 显式传入 agent 包。
 *
 * 只返回结果、不打印：怎么呈现是 presentation 层的职责，且后台模式下子进程
 * 的 stdout 会写进日志文件——在那里打印的提示既不在用户眼前、又会混进服务日志。
 *
 * @returns 探测结果（非 Windows / 命中 / 未命中三态）。
 * @throws 不抛出异常；注册表 / where 命令执行失败按未探测到处理。
 */
export function probeBashShell(): TBashShellProbe {
  const env: IBashProbeEnvironment = {
    platform: process.platform,
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env['ProgramFiles(x86)'],
  }

  // 非 Windows 平台：NodeExecutionEnv 自行使用 /bin/bash，无需显式指定。
  if (env.platform !== 'win32') {
    return { outcome: 'not-applicable' }
  }

  const bashPath = firstExistingPath([
    ...collectFixedBashCandidates(env),
    ...bashCandidatesFromGitRoot(queryRegistryGitInstallPath()),
    ...collectGitDerivedBashCandidates(parseWhereOutput(queryGitOnPath())),
    ...parseWhereOutput(queryBashOnPath()),
  ])

  return bashPath
    ? { outcome: 'found', path: bashPath }
    : { outcome: 'missing' }
}

/**
 * 探测 bash 并直接返回其路径（供组合根装配的兼容入口）。
 *
 * @returns 探测到的 bash 绝对路径；未探测到或非 Windows 平台返回 undefined。
 * @throws 不抛出异常。
 */
export function resolveBashShellPath(): string | undefined {
  const probe = probeBashShell()

  return probe.outcome === 'found' ? probe.path : undefined
}

/**
 * 在候选路径中返回第一个真实存在的文件。
 *
 * @param candidates - 按优先级排列的候选 bash 路径。
 * @returns 第一个存在的路径；都不存在返回 undefined。
 */
function firstExistingPath(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate))
}

/**
 * 从注册表读取 Git for Windows 的安装目录（InstallPath）。
 *
 * 依次查询 HKLM 与 HKCU 的 SOFTWARE\GitForWindows 键，覆盖机器级与
 * 用户级安装；便携版通常未写注册表，此时返回 undefined 走其他途径。
 *
 * @returns 安装根目录；注册表不可用或未写入时返回 undefined。
 */
function queryRegistryGitInstallPath(): string | undefined {
  for (const hive of ['HKLM', 'HKCU'] as const) {
    try {
      const result = spawnSync(
        'reg',
        ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'],
        { windowsHide: true, encoding: 'utf8' },
      )
      if (result.status !== 0 || typeof result.stdout !== 'string') {
        continue
      }
      // 成功输出的值行形如 "    InstallPath    REG_SZ    D:\soft\Git"，
      // 只取 REG_SZ 之后的路径（错误信息为本地化文本，不参与解析）。
      const match = result.stdout.match(/REG_SZ\s+(.+)/)
      const installPath = match?.[1]?.trim()
      if (installPath) {
        return installPath
      }
    } catch {
      // reg 命令不存在或查询失败：跳过该途径。
    }
  }
  return undefined
}

/**
 * 通过 where 命令查询 PATH 上的 git.exe。
 *
 * @returns where 的标准输出；执行失败（命令不存在或未找到）返回空串。
 */
function queryGitOnPath(): string {
  try {
    const result = spawnSync('where', ['git.exe'], {
      windowsHide: true,
      encoding: 'utf8',
    })
    return result.status === 0 && typeof result.stdout === 'string'
      ? result.stdout
      : ''
  } catch {
    return ''
  }
}

/**
 * 通过 where 命令查询 PATH 上的 bash.exe。
 *
 * @returns where 的标准输出；执行失败（命令不存在或未找到）返回空串。
 */
function queryBashOnPath(): string {
  try {
    const result = spawnSync('where', ['bash.exe'], {
      windowsHide: true,
      encoding: 'utf8',
    })
    return result.status === 0 && typeof result.stdout === 'string'
      ? result.stdout
      : ''
  } catch {
    return ''
  }
}
