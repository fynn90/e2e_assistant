/**
 * Windows 专用：以「隐藏控制台」方式派生子进程（v21）。
 *
 * 背景：Node 的 spawn 只有「无控制台」（detached / windowsHide）与「继承父控制台」
 * 两档，没有「隐藏控制台」。后台 CLI 服务因此没有控制台，而 Windows 会给每一个
 * 控制台子系统子进程（node 测试进程、chrome-headless-shell 等）新建一个可见黑窗
 * ——「执行测试用例时弹黑窗」的根因。
 *
 * 这里借助 Windows 自带的 wscript.exe 执行一段静态 VBS：
 *   - `WScript.Shell.Run(cmd, 0, True)` 为目标进程创建**隐藏的**控制台，整条后代链
 *     都继承它，控制台黑窗从根上消失；
 *   - `True`（等待结束）让 wscript 陪跑到命令退出，保留调用方「子进程先退出 =
 *     启动失败」的既有判据；
 *   - VBS 内的 cmd 重定向把子进程 stdout/stderr **追加**写回日志文件——实测
 *     Run 不继承父进程 stdio，必须显式重定向，否则日志文件为空；
 *   - 脚本以子进程退出码退出，失败原因不被吞掉。
 *
 * 该模块只应在 Windows 分支调用；其他平台保持直接派生进程。
 */
import path from 'node:path'
import { getAuthineConfigDirectory } from '../config/config-path'
import { atomicWriteSecureFile } from '../config/secure-file'

/** 隐藏控制台启动脚本（VBS）的文件名，存放在用户级配置目录下。 */
const HIDDEN_LAUNCH_SCRIPT_FILE_NAME = 'hidden-launch.vbs'

/** Windows 自带的脚本宿主；GUI 子系统，自身不会创建控制台窗口。 */
const HIDDEN_LAUNCH_EXECUTABLE = 'wscript.exe'

/**
 * 取隐藏控制台启动脚本的绝对路径。
 *
 * @returns `<配置目录>/hidden-launch.vbs` 的绝对路径。
 * @throws 不抛出异常。
 */
export function getHiddenLaunchScriptPath (): string {
  return path.join(getAuthineConfigDirectory(), HIDDEN_LAUNCH_SCRIPT_FILE_NAME)
}

/**
 * 构造隐藏控制台启动脚本（VBS）源码。
 *
 * 参数约定：`WScript.Arguments(0)` 是日志文件路径，其余是「可执行文件 + 参数」。
 * 参数逐个加引号并转义内部引号；命令与日志重定向整体再包一层引号，
 * 由 cmd 剥掉外层、保留内层引号与重定向。
 *
 * @returns VBS 源码文本。
 * @throws 不抛出异常。
 */
export function buildHiddenLaunchScript (): string {
  return [
    "' 由 e2e_assistant CLI 自动生成：以「隐藏控制台」运行命令，并把输出追加重定向到日志文件。",
    "' 参数约定：WScript.Arguments(0) = 日志文件路径；其余为「可执行文件 + 参数」。",
    'Option Explicit',
    '',
    'Dim shell, logPath, commandLine, index, inner, exitCode',
    '',
    'If WScript.Arguments.Count < 2 Then',
    '  WScript.Quit 2',
    'End If',
    '',
    'Set shell = CreateObject("WScript.Shell")',
    'logPath = WScript.Arguments(0)',
    'commandLine = ""',
    'For index = 1 To WScript.Arguments.Count - 1',
    '  commandLine = commandLine & QuoteArgument(WScript.Arguments(index)) & " "',
    'Next',
    '',
    "' 外层再加一对引号：cmd /c 会剥掉它，内层引号与重定向原样保留。",
    'inner = commandLine & ">> " & QuoteArgument(logPath) & " 2>&1"',
    'exitCode = shell.Run("cmd.exe /d /s /c " & """" & inner & """", 0, True)',
    'WScript.Quit exitCode',
    '',
    "' 参数加引号并转义内部引号（Windows 命令行解析规则）。",
    'Function QuoteArgument(value)',
    '  QuoteArgument = """" & Replace(value, """", """""") & """"',
    'End Function',
    '',
  ].join('\r\n')
}

/** 隐藏控制台启动所需的可执行文件与参数。 */
export interface IHiddenLaunchInvocation {
  /** 启动器可执行文件（wscript.exe）。 */
  command: string
  /** 参数：脚本路径、日志路径、可执行文件、该可执行文件的参数。 */
  args: string[]
}

/**
 * 构造一次隐藏控制台启动的「可执行文件 + 参数」。
 *
 * @param options - 脚本路径、日志路径、待运行命令及其参数。
 * @returns wscript 启动调用；参数顺序即 VBS 的参数约定。
 * @throws 不抛出异常。
 */
export function buildHiddenLaunchInvocation (options: {
  scriptPath: string
  logPath: string
  command: string
  args: readonly string[]
}): IHiddenLaunchInvocation {
  return {
    command: HIDDEN_LAUNCH_EXECUTABLE,
    args: [
      options.scriptPath,
      options.logPath,
      options.command,
      ...options.args,
    ],
  }
}

/**
 * 确保隐藏控制台启动脚本存在且内容最新。
 *
 * 每次启动前重写：脚本是纯静态文本、体积极小，重写比比对更简单，也不会出现
 * 旧版本脚本残留导致行为不一致的情况。文件权限沿用配置目录的安全策略。
 *
 * @returns 脚本写入完成时兑现。
 * @throws 配置目录不可写或写入失败时抛出底层异常。
 */
export async function ensureHiddenLaunchScript (): Promise<void> {
  await atomicWriteSecureFile(
    getHiddenLaunchScriptPath(),
    buildHiddenLaunchScript(),
  )
}
