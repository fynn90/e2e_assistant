/**
 * 服务运行形态的环境变量约定。
 *
 * 后台启动器派生子进程时设置标记，服务进程读它、把形态记进运行态记录——
 * 这是服务进程唯一需要知道的「我是不是后台」（见 v19 技术方案 §3.2）。
 *
 * 为什么用环境变量而不是隐藏选项：`cac` 的选项会出现在 `--help` 里，
 * 而这是纯内部约定；环境变量在 dev（tsx）与生产（dist）下行为一致，且易测试。
 */

/** 后台服务子进程的环境变量标记；由启动器设置，服务进程读取。 */
export const SERVICE_MODE_ENV_VAR = 'AUTHINE_SERVICE_MODE'

export type TServiceMode = 'foreground' | 'background'

/**
 * 从环境变量读取服务运行形态。
 *
 * 只有显式标记为 `background` 才算后台；其余（未设置、取值意外）都按前台处理——
 * 前台是「今天的行为」，误判到这一侧不会让服务意外脱离终端。
 *
 * @param env - 环境变量表；缺省读取当前进程的环境。
 * @returns 运行形态。
 * @throws 不抛出异常。
 */
export function readServiceModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TServiceMode {
  return env[SERVICE_MODE_ENV_VAR] === 'background' ? 'background' : 'foreground'
}
