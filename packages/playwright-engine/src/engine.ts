/** 组装 Playwright Engine 的默认能力，提供不绑定宿主业务的统一 SDK 门面。 */

import type { IBrowserSessionFactory } from './contracts/browser'
import type { IChromiumInstaller } from './contracts/chromium'
import type {
  IDryRunRequest,
  IDryRunResult,
  IDryRunRunner,
} from './contracts/dry-run'
import { PlaywrightEngineError } from './contracts/errors'
import type { IPlaywrightScriptValidator } from './contracts/validation'
import { PlaywrightBrowserSessionFactory } from './browser-session/browser-session-factory'
import { ChromiumInstaller } from './chromium-installer/chromium-installer'
import { PlaywrightScriptValidator } from './validation/playwright-script-validator'
import { createPlaywrightTestRunner, type ITestRunner } from './runner'

/**
 * Engine 统一门面暴露的独立能力。
 */
export interface IPlaywrightEngine {
  chromium: IChromiumInstaller
  browser: IBrowserSessionFactory
  dryRun: IDryRunRunner
  validator: IPlaywrightScriptValidator
  /** 真实测试执行器（v11）：子进程运行 playwright test CLI。 */
  testRunner: ITestRunner
}

/**
 * 创建 Engine 时可替换的默认实现。
 */
export interface IPlaywrightEngineOptions {
  chromium?: IChromiumInstaller
  browser?: IBrowserSessionFactory
  dryRun?: IDryRunRunner
  validator?: IPlaywrightScriptValidator
  /** 测试执行器；缺省为基于 playwright CLI 的子进程实现。 */
  testRunner?: ITestRunner
}

/**
 * 阶段 2 dry-run 尚未启用时的显式占位实现。
 */
class UnsupportedDryRunRunner implements IDryRunRunner {
  /**
   * 明确拒绝在阶段 2 之前执行候选脚本，避免占位能力伪装成成功。
   *
   * @param _request - 预留的受控试运行请求。
   * @returns 不返回成功结果。
   * @throws 始终抛出 DRY_RUN_FAILED，告知宿主当前版本未提供实现。
   */
  async run(_request: IDryRunRequest): Promise<IDryRunResult> {
    throw new PlaywrightEngineError(
      'DRY_RUN_FAILED',
      '受控试运行尚未在当前 Engine 阶段启用。',
      {
        component: 'dry-run',
        retryable: false,
        reason: 'phase-2-not-implemented',
      },
    )
  }
}

/**
 * 创建默认 Playwright Engine 门面。
 *
 * 工厂只组装对象，不自动启动浏览器、不安装 Chromium，也不执行候选脚本。
 *
 * @param options - 可选的能力替换实现。
 * @returns 包含 Chromium、浏览器、dry-run 契约和静态校验器的 Engine。
 * @throws 不抛出异常；实际副作用由调用方显式调用能力方法时产生。
 */
export function createPlaywrightEngine(
  options: IPlaywrightEngineOptions = {},
): IPlaywrightEngine {
  return {
    chromium: options.chromium ?? new ChromiumInstaller(),
    browser: options.browser ?? new PlaywrightBrowserSessionFactory(),
    dryRun: options.dryRun ?? new UnsupportedDryRunRunner(),
    validator: options.validator ?? new PlaywrightScriptValidator(),
    testRunner: options.testRunner ?? createPlaywrightTestRunner(),
  }
}

/**
 * 返回当前默认门面明确支持的能力状态。
 *
 * @returns 当前阶段能力状态；dryRun 为 false 表示需由宿主注入阶段 2 实现。
 * @throws 不抛出异常。
 */
export function getPlaywrightEngineCapabilities(): {
  chromium: true
  browser: true
  validator: true
  dryRun: false
  testRunner: true
} {
  return {
    chromium: true,
    browser: true,
    validator: true,
    dryRun: false,
    testRunner: true,
  }
}
