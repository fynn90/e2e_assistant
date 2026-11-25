<!-- 本文档面向首次接触本包的开发者，介绍 SDK 的用途、能力、边界、安装方式和开发入口。 -->

# `@authine-e2e-agent/playwright-engine`

一个独立、可复用、默认安全的 Playwright 能力 SDK，为 Node.js 应用提供浏览器会话、Chromium 管理、页面核对、候选脚本静态校验和受控试运行能力。

> 本包负责“安全地驱动和验证浏览器及 Playwright 脚本”；Agent、业务流程和 UI 由宿主应用负责。

- [在线阅读版架构设计](./ARCHITECTURE.html)
- [Markdown 架构设计](./ARCHITECTURE.md)
- [Version 7 PRD](../../PRD/v7.md)
- [Version 7 技术方案](../../PRD/v7-technical-design.md)

## 1. 这个包解决什么问题？

在自动生成 Playwright 脚本的场景中，直接执行模型或用户提交的代码存在几个问题：

- 本机可能没有 Playwright Chromium；
- 生成器需要访问真实页面并核对元素；
- 候选脚本可能包含危险 API、越权导入或错误的环境变量；
- 未经审阅的代码不应直接覆盖正式测试文件；
- 试运行需要限制网络、文件、环境变量、超时和进程生命周期；
- 浏览器、子进程和临时文件必须在取消或异常时可靠释放。

Playwright Engine 将这些**确定性、与业务无关的基础能力**封装为可组合 SDK。在当前平台中，它被两个包调用：

- `@authine-e2e-agent/agent`：通过注入的浏览器会话端口使用页面能力，为生成 Agent 提供 `browser_navigate`、`browser_snapshot`、`browser_query` 与 `browser_click`、`browser_select`、`browser_fill`、`browser_waitFor`、`browser_screenshot` 工具（页面元素核对与视觉确认）。其中 `browser_fill` 支持 `${ENV:KEY}` 凭据引用（v20 凭据代理）：引擎经宿主注入的 `ICredentialResolver` 在填入前换取真值，并立即登记进会话脱敏器（`ISecretRegistrableRedactor`），使填入后的快照与元素查询都无法回读该值。同时使用静态校验完成候选脚本的质量门禁。
- `@authine-e2e-agent/cli`：在生成任务开始前完成 Chromium 检测与自动安装（就绪检查），并按 `browserVisualization` 以有头或无头模式创建浏览器会话、注入给生成 Agent，任务终态负责释放。

它也可以被其他 CLI、桌面应用、CI 工具或不同的 Agent 框架单独使用。

## 2. 主要能力

| 能力                           | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium 检测与安装            | 检查 Playwright 浏览器是否可执行；缺失时使用包内依赖完成 Chromium 安装，不依赖全局 `playwright` 命令                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 浏览器会话                     | 创建有头或无头会话，执行受控导航、页面快照、元素查询、**元素点击 / 下拉选择 / 条件等待 / 页面与元素截图 / 完整内容截图**和关闭；context 显式注入 `PLATFORM_BROWSER_ENV.locale`（默认 `zh-CN`），保证页面语言与执行阶段一致                                                                                                                                                                                                                                                                                           |
| 完整内容截图（v12）            | `screenshotFullContent()` 截取元素**内部滚动区域**的完整内容：临时展开样式（`overflow:visible` + 尺寸置为 `scrollWidth/scrollHeight`）后截图，并在 `finally` 中还原。附带「连续两次截图字节一致」的稳定性捕获                                                                                                                                                                                                                                                                                                        |
| 网络访问策略                   | 限制主动文档导航到 `baseUrl` 同源范围，按策略放行页面必要子资源                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 脚本静态校验                   | 在执行前检查 TypeScript 语法、导入、安全 API、测试结构、步骤覆盖和环境变量                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 受控试运行                     | 在宿主提供的临时工作区运行候选脚本，支持环境变量白名单、超时、取消、进程树终止和结果脱敏                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 运行事件                       | 以与 SSE、WebSocket 和具体 UI 无关的事件契约输出浏览器、网络和试运行信息                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 真实测试执行（v11 TestRunner） | 以独立子进程运行 `playwright test` CLI（固定有头、单 worker），执行 Skill 根目录的 `test.spec.ts`：OS 临时运行工作区 + 脚本快照复制 + `@playwright/test` 工作区别名/`playwright` junction 解决依赖解析；自动生成的 `playwright.config.cjs` 显式写入统一 `use.locale`（`@playwright/test` 的 locale fixture 默认硬编码 `en-US`，不显式设置会导致执行页面语言与生成探查阶段不一致、文本定位器失效）；env 注入、超时（单条/总时长）、中止（进程树终止）、NDJSON 步骤事件、脱敏日志与 Playwright JSON 报告解析由宿主消费 |
| 测试报告渲染（v11）            | 把 Playwright JSON 报告 + 平台元数据渲染为自包含单文件 HTML（零脚本、内联 CSS），失败截图 base64 内嵌（单图 2MB 上限降级）；`analyzeTestScript` 提供脚本 test() 判定与 `process.env` 引用静态提取                                                                                                                                                                                                                                                                                                                    |
| 视觉比对结果展示（v12）        | 按附件名**后缀**识别视觉三件套（`-diff.png` 差异热点图 / `-expected.png` 基线 / `-actual.png` 实际，附件名带路径段前缀故不能用全名比较），差异热点图置顶高亮、基线与实际并排对照                                                                                                                                                                                                                                                                                                                                     |
| 格式化                         | 使用 TypeScript Printer 对候选 Playwright TypeScript 代码做确定性格式化                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 3. 明确不负责什么？

这个包不是完整的 E2E 产品，也不是 Agent 框架。它不负责：

- 调用大模型、理解自然语言、实现 Agent Loop 或自动修复策略；
- 读取或管理 `e2e_schema.json`、`SKILL.md` 和 Skill manifest；
- 提供 HTTP API、SSE、WebSocket、侧边栏 Chat 或前端状态；
- 管理正式 `test.spec.ts` 的版本冲突、确认保存和业务元数据；
- 决定试运行失败后是否重试或调用模型修复；
- 管理和维护正式测试报告与执行历史（查询、清理、版本、展示、上传）；报告与产物只按调用方指定的目录和规则一次性生成（v8 预留，见架构文档 6.9）；
- 分发 Chromium 二进制文件；
- 作为通用恶意代码沙箱。

宿主应用负责业务编排：什么时候访问页面、如何生成脚本、如何展示进度、何时清理 `temp/` 以及是否允许用户确认保存。

## 4. 当前实现状态

阶段 0 和阶段 1 已在本包内落地，并通过包内类型检查、静态校验测试、Chromium 安装器 fake 测试及网络策略测试：

- `src/contracts/`：独立的浏览器、Chromium、网络、校验、事件、错误、脱敏和 dry-run 契约；
- `src/chromium-installer/`：通过包内 `playwright/cli.js` 检测和安装 Chromium，支持进度、取消、超时、进程树终止和错误分类；
- `src/browser-session/`：有头/无头 Chromium 会话、同源导航、有界页面快照、候选定位器、元素查询、元素点击/下拉选择/条件等待/截图/完整内容截图和幂等关闭；
  - 截图不落盘：`screenshot()` 返回 base64 与尺寸（尺寸由 `png-dimensions.ts` 从 PNG 头部读取），持久化由宿主按自己的目录约定完成；
  - `full-content-capture.ts`（v12）：完整内容捕获的纯函数实现，与生成脚本的内联模板**必须同源**。
    两条实测结论是其存在理由——官方的 `toHaveScreenshot`/`locator.screenshot()` 对滚动容器
    **只截可视区**；CDP `captureBeyondViewport` 尺寸正确但视口外内容**未绘制**（拿到空白）；
  - 快照上限默认 240_000 字符（v12-pre 起，此前实为 8192——脱敏器的默认 maxLength 会先于快照切片生效）；
- `src/network-policy/`：主动导航同源限制、跨源文档阻断和可配置子资源例外；
- `src/observability/`：默认敏感信息脱敏器和统一事件契约；
- `src/validation/`：统一使用本包的 `IValidationTestCase`，不再依赖 `@authine-e2e-agent/types`；
- `src/validation/playwright-script-validator.ts`：统一编排校验器；
- `src/validation/playwright-structure-validator.ts`：校验 `test`、`page`、`expect`、`page.goto`、标题和定位器；
- `src/validation/step-coverage-validator.ts`：校验 `test.step(stepId)` 的步骤覆盖；
- `src/validation/environment-variable-validator.ts`：校验用例声明与 `process.env` 引用；
- `src/validation/forbidden-api-validator.ts`：阻断动态执行、命令执行、文件写入和进程控制；
- `src/validation/import-policy-validator.ts`：限制脚本导入模块；
- `src/validation/typescript-semantic-validator.ts`：执行内存 TypeScript 语义检查；
- `src/formatting/playwright-script-formatter.ts`：格式化安全候选代码。

仍属于后续阶段或扩展位的能力：

- dry-run runner（阶段 2 受控试运行）尚未实现；`runner.ts` 自 v11 起已是**真实测试执行器**（`ITestRunner`，子进程运行 `playwright test`），与 dry-run 语义不同、实现独立；
- `recorder.ts` 当前提供基础兼容示例，不是 v7 录制产品；
- `interceptor.ts` 当前保留基础运行事件工厂，宿主应使用 `IEngineEventSink` 接收统一 Engine 事件；
- Agent/CLI 编排、`browserVisualization` 字段解析、temp 生命周期和用户确认保存由宿主模块负责。

### 4.1 v11 TestRunner（真实执行）要点

- 运行工作区位于 `os.tmpdir()/e2e-agent-runs/<runId>/`：脚本以**复制**进入（执行内容即启动前一刻的磁盘快照），Skill 目录零写入；清理由调用方在任务终态调用 `result.workspace.cleanup()`（带 Windows 占用重试）；
- `@playwright/test` 解析：Skill 目录没有该依赖，工作区内合成与官方别名逐字一致的再导出包，并把 `playwright` 以 junction 链接到本包依赖树的真实安装——脚本 import 与运行的 CLI 严格同版本；
- 统一浏览器语言（v11.1）：自动生成的 `playwright.config.cjs` 由 `runner-config-builder.ts` 产出，`use.locale` 显式引用 `contracts/browser-env.ts` 的 `PLATFORM_BROWSER_ENV`（`zh-CN`）；生成链路的浏览器会话 context 注入同一常量。背景：`@playwright/test` 的 locale fixture 默认 `en-US`，直连 API 则跟随系统语言，两链路默认行为不对称；
- 视觉基线配置（v12）：`runner-config-builder.ts` 新增两项**配置顶层**字段（写进 `use` 内会静默失效）——
  `snapshotPathTemplate` 指向宿主传入的 `visualBaselineRoot`（缺省**不写入**，让脚本因找不到基线而
  明确失败，而不是静默写到工作区默认目录造成「比对的是错文件」）；
  `updateSnapshots: 'none'` **恒写入**，它是「执行期不误写基线目录」的唯一可靠手段
  （实测默认与 `'missing'` 都会在基线缺失时写盘并产出垃圾文件）；
- 报告与事件：NDJSON reporter（`events.ndjson`，100ms tail）产出 test/step 事件，内置 json reporter 产出 `report.json`；stdout/stderr 与错误消息经「把 env 值列为秘密」的脱敏器后回调；
- 中断归类：宿主中止信号或报告含 `interrupted` 状态测试 → 结果 `interrupted`（用户主动关闭浏览器窗口同语义）。

新人阅读代码时，请以“**已实现能力**”和“**目标架构**”区分，不要把 dry-run 或宿主编排文档中的未来接口当成当前已经可调用的 API。

## 5. 安装与依赖

### 5.1 在已发布环境中安装

```bash
pnpm add @authine-e2e-agent/playwright-engine
```

或：

```bash
npm install @authine-e2e-agent/playwright-engine
```

该包运行在 Node.js 环境，不是浏览器端 UI 包。使用 Chromium、试运行器或子进程能力时，应从服务端、CLI、桌面应用主进程或 CI 任务中调用。

### 5.2 当前仓库开发

```bash
pnpm install
pnpm --filter @authine-e2e-agent/playwright-engine build
pnpm --filter @authine-e2e-agent/playwright-engine test
pnpm --filter @authine-e2e-agent/playwright-engine typecheck
```

构建和测试脚本定义在 [package.json](./package.json)。

### 5.3 Chromium

Chromium 不随 SDK 源码或 npm 包直接分发。当前安装器会通过 SDK 自身安装的 `playwright` 依赖定位包内 CLI，完成等价于以下命令的安装效果：

```bash
playwright install chromium
```

用户不需要预先安装全局 `playwright` 命令。安装过程仍可能受网络、权限、磁盘空间和 Playwright 浏览器缓存目录影响。

**检测范围覆盖有头与无头两种模式。** Playwright 默认的无头模式使用独立的
`chromium_headless_shell` 下载项，与有头浏览器是不同的可执行文件。因此
`ChromiumDetector.detect()` 会同时校验两者：任一项缺失都报告 `installed: false`，
避免出现「检测通过但无头模式下启动失败」的假阳性。`playwright install chromium`
一次会装齐两者，无需额外命令。

**浏览器会话固定使用完整 Chromium（`channel: 'chromium'`），无头亦然。** 原因有二：
① `chrome-headless-shell.exe` 是控制台子系统程序，宿主进程没有控制台时（CLI 后台服务
的 detached 进程）会被 Windows 新建一个可见黑窗，而 Playwright 启动浏览器时不传
`windowsHide`、无法从调用侧关闭；② 完整浏览器的无头模式与有头模式（执行链路固定
有头）共用同一构建，减少生成与执行之间的渲染差异。

> 实现说明：`playwright` 包的 `exports` 不导出 `./cli.js`，安装器因此先解析包入口
> （`playwright/index.js`），再取同级目录下的 `cli.js`（官方 `bin` 脚本）交给 `node`
> 执行，等价官方 `playwright install chromium` 且不依赖全局 PATH；仅当该文件缺失时
> 才退回 `playwright/lib/program` 引导。
>
> 注意不要用 `node -e "...program.parse(process.argv)"`：`-e` 模式没有脚本路径位，
> Commander 会把第一个真实参数（`install`）当作脚本名丢掉，只剩 `chromium` 被当成
> 命令，稳定报 `error: unknown command 'chromium'` 且退出码 1，自动安装永远失败。

## 6. 最小使用示例：静态校验

当前可用的核心入口是脚本静态校验器：

```ts
import { PlaywrightScriptValidator } from '@authine-e2e-agent/playwright-engine'

const validator = new PlaywrightScriptValidator()
const result = validator.validate(candidateCode, {
  testCase: {
    title: '用户登录成功',
    baseUrl: 'https://example.test',
    steps: [{ id: 'step_login', order: 1, enabled: true }],
  },
})

if (!result.valid) {
  for (const issue of result.errors) {
    console.error(issue.code, issue.message)
  }
} else {
  // result.code 是经过确定性格式化的候选代码。
  console.log(result.code)
  console.log(result.warnings)
}
```

典型的合法候选脚本如下：

```ts
import { test, expect } from '@playwright/test'

test('用户登录成功', async ({ page }) => {
  await page.goto('https://example.test')

  await test.step('step_login', async () => {
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page).toHaveURL(/dashboard/)
  })
})
```

### 校验规则概览

- 必须从 `@playwright/test` 导入 `test` 和 `expect`；
- 必须存在 `test()`、`page` fixture、`page.goto()` 和 `expect()`；
- `page.goto()` 必须访问用例 `baseUrl` 或同源地址；
- 每个启用步骤应有且只有一个对应 `test.step('<step-id>')`；
- 每个步骤至少包含一个 Playwright 操作和一个断言；
- 只允许用例声明的环境变量（v10 起：用例侧 `${ENV:KEY}` 引用的提取正则下沉至
  `@authine-e2e-agent/types` 的 `collectEnvReferences` 统一维护，本包转发调用，
  Web 与 CLI 共用同一份规则；比对行为不变——缺失报错、多余报错）；
- 禁止 `eval`、`Function`、`child_process`、文件写入和进程控制等危险调用；
- XPath、深层 CSS、动态选择器和 `waitForTimeout()` 默认产生警告而不是静默忽略。

#### TypeScript 语义检查的类型边界（v13）

`typescript-semantic-validator.ts` 用内存 Program 做不加载代码的语义检查，开启 `strict`。
它需要一份**最小类型边界**（shim）让脚本里的符号可解析，边界之外的符号退化为 `any`：

- 只声明 `test`、`expect`、`process.env`，以及 `Page` / `Locator` 上**接收回调的方法**
  （`on` / `evaluate` / `waitForFunction` 等）与**定位方法**（`locator` / `getByRole` 等）。
- **为什么要声明这些**：接收者若为 `any`，其回调参数在 `noImplicitAny` 下会被判隐式 any 并
  阻断生成。实测中真实脚本的 `page.on('console', (message) => ...)` 控制台错误收集器即因此被拦。
  声明后回调参数可从调用处签名推断，无需逐个标注。
- **两条设计约束**：
  1. 未列举的成员由索引签名兜底为 `any`，保持既有兼容性；
  2. 除回调形参外的参数一律用**变参**声明——真实 API 常有多个可选参数
     （如 `locator(selector[, options])`），按固定元数声明会把合法调用误判为
     「Expected N arguments」，**误拒合法代码比漏报更危险**。
- **不受影响的部分**：用户自定义函数（如 `captureFullContent(target: any)`）的参数、
  以及挂在 `any` 值上的调用仍无从推断，**必须显式标注 `: any`**。
  该约束未放宽，回归断言见 `packages/agent/test/visual-regression-template.test.ts`。

## 7. 目标使用示例：组合 SDK 能力

以下示例展示独立 SDK 的组合方式。Chromium 安装器、浏览器会话和静态校验器在阶段 0/1 已可用；dry-run 仍是阶段 2 契约，默认门面会明确拒绝执行，宿主可在阶段 2 注入实现。

```ts
const engine = createPlaywrightEngine()
const abortController = new AbortController()

const browserStatus = await engine.chromium.detect()
if (!browserStatus.installed) {
  await engine.chromium.install({
    signal: abortController.signal,
    onProgress: (progress) => console.log(progress.message),
  })
}

const session = await engine.browser.create({
  baseUrl: 'https://example.test',
  headed: false,
  signal: abortController.signal,
})

try {
  await session.navigate('https://example.test/login')
  const snapshot = await session.snapshot()
  console.log(snapshot.candidateLocators)

  const validation = engine.validator.validate(candidateCode, {
    testCase,
  })

  if (!validation.valid) {
    throw new Error('候选脚本未通过静态质量检查')
  }

  const dryRun = await engine.dryRun.run({
    workspaceDir: tempDir,
    specCode: validation.code,
    baseUrl: testCase.baseUrl,
    envWhitelist: {
      E2E_USERNAME: process.env.E2E_USERNAME ?? '',
    },
    signal: abortController.signal,
  })

  console.log(dryRun.status, dryRun.sanitizedOutput)
} finally {
  await session.close()
}
```

> `createPlaywrightEngine()` 的默认 `dryRun` 实现只用于显式报告阶段 2 尚未实现；阶段 2 接入后应通过 `createPlaywrightEngine({ dryRun })` 注入真正的受控试运行器。

## 8. 推荐集成顺序

```text
宿主校验业务输入
      ↓
Chromium detect / install
      ↓
创建 browser session
      ↓
navigate / snapshot / query
      ↓
外部生成器或 Agent 产出候选代码
      ↓
validator.validate
      ↓（只有 valid 才允许）
dryRun.run
      ↓
宿主根据脱敏失败摘要决定是否修复
      ↓
释放进程和浏览器
      ↓
宿主清理临时工作区
```

SDK 不负责自动调用模型，也不负责自行循环修复。v7 中的修复上限由宿主编排：结构或输出修复最多 1 次，试运行失败修复最多 2 次。

## 9. 安全模型

候选脚本在用户审阅前可能于本机执行，因此必须采用纵深防御：

```text
TypeScript AST 语法检查
    + 导入白名单
    + 禁止动态执行、命令、文件和进程 API
    + TypeScript 语义检查
    + 临时工作区隔离
    + 环境变量白名单
    + 同源网络策略
    + 单次/整体超时
    + 取消与进程树终止
    + 输出脱敏
```

### 9.1 环境变量

候选脚本只应引用变量名：

```ts
const password = process.env.E2E_PASSWORD
```

试运行子进程只接收宿主显式传入的 `envWhitelist`。真实值不应进入脚本源码、日志、事件、错误摘要、预览或正式元数据。

### 9.2 网络

默认主动文档导航限制在 `baseUrl` 同源范围。页面需要的脚本、样式、图片、字体、媒体和必要请求可按网络策略放行，但不能借此主动打开任意异源页面。

### 9.3 文件

Engine 只使用宿主传入的临时工作区，不拥有正式 Skill 文件写权限。宿主应保证 Agent 工作期间产生的中间内容（候选脚本、试运行产物、页面探查截图等）只存在于 `<skill>/temp/`，并在 Engine 释放资源后清理该目录。

### 9.4 限制声明

Playwright Engine 不是通用恶意代码沙箱。运行模型生成脚本前，宿主仍应要求用户确认，并尽可能使用隔离测试数据、最小权限和专用测试环境。

## 10. 模块地图

```text
src/
├── index.ts                         # 稳定公共导出
├── engine.ts                         # 默认能力组装门面
├── contracts/                        # 独立 SDK 契约和错误/事件类型
├── validation/                      # 候选脚本静态质量门禁
│   ├── playwright-script-validator.ts
│   ├── playwright-structure-validator.ts
│   ├── step-coverage-validator.ts
│   ├── environment-variable-validator.ts
│   ├── forbidden-api-validator.ts
│   ├── import-policy-validator.ts
│   ├── typescript-parser.ts
│   └── typescript-semantic-validator.ts
├── formatting/                      # 确定性代码格式化
├── chromium-installer/              # 检测与安装 Chromium
├── browser-session/                 # 会话、导航、快照、查询和关闭
├── network-policy/                  # 同源导航与路由策略
├── dry-run/                         # 阶段 2：受控候选脚本试运行契约
├── observability/                   # 运行事件与脱敏
├── recorder/                        # 扩展位：录制适配
└── runner/                          # 扩展位：正式执行适配
```

### 依赖方向

```text
@authine-e2e-agent/agent（主要调用方：浏览器会话、静态校验、受控试运行）
@authine-e2e-agent/cli（仅 Chromium 检测/安装，Playwright 就绪检查）
桌面应用、CI 工具、其他 Agent 框架
                         ↓
@authine-e2e-agent/playwright-engine
                         ↓
Playwright / TypeScript / Node.js
```

Engine 不应反向依赖 `apps/cli`、`packages/agent` 或 `packages/skill-manager`。SDK 的全部类型都在本包内定义，不依赖 `@authine-e2e-agent/types`；平台用例数据若需要传入，应由宿主通过最小数据适配器转换，而不是把平台领域模型扩散到 SDK 公共 API。

## 11. 资源生命周期

资源释放是集成时最容易出错的部分。推荐由宿主统一使用 `try/finally`：

```text
AbortController 触发
      ↓
终止 dry-run 子进程树
      ↓
关闭 browser session
      ↓
释放宿主任务锁
      ↓
清理 temp/
      ↓
发布最终状态
```

以下方法必须具备幂等释放语义：

- 浏览器会话 `close()`；
- 试运行进程终止；
- Chromium 安装进程取消；
- 事件监听器和文件句柄清理。

在 Windows 上，清理前必须确保浏览器和子进程已经释放，否则可能因为文件占用导致 `temp/` 删除失败。

## 12. 错误处理

宿主不应依赖原始异常文本判断业务状态，应使用结构化错误码。典型错误包括：

- `BROWSER_NOT_INSTALLED`
- `BROWSER_INSTALL_FAILED`
- `BROWSER_INSTALL_CANCELLED`
- `BROWSER_SESSION_START_FAILED`
- `BROWSER_SESSION_DISCONNECTED`
- `PAGE_ACCESS_FAILED`
- `NETWORK_DOCUMENT_BLOCKED`
- `SCRIPT_VALIDATION_FAILED`
- `DRY_RUN_FAILED`
- `DRY_RUN_CANCELLED`
- `DRY_RUN_TIMEOUT`
- `TEMP_WORKSPACE_ERROR`
- `PROCESS_TERMINATION_FAILED`
- `ENGINE_CONFIGURATION_INVALID`

错误消息必须脱敏。页面元素与用例语义不一致通常不是 Engine 错误，而应由上层 Agent 作为 warning 或 assumption 展示。

## 13. 测试与开发建议

新增能力时，优先为每个模块提供三类测试：

1. **纯单元测试**：使用 fake session、fake process adapter 和内存数据，不依赖公网；
2. **本地集成测试**：使用 fixture server 和真实 Playwright Chromium；
3. **宿主集成测试**：在 CLI 或 E2E 层验证状态机、事件映射、保存边界和用户交互。

重点测试项：

- 无全局 `playwright` 命令时仍能定位包内 CLI；
- headed/headless 参数正确传递；
- 同源文档、跨源文档和子资源策略符合预期；
- 静态硬错误不会进入试运行；
- 未声明环境变量不会透传；
- 取消和超时能终止整个进程树；
- 试运行输出不会泄露秘密或绝对路径；
- 浏览器和临时文件在完成、失败、取消、断连后都能释放；
- 当前已有静态校验测试持续通过。

## 14. 新人阅读路径

建议按以下顺序熟悉本包：

1. 阅读本 README，了解用途和边界；
2. 阅读 [ARCHITECTURE.html](./ARCHITECTURE.html)，了解完整设计；
3. 阅读 [validation-types.ts](./src/validation/validation-types.ts)，先掌握校验输入和输出；
4. 阅读 [playwright-script-validator.ts](./src/validation/playwright-script-validator.ts)，理解校验流水线；
5. 按需阅读各个专用校验器和 [playwright-script-validator.test.ts](./test/playwright-script-validator.test.ts)；
6. 实现浏览器能力时先设计接口，再实现 Playwright 适配器；
7. 新增副作用能力时同步补充取消、超时、脱敏和资源释放测试。

## 15. 贡献约定

- 公共 API 必须通过 [src/index.ts](./src/index.ts) 导出，不要让调用方依赖深层内部路径；
- 新增文件在头部添加简体中文用途注释；
- 函数和类补充作用、参数、返回值和异常说明；
- 核心业务能力与工具函数分离，保持单一职责；
- 不在 Engine 中加入 Agent、HTTP、UI 或 Skill Manager 业务逻辑；
- 修改实现时同步维护注释、类型、测试和架构文档；
- 任何执行候选代码的能力都必须先经过安全评审。

## 16. 相关文档

- [架构设计 HTML 阅读版](./ARCHITECTURE.html)
- [架构设计 Markdown 版](./ARCHITECTURE.md)
- [包配置](./package.json)
- [静态校验器](./src/validation/playwright-script-validator.ts)
- [静态校验测试](./test/playwright-script-validator.test.ts)
- [v7 产品需求](../../PRD/v7.md)
- [v7 技术方案](../../PRD/v7-technical-design.md)
