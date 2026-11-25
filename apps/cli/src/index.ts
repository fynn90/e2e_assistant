#!/usr/bin/env node
import { cac } from 'cac'
import {
  handleStartCommand,
  type IStartCommandOptions,
} from './commands/start-command'
import { getDefaultCliPort } from './infrastructure/network/port'
import {
  reportCliCommandError,
  runCommandWithEnvironmentCheck,
} from './commands/shared/run-command-with-environment-check'
import { handleLogCommand, type ILogCommandOptions } from './commands/log-command'
import { handleStopCommand } from './commands/stop-command'
import { handleStatusCommand } from './commands/status-command'
import { handleTuiCommand } from './commands/tui-command'
import { handleWebCommand } from './commands/web-command'

const cli = cac('e2e_assistant')

const FOREGROUND_OPTION_DESCRIPTION =
  'Run the service in the foreground (log to this terminal)'

cli
  .command('web', 'Start the local Authine E2E Agent Platform workbench')
  .option('-p, --port <port>', 'Specify local server port', {
    default: getDefaultCliPort(),
  })
  .option('--strict-port', 'Fail when the requested CLI port is occupied')
  .option('-f, --foreground', FOREGROUND_OPTION_DESCRIPTION)
  .option('--no-open', 'Do not open browser automatically')
  .action(async (options: IStartCommandOptions) => {
    await runCommandWithEnvironmentCheck({
      commandAction: () => handleWebCommand(options),
    })
  })

cli
  .command(
    'start',
    'Start the local Authine E2E Agent Platform service in the background',
  )
  .option('-p, --port <port>', 'Specify local server port', {
    default: getDefaultCliPort(),
  })
  .option('--strict-port', 'Fail when the requested CLI port is occupied')
  .option('-f, --foreground', FOREGROUND_OPTION_DESCRIPTION)
  .option('--no-open', 'Do not open browser automatically')
  .action(async (options: IStartCommandOptions) => {
    await runCommandWithEnvironmentCheck({
      commandAction: () => handleStartCommand(options),
    })
  })

cli
  .command('log', 'Show logs of the background service')
  .alias('logs')
  .option('-n, --lines <lines>', 'Number of lines to show', {
    default: '100',
  })
  .option('-f, --follow', 'Follow log output')
  .action(async (options: ILogCommandOptions) => {
    await runCommandWithEnvironmentCheck({
      commandAction: () => handleLogCommand(options),
    })
  })

cli
  .command('stop', 'Stop the local Authine E2E Agent Platform service')
  .action(async () => {
    await runCommandWithEnvironmentCheck({
      commandAction: () => handleStopCommand(),
    })
  })

cli
  .command('status', 'Show the running state of the local service')
  .action(async () => {
    await runCommandWithEnvironmentCheck({
      commandAction: () => handleStatusCommand(),
    })
  })

cli
  .command('authine-tui', 'Start terminal interactive interface')
  .action(async () => {
    await runCommandWithEnvironmentCheck({
      commandAction: () => handleTuiCommand(),
    })
  })

/**
 * 注册进程级错误处理，兜底打印未捕获异常和未处理 Promise 拒绝。
 * @returns 注册完成后无返回值。
 * @throws 不抛出异常，异常会交给统一命令错误处理器。
 */
function registerCliProcessErrorHandlers (): void {
  process.on('unhandledRejection', (error) => {
    reportCliCommandError(error)
    process.exitCode = 1
  })

  process.on('uncaughtException', (error) => {
    reportCliCommandError(error)
    process.exitCode = 1
  })
}

/**
 * 装配并启动 CLI 命令行入口。
 * @returns 启动完成后无返回值。
 * @throws 不抛出异常，命令执行错误由包装器处理。
 */
async function bootstrapCli (): Promise<void> {
  registerCliProcessErrorHandlers()
  cli.help()
  cli.parse()
}

await bootstrapCli()
