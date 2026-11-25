/**
 * 处理 `authine-tui` 命令，负责启动终端交互界面。
 * @returns 处理完成后无返回值。
 */
export async function handleTuiCommand(): Promise<void> {
  const { startTerminalUi } =
    await import('../presentation/tui/start-terminal-ui')

  startTerminalUi()
}
