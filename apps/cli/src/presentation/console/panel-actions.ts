/**
 * 面板命令提示的共享定义。
 *
 * 同一个命令会出现在多个面板上（`stop` 在 start / status / log 都有），若各面板
 * 自己拼一份，文案必然漂移——实测就出现过 `跟随查看日志` 与 `实时查看服务日志`
 * 两种说法并存。因此收敛到这里：命令与它的作用说明只定义一次，各面板按需引用。
 *
 * 每个面板**不该提示自己**：刚跑完 `status` 的面板再提示 `e2e_assistant status` 是
 * 冗余，用户刚刚才敲过。
 */
import type { IPanelAction } from './panel-renderer'

/** 跟随查看日志。 */
export function createLogFollowAction (): IPanelAction {
  return { icon: '👀', command: 'e2e_assistant log -f', hint: '实时查看服务日志' }
}

/** 查看服务运行状态。 */
export function createStatusAction (): IPanelAction {
  return { icon: '🔍', command: 'e2e_assistant status', hint: '查看服务运行状态' }
}

/** 停止服务。 */
export function createStopAction (): IPanelAction {
  return { icon: '🛑', command: 'e2e_assistant stop', hint: '停止服务' }
}

/** 后台启动服务。 */
export function createStartAction (): IPanelAction {
  return { icon: '🚀', command: 'e2e_assistant start', hint: '启动后台服务' }
}

/** 前台启动服务（日志刷在当前终端，不落盘）。 */
export function createForegroundStartAction (): IPanelAction {
  return {
    icon: '🖥️',
    command: 'e2e_assistant start --foreground',
    hint: '前台运行（不写日志文件）',
  }
}
