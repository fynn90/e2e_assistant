<!-- 本文档说明 @fynn90-e2e_assistant/playwright-engine SDK 的实际接入方式、能力边界、生命周期和安全注意事项。 -->

# `@fynn90-e2e_assistant/playwright-engine` SDK 接入文档

- 包名：`@fynn90-e2e_assistant/playwright-engine`
- 当前包版本：`0.0.0`
- 文档适用范围：阶段 0（契约与兼容层）和阶段 1（浏览器基础能力）
- 文档状态：接入说明
- 关联文档：[README.md](README.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[Version 7 PRD](../../PRD/v7.md)

> 本文档以当前 `src/index.ts` 的根入口导出和实际实现为准。当前版本已经可以使用 Chromium 检测/安装、浏览器会话、同源网络策略和静态脚本校验；**受控 dry-run 只有契约，默认实现会明确拒绝执行**，不能把它当成已经可用的候选脚本执行器。

## 目录

1. [SDK 定位与能力总览](#1-sdk-定位与能力总览)
2. [安装与运行前提](#2-安装与运行前提)
3. [五分钟开始使用](#3-五分钟开始使用)
4. [统一门面与依赖注入](#4-统一门面与依赖注入)
5. [Chromium 检测与安装](#5-chromium-检测与安装)
6. [浏览器会话](#6-浏览器会话)
7. [同源网络策略](#7-同源网络策略)
8. [候选脚本静态校验](#8-候选脚本静态校验)
9. [事件、脱敏与错误处理](#9-事件脱敏与错误处理)
10. [取消、超时与资源释放](#10-取消超时与资源释放)
11. [阶段 2 契约与兼容导出](#11-阶段-2-契约与兼容导出)
12. [宿主接入清单与常见问题](#12-宿主接入清单与常见问题)

---

## 1. SDK 定位与能力总览

Playwright Engine 是一个运行在 Node.js 侧的基础能力 SDK。它负责把 Playwright 浏览器运行时、页面信息采集、网络边界和候选脚本静态校验封装成可替换的接口；它不负责自然语言理解、Agent Loop、业务用例存储或 UI 展示。

### 1.1 能力状态

| 能力          | 当前状态 | 入口                              | 说明                                                                            |
| ------------- | -------- | --------------------------------- | ------------------------------------------------------------------------------- |
| Chromium 检测 | 已实现   | `IChromiumInstaller.detect()`     | 检测 Playwright runtime 返回的 Chromium 可执行路径是否可访问                    |
| Chromium 安装 | 已实现   | `IChromiumInstaller.install()`    | 通过当前 npm 包内的 `playwright/cli.js` 执行 `install chromium`，不依赖全局命令 |
| 浏览器会话    | 已实现   | `IBrowserSessionFactory.create()` | 创建有头/无头 Chromium、context 和 page                                         |
| 页面导航      | 已实现   | `IBrowserSession.navigate()`      | 允许同源绝对地址和相对地址，跨源主动文档导航被拒绝                              |
| 页面快照      | 已实现   | `IBrowserSession.snapshot()`      | 返回有界的 a11y 摘要和候选定位器，不暴露 Playwright 原始对象                    |
| 元素查询      | 已实现   | `IBrowserSession.query()`         | 返回最多 100 个结构化元素信息                                                   |
| 网络策略      | 已实现   | `SameOriginNetworkPolicy`         | 阻止跨源 document，按策略放行必要子资源                                         |
| 静态脚本校验  | 已实现   | `PlaywrightScriptValidator`       | 不执行候选代码，检查语法、结构、安全、步骤覆盖和环境变量                        |
| 事件输出      | 已实现   | `IEngineEventSink`                | 浏览器、导航、快照、网络阻断和错误事件的宿主适配接口                            |
| 文本脱敏      | 已实现   | `ISensitiveDataRedactor`          | 可过滤宿主注入的秘密、凭据模式、路径和超长输出                                  |
| dry-run 契约  | 仅契约   | `IDryRunRunner`                   | 默认门面调用时抛出 `DRY_RUN_FAILED`，阶段 2 才提供默认实现                      |
| 正式测试执行  | 未实现   | 无                                | 不属于当前阶段；不能用 `runTest()` 代替正式执行                                 |
| 录制产品      | 未实现   | `startRecorder()` 兼容导出        | 当前只返回基础脚本示例，不是录制、回放或持久化能力                              |

### 1.2 SDK 不负责的事情

使用方必须自行负责以下业务职责：

- 读取和保存 `e2e_schema.json`、`SKILL.md` 以及正式 `test.spec.ts`；
- 决定何时调用模型、如何生成代码以及失败后是否重试；
- 解析 `browserVisualization` 等业务字段并决定 `headed` 值；
- 创建、锁定和清理 Skill 的 `temp/` 工作区；
- 把 Engine 事件映射为 SSE、WebSocket、日志或前端侧边栏消息；
- 为候选脚本提供真实环境变量、测试账号和业务测试数据；
- 将候选脚本保存为正式文件，或维护正式测试报告的历史；
- 把 Engine 当成通用恶意代码沙箱或网络隔离沙箱。

### 1.3 推荐依赖方向

```text
宿主应用 / CLI / Agent / CI
              │
              ▼
@fynn90-e2e_assistant/playwright-engine
              │
              ├── playwright
              ├── typescript
              └── Node.js 内置模块
```

宿主只应从包根入口导入公共 API：

```ts
import {
  createPlaywrightEngine,
  createDefaultRedactor,
  isPlaywrightEngineError,
} from '@fynn90-e2e_assistant/playwright-engine'
```

不要让业务代码依赖 `src/` 下的深层路径；深层路径主要用于测试替身和包自身维护。

---

## 2. 安装与运行前提

### 2.1 安装

发布环境可以使用项目实际配置的 npm registry 安装：

```bash
pnpm add @fynn90-e2e_assistant/playwright-engine
```

或：

```bash
npm install @fynn90-e2e_assistant/playwright-engine
```

当前包是 ESM 包，使用 `import` 导入。它不是浏览器端 UI 包，应从 CLI、Node.js 服务、桌面应用主进程或 CI 任务中调用。

### 2.2 运行环境

- 仓库根工程的 Node.js 基线为 `>=22.19.0`；接入方应使用不低于该基线的 Node.js 版本。
- Playwright 是运行时依赖，但 Chromium 二进制不随 SDK 源码或 npm 包直接分发。
- 不要求用户在全局 PATH 中安装 `playwright` 命令；安装器会解析 SDK 自身依赖中的 `playwright/cli.js`。
- 页面会话需要本机存在可执行 Chromium，或由宿主在生成/核对页面之前显式调用 `engine.chromium.install()`。
- TypeScript 候选脚本的静态校验由 SDK 内部使用 TypeScript Compiler API 完成，不要求宿主为“只校验”场景启动 Playwright Test runner。

### 2.3 仓库内开发命令

在仓库根目录执行：

```bash
pnpm --dir packages/playwright-engine typecheck
pnpm --dir packages/playwright-engine test
pnpm --dir packages/playwright-engine build
```

`browser-session` 的真实 fixture 测试要求本机已经安装 Chromium；没有浏览器时，该测试会跳过，但 Chromium detector、安装器 fake 测试、网络策略和静态校验仍可以运行。

---

## 3. 五分钟开始使用

下面的示例保存为宿主项目中的 `.mjs` 文件后运行。它展示了“检测 → 必要时安装 → 创建会话 → 导航 → 快照/查询 → 释放”的最小闭环。

```js
import {
  createPlaywrightEngine,
  isPlaywrightEngineError,
} from '@fynn90-e2e_assistant/playwright-engine'

const engine = createPlaywrightEngine()
const controller = new AbortController()
let session

const abort = () => controller.abort()
process.once('SIGINT', abort)

try {
  const status = await engine.chromium.detect()

  if (!status.installed) {
    await engine.chromium.install({
      signal: controller.signal,
      onProgress: ({ phase }) => {
        // 只输出阶段，不直接输出安装器原始日志。
        console.info(`[chromium] ${phase}`)
      },
    })
  }

  if (controller.signal.aborted) {
    throw new Error('任务已取消')
  }

  session = await engine.browser.create({
    baseUrl: 'https://example.test',
    headed: false,
    signal: controller.signal,
  })

  // 相对地址相对于 baseUrl 解析，并且仍会经过同源策略检查。
  const reference = await session.navigate('/login')
  const snapshot = await session.snapshot()
  const elements = await session.query('button, input')

  // 只展示摘要，避免把页面正文、输入值或属性直接写入日志。
  console.info({
    url: reference.url,
    title: reference.title,
    locatorCount: snapshot.candidateLocators.length,
    elementCount: elements.length,
    truncated: snapshot.truncated,
  })
} catch (error) {
  const code = isPlaywrightEngineError(error)
    ? error.code
    : controller.signal.aborted
      ? 'CANCELLED'
      : 'UNEXPECTED_ERROR'

  // 生产环境应按 code 映射用户提示，不要直接输出未知异常的 stack。
  console.error(`Playwright Engine failed: ${code}`)
  process.exitCode = 1
} finally {
  process.off('SIGINT', abort)
  try {
    await session?.close()
  } catch {
    console.error('浏览器资源释放失败')
    process.exitCode = 1
  }
}
```

这个示例有几个重要特征：

1. `createPlaywrightEngine()` 只组装对象，不会自动安装浏览器、启动浏览器或执行脚本。
2. `headed: false` 是默认安全选择；只有明确需要用户观察页面时才传入 `true`。
3. 即使使用相对地址，主动导航仍不能跳出 `baseUrl` 的 origin。
4. 会话必须放在 `try/finally` 中，并且 `close()` 应作为宿主任务的终态清理步骤。
5. 不要把 `snapshot.a11yTree`、`query()` 返回的 `value` 或原始异常直接发送到日志、模型或前端。

---

## 4. 统一门面与依赖注入

### 4.1 `createPlaywrightEngine()`

```ts
interface IPlaywrightEngine {
  chromium: IChromiumInstaller
  browser: IBrowserSessionFactory
  dryRun: IDryRunRunner
  validator: IPlaywrightScriptValidator
}

interface IPlaywrightEngineOptions {
  chromium?: IChromiumInstaller
  browser?: IBrowserSessionFactory
  dryRun?: IDryRunRunner
  validator?: IPlaywrightScriptValidator
}
```

默认工厂创建以下实现：

- `new ChromiumInstaller()`；
- `new PlaywrightBrowserSessionFactory()`；
- `new PlaywrightScriptValidator()`；
- 阶段 2 尚未实现的 `UnsupportedDryRunRunner`。

可以通过 `IPlaywrightEngineOptions` 替换任意能力。工厂当前**不接受**一个整个平台配置对象，也没有 `playwright`、`testRunner`、Agent session 或 Skill manager 参数。

```ts
const engine = createPlaywrightEngine({
  validator: hostProvidedValidator,
  browser: hostProvidedBrowserFactory,
  chromium: hostProvidedChromiumInstaller,
  dryRun: hostProvidedDryRunRunner, // 只有宿主已经拥有阶段 2 实现时才注入
})
```

### 4.2 能力状态

```ts
const capabilities = getPlaywrightEngineCapabilities()

// 当前默认门面返回：
// { chromium: true, browser: true, validator: true, dryRun: false }
```

该函数表示当前默认实现是否具备能力，不表示 Chromium 已经安装，也不表示目标站点可访问。浏览器就绪仍必须调用 `detect()`，页面访问仍必须处理导航异常。

### 4.3 适合注入替身的场景

- 单元测试：注入 fake `IChromiumInstaller`，不访问网络；
- Agent 测试：注入 fake `IBrowserSessionFactory`，不启动真实浏览器；
- 宿主 dry-run 接入：在阶段 2 提供 `IDryRunRunner` 后注入 `createPlaywrightEngine({ dryRun })`；
- 多租户配置：通过每次 `browser.create()` 的 `networkPolicy`、`eventSink` 和 `redactor` 传入任务级配置。

SDK 不会因为注入 fake 实现而替宿主验证 fake 的安全性；注入对象的权限和生命周期仍由宿主负责。

---

## 5. Chromium 检测与安装

### 5.1 检测

```ts
const status = await engine.chromium.detect()

if (status.installed) {
  console.info('Chromium executable:', status.executablePath)
} else {
  console.warn('Chromium is not ready:', status.reason)
}
```

`IChromiumStatus` 字段：

| 字段             | 类型       | 说明                                                        |
| ---------------- | ---------- | ----------------------------------------------------------- |
| `installed`      | `boolean`  | Playwright 返回的主 Chromium 可执行路径是否通过文件访问检查 |
| `executablePath` | `string \\ | null`                                                       | Playwright runtime 返回的路径；缺失路径时为 `null` |
| `version`        | `string?`  | 当前 detector 不主动填充版本，不能依赖该字段                |
| `reason`         | 联合类型   | 未安装、权限、路径非法或未知原因                            |

检测不会启动浏览器，也不会下载文件。检测只判断主可执行路径的可访问性，不等价于“页面一定能启动”或“所有 Playwright browser channel 都已准备好”。

### 5.2 安装

```ts
const installed = await engine.chromium.install({
  timeoutMs: 10 * 60 * 1_000,
  signal: controller.signal,
  onProgress: (event) => {
    console.info({ phase: event.phase })
  },
})
```

安装器的实际流程：

1. 先调用 `detect()`；已经安装时直接返回状态；
2. 使用 `createRequire(import.meta.url)` 定位 SDK 自身依赖的 `playwright/cli.js`；
3. 使用当前 Node 进程执行 `node <playwright-cli> install chromium`；
4. 逐行处理 stdout/stderr，并通过默认或宿主注入的 redactor 处理进度文本；
5. 完成后再次调用 `detect()`；
6. 最终仍不可用时抛出结构化 Engine 错误。

`IInstallChromiumOptions`：

| 字段           | 默认值                       | 说明                                                                |
| -------------- | ---------------------------- | ------------------------------------------------------------------- |
| `signal`       | 无                           | 取消安装并终止安装进程树                                            |
| `timeoutMs`    | 600000                       | 安装进程整体超时                                                    |
| `browsersPath` | 使用 Playwright 默认缓存位置 | 安装进程环境中的 `PLAYWRIGHT_BROWSERS_PATH`                         |
| `onProgress`   | 无                           | 接收 `resolving-cli`、`downloading`、`extracting`、`verifying` 阶段 |

安装器会在同一个 Node 进程内共享正在进行的安装 Promise，避免同一进程重复拉取 Chromium。并发调用方不会获得独立的安装任务；第一个安装任务的取消、超时和配置会影响共享任务。

### 5.3 自定义浏览器缓存路径的注意事项

默认用法应让 Playwright 使用默认浏览器缓存目录。如果必须使用自定义 `PLAYWRIGHT_BROWSERS_PATH`，建议在启动 Node.js 进程前配置环境变量，再创建 SDK 实例：

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers node generate.mjs
```

Windows、容器和桌面应用请使用对应宿主进程的环境变量配置方式。当前 detector 的 `browsersPath` 参数保留在公共契约中，但实际可执行路径仍由已加载的 Playwright runtime 提供；不要在同一进程中频繁切换不同缓存目录并期待 detector 自动切换 runtime 路径。

### 5.4 安装失败处理

安装失败时优先读取 `PlaywrightEngineError.code` 和 `details.reason`，不要用异常 message 文本做业务分支：

- `BROWSER_INSTALL_CANCELLED`：调用方或用户取消；
- `BROWSER_INSTALL_TIMEOUT`：安装超过整体超时；
- `BROWSER_INSTALL_FAILED`：CLI 定位、网络、权限、磁盘或进程退出失败；
- `ENGINE_CONFIGURATION_INVALID`：通常来自非法网络或会话配置，不是安装下载失败。

安装失败后宿主不应继续启动页面核对或请求模型，应展示可理解的重试/手动安装提示。

---

## 6. 浏览器会话

### 6.1 创建会话

```ts
const session = await engine.browser.create({
  baseUrl: 'https://example.test',
  headed: false,
  timeoutMs: 30_000,
  navigationTimeoutMs: 30_000,
  signal: controller.signal,
  eventSink,
  redactor,
})
```

`IBrowserSessionOptions`：

| 字段                  | 默认值                         | 说明                                                 |
| --------------------- | ------------------------------ | ---------------------------------------------------- |
| `baseUrl`             | 必填                           | 只接受无用户名/密码的 HTTP 或 HTTPS URL              |
| `headed`              | `false`                        | `true` 映射为有头；两种模式都用完整 Chromium（`channel: 'chromium'`） |
| `timeoutMs`           | 30000                          | 页面默认操作超时                                     |
| `navigationTimeoutMs` | `timeoutMs` 或 30000           | `page.goto()` 的导航超时                             |
| `networkPolicy`       | 默认 `SameOriginNetworkPolicy` | 自定义网络边界                                       |
| `signal`              | 无                             | 取消后关闭会话资源                                   |
| `eventSink`           | 无                             | 接收浏览器和网络事件                                 |
| `redactor`            | 默认脱敏器                     | 处理快照、查询结果和部分安装/错误文本                |

会话工厂创建并持有以下资源：

```text
Browser
  └── BrowserContext（配置 baseURL 和路由策略）
        └── Page
```

宿主只能使用 `IBrowserSession`，不会从公共会话对象获得 `Browser`、`BrowserContext` 或 `Page`。这使网络策略和资源生命周期不被业务代码绕过。

### 6.2 `navigate()`

```ts
const reference = await session.navigate('/login')
console.info(reference.url, reference.title)
```

行为规则：

- 绝对 URL 和相对 URL 都会相对于会话 `baseUrl` 解析；
- scheme、hostname 和 port 都必须与 `baseUrl` 同源；
- 含用户名或密码的 URL 会被拒绝；
- 跨源主动 document 导航抛出 `NETWORK_DOCUMENT_BLOCKED`；
- 导航成功后只返回 `{ url, title }`，不返回页面 DOM；
- 导航失败映射为 `PAGE_ACCESS_FAILED`，浏览器断连时映射为 `BROWSER_SESSION_DISCONNECTED`。

`navigate()` 不会替宿主判断页面业务语义是否正确。登录页、错误页、需要人工输入的页以及元素缺失都必须由上层通过快照和查询结果判断。

### 6.3 `snapshot()`

```ts
const snapshot = await session.snapshot({
  maxA11yLength: 12_000,
  maxLocators: 50,
})

console.info({
  url: snapshot.url,
  title: snapshot.title,
  locatorCount: snapshot.candidateLocators.length,
  truncated: snapshot.truncated,
})
```

默认限制：

- a11y 文本最多约 24000 个字符；
- 候选定位器最多 100 个；
- 每个候选文本最多约 240 个字符；
- 页面快照会记录 `capturedAt`；
- `truncated: true` 表示候选数量或 a11y 文本超出限制，调用方应把它当作“页面信息可能不足”。

候选定位器可能包含 `role`、`name`、`label`、`placeholder`、`testId`、`text`、`css` 和 `confidence`。这些是启发式候选，不是对 selector 稳定性或业务正确性的保证。

如果页面无法产生 a11y 快照，SDK 会返回有限或空的摘要；宿主不能把空摘要理解成“页面没有内容”。页面内容属于不可信输入，SDK 不执行页面文本中的指令。

### 6.4 `query()`

```ts
const inputs = await session.query('input, textarea')

for (const element of inputs) {
  console.info({
    selector: element.selector,
    index: element.index,
    tagName: element.tagName,
    role: element.role,
  })
}
```

查询结果是 `IElementInfo[]`，最多返回 100 个元素，可能包含：

- `selector` 和元素 `index`；
- `tagName`、`role`、`name`；
- 截断后的 `text` 和 `value`；
- 部分 `aria-*`、`data-testid` 和 `value` 属性。

`query()` 只查询，不执行 click、fill、press 等操作。`value` 可能是密码、Token 或业务数据；即使配置了默认 redactor，也不应直接记录全部查询结果。需要使用真实秘密值时，宿主应把这些值作为 redactor 的 `secrets` 注入，而不是把完整 `process.env` 复制给日志或模型。

### 6.5 `close()`

```ts
try {
  await session.navigate('/')
} finally {
  await session.close()
  // close() 可再次调用，第二次调用复用同一个关闭 Promise。
}
```

`close()` 会关闭 context 和 browser，且是幂等的。任务完成、失败、取消、用户离开页面或浏览器断连时，宿主都应调用它。SDK 不负责删除宿主的 Skill 目录、`temp/` 或正式文件。

---

## 7. 同源网络策略

### 7.1 默认规则

`PlaywrightBrowserSessionFactory` 默认创建 `SameOriginNetworkPolicy` 并在 context 上安装路由：

| 请求类型                                                   | 同源 | 跨源               |
| ---------------------------------------------------------- | ---- | ------------------ |
| 主动导航                                                   | 允许 | 拒绝               |
| `document` 请求/重定向                                     | 允许 | 拒绝               |
| `script`、`style`、`img`、`font`、媒体、XHR/fetch 等子资源 | 允许 | 默认允许必要子资源 |

同源比较包含 scheme、host 和 port。CDN 子资源可以放行，但这不意味着可以借助子资源例外主动打开异源页面。

### 7.2 自定义策略

```ts
import {
  SameOriginNetworkPolicy,
  createBrowserSessionFactory,
} from '@fynn90-e2e_assistant/playwright-engine'

const networkPolicy = new SameOriginNetworkPolicy('https://example.test', {
  allowSubresources: true,
  allowedOrigins: new Set([
    'https://static.example.test',
    'https://cdn.example.test',
  ]),
})

const browser = createBrowserSessionFactory()
const session = await browser.create({
  baseUrl: 'https://example.test',
  networkPolicy,
})
```

`allowedOrigins`只影响跨源子资源；它不会放开跨源 document 导航。配置了非空集合后，跨源子资源必须来自集合中的 origin；同源资源始终允许。`allowSubresources: false` 时，跨源子资源也会被阻断。

如果宿主注入自定义 `INetworkPolicy`，工厂会调用它的 `installRoute(context)`，不会自动把默认策略覆盖回去。自定义策略必须自己承担 URL 校验、路由释放和安全评审。

### 7.3 策略边界

网络路由策略不是通用代码沙箱，也不是操作系统级网络防火墙。它主要控制 Playwright 页面上下文的请求；候选 Node.js 代码如果拥有运行权限，仍可能通过其他 API 绕过页面路由。因此候选脚本执行必须同时依赖：

- 静态导入白名单；
- 禁止动态执行、命令执行、文件写入和进程控制；
- 受限工作区和环境变量白名单；
- 单次/整体超时和进程树终止；
- 宿主的操作系统权限与测试数据隔离。

上述候选代码执行边界属于阶段 2 dry-run 和宿主编排，不是当前浏览器会话的替代品。

---

## 8. 候选脚本静态校验

### 8.1 最小输入契约

校验器不依赖平台领域包，只需要 `IValidationTestCase`：

```ts
const testCase = {
  title: '填写用户名',
  baseUrl: 'https://example.test',
  steps: [
    {
      id: 'step_fill_username',
      order: 1,
      enabled: true,
      description: '填写用户名',
      action: '填写 ${ENV:E2E_USERNAME}',
      expectedResult: '输入框显示用户名',
      testData: {},
    },
  ],
}
```

每个步骤至少需要 `id`、`order` 和 `enabled`。`description`、`action`、`expectedResult`、`testData` 用于环境变量提取和步骤语义提示；平台可以把完整的业务用例转换成该最小结构后再传入。

### 8.2 校验示例

```ts
import { PlaywrightScriptValidator } from '@fynn90-e2e_assistant/playwright-engine'

const candidateCode = `
import { test, expect } from '@playwright/test'

test('填写用户名', async ({ page }) => {
  await page.goto('https://example.test/login')
  await test.step('step_fill_username', async () => {
    const username = process.env.E2E_USERNAME ?? ''
    await page.getByLabel('用户名').fill(username)
    await expect(page.getByLabel('用户名')).toHaveValue(username)
  })
})
`

const result = new PlaywrightScriptValidator().validate(candidateCode, {
  testCase,
})

if (!result.valid) {
  for (const issue of result.errors) {
    console.error({ code: issue.code, line: issue.line, stepId: issue.stepId })
  }
} else {
  // result.code 是确定性格式化后的代码快照，仍需由宿主决定是否保存或执行。
  console.info({
    warningCount: result.warnings.length,
    environmentVariables: result.environmentVariables,
    stepCoverage: result.stepCoverage,
  })
}
```

### 8.3 校验流水线

`PlaywrightScriptValidator.validate()` 当前按以下顺序执行：

1. TypeScript 语法解析；
2. 内存 TypeScript 语义校验；
3. 导入策略校验，默认只允许 `@playwright/test`，并可增加 `allowedModules`；
4. 禁止动态执行、命令执行、文件写入和进程控制 API；
5. Playwright 测试结构、标题、`page` fixture、`page.goto()` 和 `expect()` 校验；
6. 用例中的 `${ENV:NAME}` 与脚本中的 `process.env.NAME` 精确比对；
7. `test.step('<step-id>')` 步骤覆盖、操作和断言数量校验；
8. 对 XPath、深层 CSS、动态定位器和 `waitForTimeout()` 生成 warning；
9. 使用 TypeScript Printer 格式化通过解析的代码，并再次检查格式化结果。

有任意 `error` 时 `valid` 为 `false`；只有 warning 时 `valid` 可以为 `true`。`valid: true` 只代表静态规则通过，不代表页面一定可访问、不代表 selector 一定命中，也不代表代码可以安全执行。

### 8.4 环境变量规则

当前环境变量名来自以下启用步骤文本：

- 用例标题、描述、Base URL、tags；
- 前置条件描述；
- 启用步骤的描述、action、expectedResult、testData 键和值。

只有符合 `[A-Z_][A-Z0-9_]*` 的占位符会被识别。脚本必须引用同名 `process.env.NAME`；未声明引用和声明但未引用都会产生 error。校验结果只返回变量名，不读取或返回真实值。

`IPlaywrightValidationOptions.requiredEnvironmentVariables` 已存在于契约中，但当前默认 `PlaywrightScriptValidator` 不会把它作为额外规则应用；需要强制环境变量清单时，宿主应在调用前自行校验，或注入自定义 validator。

### 8.5 校验边界

- 校验器永远不会 `require`、`import` 或执行候选脚本；
- 内存语义 shim 只提供有限的 `@playwright/test` 和 `process.env` 类型，不是完整 Playwright 类型检查；
- `allowedModules` 只影响静态导入白名单，不会自动为自定义模块提供类型声明或运行时实现；
- 校验通过后是否进入 dry-run、是否调用 Agent 修复、是否保存为正式脚本，均由宿主决定；
- `result.code` 是内存快照，不会自动写入任何文件。

---

## 9. 事件、脱敏与错误处理

### 9.1 事件 sink

```ts
import {
  createDefaultRedactor,
  sanitizeUrl,
  type IEngineEventSink,
} from '@fynn90-e2e_assistant/playwright-engine'

const redactor = createDefaultRedactor({
  secrets: [process.env.E2E_PASSWORD ?? ''],
  maxLength: 8_192,
})

const eventSink: IEngineEventSink = {
  publish(event) {
    const safeEvent =
      'url' in event ? { ...event, url: sanitizeUrl(event.url) } : event

    // publish() 只接收脱敏后的摘要；不要把原始 page 内容写入事件。
    console.info(redactor.redact(JSON.stringify(safeEvent)))
  },
}
```

当前契约定义了以下事件：

| 事件                   | 阶段 0/1 默认实现                          |
| ---------------------- | ------------------------------------------ |
| `browser.started`      | 创建会话时发布                             |
| `browser.navigation`   | 导航成功时发布                             |
| `browser.snapshot`     | 快照完成时发布                             |
| `browser.disconnected` | Browser 断连时发布                         |
| `network.blocked`      | 路由阻断 document 或子资源时发布           |
| `engine.error`         | 当前默认会话在主动导航被网络策略拒绝时发布 |
| `dry-run.*`            | 阶段 2 契约，当前无默认执行器              |
| `process.cancelled`    | 事件契约预留，宿主可自行发布或映射         |

`IEngineEventSink.publish()` 的同步异常和异步 rejection 会被 Engine 隔离，不会替宿主完成业务重试。事件发布不是任务成功的确认机制，宿主需要自己维护任务状态和最终结果。

### 9.2 默认脱敏器

`createDefaultRedactor()` 会处理：

- 宿主通过 `secrets` 显式传入的值；
- 常见 `password`、`token`、`secret`、`api_key` 字段模式；
- Bearer token；
- URL 中的用户名/密码模式；
- 当前用户目录、工作目录和临时目录路径；
- 输出长度上限。

它不是完整的秘密检测器。环境变量真实值、业务字段、Base64 内容、页面图片和任意自定义凭据格式都不会自动全部识别。宿主必须主动传入已知秘密，并且避免把完整 `process.env` 传入 redactor 或日志。

### 9.3 错误处理示例

```ts
import { isPlaywrightEngineError } from '@fynn90-e2e_assistant/playwright-engine'

function getPublicFailure(error) {
  if (isPlaywrightEngineError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.details.retryable,
    }
  }

  return {
    code: 'UNEXPECTED_ERROR',
    message: '发生未分类的本地运行错误。',
    retryable: false,
  }
}
```

业务分支应使用 `code`，用户提示可以使用已经脱敏的 `message`。不要把完整 Error、`stack` 或 `details.reason` 直接发送到页面、SSE 或模型；`reason` 是诊断字段，宿主应把它当作内部信息处理。

常用错误码：

| 错误码                         | 含义                                     | 常见处理                             |
| ------------------------------ | ---------------------------------------- | ------------------------------------ |
| `BROWSER_INSTALL_FAILED`       | Chromium CLI 安装失败                    | 展示失败阶段并允许用户重试/手动安装  |
| `BROWSER_INSTALL_CANCELLED`    | 安装被取消                               | 保持正式文件不变，允许重新开始       |
| `BROWSER_INSTALL_TIMEOUT`      | 安装超时                                 | 释放任务资源后重试                   |
| `BROWSER_SESSION_START_FAILED` | 浏览器启动、context 或 route 安装失败    | 检查 Chromium、权限和运行环境        |
| `BROWSER_SESSION_DISCONNECTED` | 浏览器已经断连                           | 结束当前页面核对任务，不显示生成成功 |
| `PAGE_ACCESS_FAILED`           | 页面导航或元素查询失败                   | 展示可理解的页面访问原因             |
| `PAGE_VERIFICATION_FAILED`     | 快照采集失败                             | 披露页面信息不足并允许重新生成       |
| `NETWORK_DOCUMENT_BLOCKED`     | 主动/主文档跨源导航被阻断                | 检查 baseUrl、重定向或测试环境       |
| `ENGINE_CONFIGURATION_INVALID` | URL、超时或 selector 等配置错误          | 修正调用方输入                       |
| `DRY_RUN_FAILED`               | 当前默认 dry-run 不可用或阶段 2 执行失败 | 不要把失败当成正式测试结果           |

`BROWSER_NOT_INSTALLED`、`PAGE_NAVIGATION_BLOCKED`、`SCRIPT_VALIDATION_FAILED` 等错误码属于统一错误契约的一部分；静态 validator 默认通过 `IPlaywrightValidationResult` 返回问题，而不是直接抛出 `SCRIPT_VALIDATION_FAILED`。

---

## 10. 取消、超时与资源释放

### 10.1 会话生命周期模板

```ts
const controller = new AbortController()
const session = await engine.browser.create({
  baseUrl,
  headed: false,
  signal: controller.signal,
})

const timeout = setTimeout(() => controller.abort(), 120_000)

try {
  if (controller.signal.aborted) {
    throw new Error('任务已取消')
  }

  await session.navigate('/')
  const snapshot = await session.snapshot()
  return snapshot
} finally {
  clearTimeout(timeout)
  await session.close()
}
```

接入方应遵守以下顺序：

1. 用户停止、页面离开或宿主整体超时时调用 `AbortController.abort()`；
2. 等待或捕获正在进行的页面操作结束；
3. 在 `finally` 中调用 `session.close()`；
4. 只有在所有 Engine 资源释放后，才由宿主删除自己的 `temp/` 或释放任务锁。

AbortSignal 触发后，当前会话会发起异步关闭；宿主仍应显式等待 `close()`。SDK 不知道宿主的任务锁、Skill 目录或文件树，因此不会替宿主删除目录。

### 10.2 安装器生命周期

安装器支持自己的 `signal` 和 `timeoutMs`。安装进程在 Windows 使用 `taskkill /T /F` 处理进程树，在 POSIX 环境尝试进程组终止。跨平台部署仍应在目标操作系统验证取消后的子进程、文件占用和缓存目录状态；不能把一次 `AbortController.abort()` 调用当作宿主清理完成的证明。

### 10.3 有头浏览器行为

`headed: true` 只表示打开用户可见的 Chromium 窗口。SDK 不提供用户点击、输入或调试 API，也不录制、上传或持久化浏览器画面。宿主应向用户说明该窗口只供观察，并在完成、失败、取消、断连或用户离开页面时关闭会话。

---

## 11. 阶段 2 契约与兼容导出

### 11.1 dry-run 目前不能直接使用

`IDryRunRunner` 已经导出，便于 Agent/CLI 提前依赖稳定契约：

```ts
interface IDryRunRequest {
  workspaceDir: string
  specCode: string
  baseUrl: string
  envWhitelist: Readonly<Record<string, string>>
  networkPolicy?: INetworkPolicy
  timeout?: IDryRunTimeouts
  signal?: AbortSignal
  eventSink?: IEngineEventSink
}
```

但是：

```ts
const engine = createPlaywrightEngine()
await engine.dryRun.run(request) // 当前会抛出 DRY_RUN_FAILED
```

当前包尚未提供以下 dry-run 实现：

- 向临时工作区写入候选 spec/config/setup 文件；
- 定位并启动 `@playwright/test` CLI；
- JSON reporter 解析；
- 候选进程的环境变量白名单；
- 单次/整体超时和完整进程树终止；
- dry-run 输出标准化和完整失败摘要。

如果宿主已经拥有临时的受控执行器，可以通过 `createPlaywrightEngine({ dryRun })` 注入；注入器必须自行遵守工作区、网络、环境变量、超时和脱敏边界。

### 11.2 旧兼容导出

| 导出                       | 当前行为                                        | 接入建议                                            |
| -------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `runTest()`                | 返回 `passed: false` 和占位日志                 | 不要用于正式执行或 dry-run                          |
| `startRecorder()`          | 根据 title/url 返回基础 Playwright 脚本文本     | 不要把它理解成浏览器录制器                          |
| `createRuntimeEvent()`     | 创建简单的 `console`/`network`/`error` 事件对象 | 新接入优先使用 `IEngineEventSink` 和 `TEngineEvent` |
| `formatPlaywrightScript()` | 对已解析 TypeScript AST 做确定性格式化          | 使用 validator 结果时无需单独调用                   |

正式测试执行、报告、截图、视频、Trace、录制和多用例编排不属于当前 SDK 阶段。

---

## 12. 宿主接入清单与常见问题

### 12.1 生成任务开始前

- [ ] 已将平台用例转换为 `IValidationTestCase`；
- [ ] 已确认 `baseUrl` 是无凭据的 HTTP/HTTPS URL；
- [ ] 已向用户提示页面访问和本机候选代码执行边界；
- [ ] 已调用 `chromium.detect()`，缺失时明确调用 `chromium.install()`；
- [ ] 已为本次任务创建独立 `AbortController`；
- [ ] 已配置 `IEngineEventSink`，并在 sink 内再次执行宿主侧日志脱敏；
- [ ] 已把已知秘密注入 `ISensitiveDataRedactor`，而不是直接记录 `process.env`；
- [ ] 已确认没有并发任务会复用或关闭同一个 session。

### 12.2 生成/核对过程中

- [ ] 页面核对只通过 `navigate`、`snapshot`、`query`，不把原始 Playwright Page 暴露给 Agent；
- [ ] 每次导航、快照和查询都处理结构化错误；
- [ ] `snapshot.truncated` 为 `true` 时向上层披露信息可能不足；
- [ ] 只把必要的页面摘要传给模型或 UI；
- [ ] 静态校验存在 error 时不进入任何候选执行流程；
- [ ] warning、环境变量名称和步骤覆盖摘要可以展示，但不展示环境变量真实值；
- [ ] 不把 `dryRun` 默认占位实现当成执行成功。

### 12.3 任务终态

- [ ] 完成、失败、取消、断连都进入统一 `finally`；
- [ ] 已调用并等待 `session.close()`；
- [ ] 已确认安装/浏览器资源没有继续占用任务目录；
- [ ] 再由宿主释放任务锁并清理 `temp/`；
- [ ] 正式 `test.spec.ts`、`SKILL.md`、用例文件和版本元数据未被 Engine 自动修改；
- [ ] 对外仅返回安全摘要和结构化状态。

### 12.4 常见问题

**Q：没有全局 `playwright` 命令，为什么安装仍然可以工作？**
A：安装器使用包自身依赖解析出的 `playwright/cli.js`，不调用 PATH 中的命令。仍需保证 npm 包本身和网络下载权限正常。

**Q：`detect()` 返回 installed=true，为什么创建会话仍可能失败？**
A：检测主要检查主 Chromium 可执行路径的文件访问；浏览器启动还可能受权限、系统库、沙箱参数、显示环境或运行时资源影响。

**Q：为什么跨源 CDN 脚本可以加载，但跨源页面不能导航？**
A：产品边界允许页面必要子资源例外，但主动 document 导航必须保持 baseUrl 同源；两者由不同的路由分支判断。

**Q：为什么静态校验通过仍不能说明脚本一定可用？**
A：静态校验不访问目标页面、不执行代码，也不能知道登录态、异步状态和真实元素；试运行和用户审阅属于后续宿主流程。

**Q：为什么 `requiredEnvironmentVariables` 没有产生额外错误？**
A：它目前只是契约字段，默认 validator 的实际规则来源是用例文本中的 `${ENV:NAME}`。需要额外清单时请在宿主侧补充校验或注入自定义 validator。

**Q：为什么默认 `dryRun.run()` 抛出错误？**
A：当前包只完成阶段 0/1；这样设计是为了避免把未实现的占位能力误报成安全执行或正式测试结果。

**Q：可以把页面快照或查询结果完整写入日志吗？**
A：不建议。页面可能包含登录数据、Token、密码或个人信息；只记录计数、URL 摘要、阶段、错误码和经过脱敏的最小诊断文本。

---

## 附录 A：常用公共导出

以下类型和工厂均可从包根入口导入：

```ts
import {
  // 门面
  createPlaywrightEngine,
  getPlaywrightEngineCapabilities,

  // Chromium
  createChromiumDetector,
  createChromiumInstaller,
  ChromiumDetector,
  ChromiumInstaller,

  // 浏览器
  createBrowserSessionFactory,
  PlaywrightBrowserSessionFactory,
  PlaywrightBrowserSession,
  createPageSnapshot,

  // 网络
  SameOriginNetworkPolicy,
  RoutePolicy,
  normalizeHttpUrl,
  resolveHttpUrl,
  sanitizeUrl,

  // 校验
  PlaywrightScriptValidator,
  extractExpectedEnvironmentVariables,
  formatPlaywrightScript,

  // 事件、错误、脱敏
  createNoopEventSink,
  publishEngineEvent,
  PlaywrightEngineError,
  isPlaywrightEngineError,
  createDefaultRedactor,
} from '@fynn90-e2e_assistant/playwright-engine'
```

接口契约包括：

- `IPlaywrightEngine`、`IPlaywrightEngineOptions`；
- `IChromiumInstaller`、`IChromiumStatus`、`IInstallChromiumOptions`；
- `IBrowserSessionFactory`、`IBrowserSession`、`IBrowserSessionOptions`；
- `IPageSnapshot`、`IPageSnapshotRef`、`ICandidateLocator`、`IElementInfo`；
- `INetworkPolicy`、`INetworkRouteOptions`；
- `IValidationTestCase`、`IValidationTestStep`、`IPlaywrightValidationOptions`、`IPlaywrightValidationResult`；
- `IEngineEventSink`、`TEngineEvent`；
- `ISensitiveDataRedactor`；
- `IDryRunRunner`、`IDryRunRequest`、`IDryRunResult`（阶段 2 契约）。

## 附录 B：版本和边界声明

- 本文档描述的是当前源码已经导出的 SDK，而不是完整 v7 产品闭环。
- Engine 不自动保存正式脚本，不管理宿主的 `temp/`，不负责模型调用或 Agent 修复轮次。
- 任何执行候选代码的实现都必须在静态校验、工作区隔离、环境变量白名单、网络策略、超时、取消、进程终止和脱敏全部完成后再接入生产。
- 升级 Playwright 版本后，应重新验证 CLI 定位、Chromium 路径、headed/headless、route 行为、快照 API 和目标平台的资源释放。
- 生产发布前应在 Windows、macOS、Linux 分别验证 Chromium 安装取消、浏览器关闭和宿主临时目录清理。
