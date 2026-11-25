import {
  Input,
  ProcessTerminal,
  TUI,
  Text,
  matchesKey,
} from '@earendil-works/pi-tui'

export interface IStartTerminalUiOptions {
  title?: string
}

/**
 * 启动终端交互式界面。
 * @param options 终端界面初始化参数。
 * @returns 启动完成后无返回值。
 */
export function startTerminalUi(options: IStartTerminalUiOptions = {}): void {
  const terminal = new ProcessTerminal()
  const tui = new TUI(terminal)
  const title = options.title ?? 'Authine E2E Agent Platform'
  const input = new Input()

  tui.addChild(new Text(title))
  tui.addChild(new Text('输入 /help 查看命令，按 Ctrl+C 退出。'))

  input.onSubmit = (value: string) => {
    const temp_commandText = value.trim()

    if (temp_commandText === '/help') {
      tui.addChild(new Text('可用命令：/help, /record, /run, /skills, /exit'))
    } else if (temp_commandText === '/exit') {
      tui.stop()
      process.exit(0)
    } else if (temp_commandText.length > 0) {
      tui.addChild(new Text(`收到命令：${temp_commandText}`))
    }

    input.setValue('')
    tui.requestRender()
  }

  tui.addChild(input)
  tui.setFocus(input)

  tui.addInputListener((data: string) => {
    if (matchesKey(data, 'ctrl+c')) {
      tui.stop()
      process.exit(0)
    }

    return undefined
  })

  tui.start()
}
