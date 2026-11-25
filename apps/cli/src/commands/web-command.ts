import { handleStartCommand, type IStartCommandOptions } from './start-command'

/**
 * 处理 `e2e_assistant web` 命令，复用已有工作台启动流程。
 * @param options web 命令参数。
 * @returns 处理完成后无返回值。
 */
export async function handleWebCommand (
  options: IStartCommandOptions,
): Promise<void> {
  await handleStartCommand(options)
}
