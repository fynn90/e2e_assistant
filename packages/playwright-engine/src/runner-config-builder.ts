/** 生成测试执行子进程使用的 playwright.config.cjs 文本，供执行器（runner）与单元测试复用。 */

import type { ITestRunRequest } from './runner'
import { PLATFORM_BROWSER_ENV } from './contracts/browser-env'

/** 结构化事件文件的固定文件名（由 reporter.cjs 写入）。 */
export const EVENTS_FILE_NAME = 'events.ndjson'

/** Playwright JSON 报告的固定文件名（由内置 json reporter 写入）。 */
export const JSON_REPORT_FILE_NAME = 'report.json'

/**
 * 把绝对路径归一为 POSIX 分隔符，供 `snapshotPathTemplate` 使用。
 *
 * Windows 的反斜杠在 Playwright 的路径模板里不安全（模板本身用 `/` 作分隔符），
 * 必须显式转换，否则基线会落到意外位置。
 *
 * @param absolutePath - 绝对路径。
 * @returns 以 `/` 分隔的路径。
 * @throws 不抛出异常。
 */
function toPosixPath(absolutePath: string): string {
  return absolutePath.split('\\').join('/')
}

/**
 * 生成 playwright.config.cjs 内容（技术方案 §3.3 / v12 §5.1）。
 *
 * use.locale 必须显式写入：@playwright/test 的 locale fixture 默认硬编码为
 * "en-US"（playwright/lib/index.js：`contextOptions.locale ?? "en-US"`），
 * 不设置会导致执行阶段页面语言与生成探查阶段（PLATFORM_BROWSER_ENV）
 * 不一致，界面文本定位器（如 getByPlaceholder）失效。
 *
 * v12 追加两项视觉基线配置（均为**配置顶层**字段，写进 `use` 内会静默失效）：
 *
 *   - `snapshotPathTemplate`：指向 Skill 的视觉快照根（v14 B11：`<skillRoot>/userWorkSpace`），
 *     使 `toMatchSnapshot` 的基线落在工作区**之外**的指定目录（技术方案 §2.5 实测：
 *     可指向工作区外绝对路径，且单独配置即可同时覆盖 `toHaveScreenshot` 与
 *     `toMatchSnapshot`）；脚本内 `toMatchSnapshot(['baselines', 'x.png'])` 的分段在该根
 *     下解析（默认目录对应 `userWorkSpace/baselines/<基准图片>.png`）。
 *     宿主未提供快照根时**不写入**——此时脚本会因找不到基线而明确失败，
 *     而不是静默写到工作区默认目录，造成「比对通过了但比对的是错文件」的隐性错误。
 *
 *   - `updateSnapshots: 'none'`：**恒写入**。它是「执行期不误写基线目录」的唯一可靠手段
 *     （技术方案 §2.6 实测：默认与 `'missing'` 都会在基线缺失时写盘，写出垃圾文件）。
 *     该字段只收紧行为、无副作用，因此无条件生效。
 *
 * @param request - 一次测试执行的请求，提供 baseURL、超时与可选的视觉快照根。
 * @returns 完整的 CommonJS 配置文件文本。
 * @throws 不抛出异常；非法超时由调用方在请求构造期校验。
 */
export function buildConfigContent(request: ITestRunRequest): string {
  const snapshotRoot = request.snapshotRoot?.trim()
  const snapshotPathLine = snapshotRoot
    ? `  snapshotPathTemplate: ${JSON.stringify(`${toPosixPath(snapshotRoot)}/{arg}{ext}`)},\n`
    : ''

  return `// 由执行器自动生成的配置：固定有头模式、单 worker、平台超时与统一 locale 默认值（PRD X2/X11）。
module.exports = {
  testDir: __dirname,
  testMatch: 'test.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: ${Math.max(1, Math.floor(request.timeouts.testMs))},
  globalTimeout: ${Math.max(1, Math.floor(request.timeouts.overallMs))},
  expect: { timeout: 15000 },
  // v12：视觉基线绝不写入磁盘（基线缺失时直接失败，由「重新捕获」刷新）。
  updateSnapshots: 'none',
${snapshotPathLine}  reporter: [
    ['list'],
    [String(__dirname + '/reporter.cjs'), { outputFile: ${JSON.stringify(EVENTS_FILE_NAME)} }],
    ['json', { outputFile: ${JSON.stringify(JSON_REPORT_FILE_NAME)} }],
  ],
  use: {
    headless: false,
    baseURL: ${JSON.stringify(request.baseUrl)},
    locale: ${JSON.stringify(PLATFORM_BROWSER_ENV.locale)},
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
}
`
}
