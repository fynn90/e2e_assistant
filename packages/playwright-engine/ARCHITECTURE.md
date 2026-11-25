<!-- 本文档说明 @charlie_deng/e2e-assistant-playwright-engine 的独立 SDK 架构、职责边界、模块设计和集成方式。 -->

# `@charlie_deng/e2e-assistant-playwright-engine` 独立 SDK 架构设计方案

- 方案版本：v1（对应平台 Version 7.0）
- 编写日期：2026-09-09
- 适用包：`packages/playwright-engine`
- 关联需求：[PRD/v7.md](../../PRD/v7.md)
- 关联技术方案：[PRD/v7-technical-design.md](../../PRD/v7-technical-design.md)
- 文档状态：架构设计，待实现评审

---

## 1. 设计结论

`@charlie_deng/e2e-assistant-playwright-engine` 是一个**与 Agent、Web 工作台和 Skill 存储解耦的 Playwright 能力 SDK**。它为上层应用提供浏览器自动化所需的最小、可组合且可测试的能力：

1. 检测本机 Playwright 浏览器运行时，并在缺失时通过 npm 包自身依赖完成 Chromium 安装；
2. 创建受生命周期控制的 Playwright 浏览器会话，支持有头观察模式和无头模式；
3. 在目标页面上进行受控导航、页面快照、元素查询和资源回收；
4. 对主动导航和页面运行时请求实施可配置的网络访问策略；
5. 在临时工作区中受控试运行候选 Playwright TypeScript 脚本，并提供超时、取消、环境变量白名单和进程树终止能力；
6. 对不可信的候选脚本执行静态语法、安全、导入、结构、环境变量和步骤覆盖校验；
7. 以统一的事件、错误和结果契约向宿主应用报告过程信息，而不绑定 SSE、Agent 会话或某一种 UI；
8. （v8 预留）执行调用方提供路径与名称的正式 Playwright 脚本，按配置规则把测试报告与截图、视频产物生成到调用方指定的目录；报告的管理和维护由宿主负责。

SDK **不负责**理解自然语言、调用大模型、编排 Agent、管理 Skill 文件、提供 HTTP API、实现侧边栏 Chat，也不直接决定何时保存正式脚本。平台可以使用这些能力组装 v7 的完整业务流程，但其他应用也可以只使用其中的浏览器会话、校验器或试运行器。

> 核心原则：Playwright Engine 负责“安全地驱动和验证浏览器及脚本”，宿主应用负责“决定为什么驱动、何时驱动以及结果如何呈现”。

---

## 2. 背景与问题定义

v7 将原有的文本推断式脚本生成升级为：

```text
页面核对 → 候选脚本生成 → 静态质量检查 → 受控试运行 → 有限修复 → 用户审阅保存
```

其中只有下列部分属于 Playwright Engine 的技术职责：

```text
Chromium 准备
    ↓
浏览器会话（headed/headless）
    ↓
页面导航、快照、元素查询
    ↓
网络访问限制
    ↓
候选脚本静态校验
    ↓
临时目录中的受控试运行
    ↓
运行结果脱敏与标准化
```

当前包已经具备一部分静态校验能力：

- `validation/playwright-script-validator.ts`：统一编排多个校验器；
- `validation/playwright-structure-validator.ts`：校验 `test`、`expect`、`page.goto` 和定位器；
- `validation/step-coverage-validator.ts`：按 `test.step(stepId)` 计算步骤覆盖；
- `validation/forbidden-api-validator.ts`：阻断动态执行、命令执行和任意文件写入；
- `validation/import-policy-validator.ts`：限制导入来源；
- `validation/environment-variable-validator.ts`：校验环境变量引用；
- `formatting/playwright-script-formatter.ts`：使用 TypeScript Printer 进行确定性格式化。

`runner.ts`、`recorder.ts` 和部分运行时事件能力目前仍是占位或基础实现。目标架构需要在保留现有校验兼容性的同时，将浏览器和试运行能力补齐，并把包从当前工程内部实现提升为独立 SDK。

---

## 3. 产品与 SDK 边界

### 3.1 SDK 负责的能力

| 能力               | 说明                                                                                             | 是否属于 v7 核心 |
| ------------------ | ------------------------------------------------------------------------------------------------ | ---------------- |
| Chromium 状态检测  | 判断 Playwright 所需浏览器是否可执行，返回可诊断状态                                             | 是               |
| Chromium 安装      | 使用包内 Playwright CLI 完成等价于 `playwright install chromium` 的安装                          | 是               |
| 浏览器会话         | 创建 context/page，支持有头/无头、导航、快照、查询、关闭                                         | 是               |
| 网络策略           | 限制主动导航和文档级跳转，支持必要子资源例外                                                     | 是               |
| 脚本静态校验       | 不执行代码地检查语法、安全和业务结构                                                             | 是               |
| 受控试运行         | 在隔离工作区中执行候选脚本并返回脱敏结果                                                         | 是               |
| 运行事件           | 标准化 console、network、error、生命周期事件                                                     | 是               |
| 正式执行与报告生成 | 执行调用方指定路径的正式脚本，按配置规则把测试报告与截图、视频产物生成到调用方指定目录（见 6.9） | 否，v8 预留      |
| 录制适配           | 为调用方提供可插拔录制能力的接口，不承诺 v7 录制产品                                             | 否，保留扩展位   |
| 正式报告管理与维护 | 报告历史、查询、清理和展示由宿主系统负责；Engine 仅按 6.9 契约一次性生成报告与产物               | 否               |

### 3.2 SDK 明确不负责的能力

- 不持有或调用 LLM，不包含 Agent Loop、提示词或自动修复策略；
- 不读取 `e2e_schema.json`、`SKILL.md` 或任意 Skill 目录；
- 不管理 `temp/` 的业务生命周期，只接受宿主传入的受控工作区；
- 不实现生成任务状态机、SSE、WebSocket、侧边栏 Chat 或前端状态；
- 不决定候选脚本是否可以保存为正式 `test.spec.ts`；
- 不实现多用例编排、定时执行和 CI/CD 调度；不负责测试报告的管理与维护（历史、查询、清理、展示），仅按 6.9 的 v8 契约一次性生成报告与产物；
- 不把浏览器画面截图、录制或 Trace 上传到外部服务；
- 不以全局 PATH 中的 `playwright` 命令作为运行前提。

### 3.3 与平台模块的责任分工

```text
┌─────────────────────────────────────────────────────────────┐
│ apps/web                                                     │
│ 表单、确认提示、候选预览、差异展示、侧边栏 Chat              │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP/SSE 与业务状态
┌──────────────────────────────▼──────────────────────────────┐
│ apps/cli                                                     │
│ 生成流水线、并发锁、取消传播、Agent 注入、保存确认、事件映射 │
│ 对 Engine 仅使用 Chromium 检测/安装进行就绪检查              │
└─────────────┬─────────────────────────────┬─────────────────┘
              │ 业务编排                     │
┌─────────────▼────────────┐   ┌────────────▼────────────────┐
│ packages/agent            │   │ packages/skill-manager       │
│ （Engine 主要调用方）    │   │ Skill 文件、temp、版本和原子写 │
│ 页面核对、脚本生成、     │   └────────────┬────────────────┘
│ 校验、试运行、修复       │                 │ 受控工作区
└─────────────┬────────────┘                 │
              │ SDK 接口                    │
              └──────────────┬───────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ @charlie_deng/e2e-assistant-playwright-engine                         │
│ 浏览器、Chromium、网络策略、静态校验、受控试运行、运行事件    │
└─────────────────────────────────────────────────────────────┘
```

调用关系约定：`packages/agent` 是 Engine 的**主要调用方**，页面核对的浏览器会话、候选脚本静态校验和受控试运行都由 Agent 侧的生成运行时直接调用 Engine；`apps/cli` 对 Engine 的直接调用仅限 Playwright 就绪检查——检查用户本机 Playwright 状态、检测 Chromium 是否可执行并在缺失时安装，不直接调用浏览器会话、校验器和试运行器；`apps/web` 与 `packages/skill-manager` 不直接依赖 Engine。

SDK 不应反向依赖 `apps/cli`、`packages/agent` 或 `packages/skill-manager`。宿主通过接口和回调注入策略、日志、进度与工作区。

---

## 4. 架构原则

### 4.1 独立性优先

公共 API 不暴露 Hono、Vue、Pi Agent、SSE 或平台内部存储类型。SDK 可以在以下场景独立使用：

- CLI 脚本生成器；
- 桌面应用；
- CI 任务；
- 测试开发工具；
- 其他 Agent 框架；
- 不使用 Skill 概念的普通 Playwright 工具链。

### 4.2 能力组合而非大而全的门面

浏览器会话、安装器、网络策略、静态校验器和试运行器必须可以单独实例化。统一门面只负责组装默认实现，不把所有能力强制绑定在一起。

### 4.3 依赖倒置

- 上层依赖 `IBrowserSession`、`IDryRunRunner`、`IChromiumInstaller` 等接口；
- 真实 Playwright 实现是基础设施适配器；
- 测试使用 fake session、fake process adapter 和 fixture server；
- 事件通过 `IEngineEventSink` 输出，不由 SDK 直接写日志或推送网络。

### 4.4 默认安全，显式放宽

- 未配置允许模块时只允许 `@playwright/test`；
- 未声明的环境变量不透传；
- 不允许动态执行、命令执行和任意文件写入；
- 不允许主动导航到非 `baseUrl` 同源的文档地址；
- 超时、取消和资源释放均有默认值；
- 扩展能力必须通过显式配置开启，并经过宿主的安全评审。

### 4.5 不把试运行伪装成正式执行

试运行结果只表示当前候选脚本在当前环境和约束下的验证结果。SDK 返回 `passed`、`failed` 或 `skipped`，但不生成“正式测试报告已完成”的语义，也不自动写入正式业务文件。

### 4.6 可观测但不泄密

事件和错误应包含阶段、耗时、错误码、选择器或断言摘要等诊断信息；不得默认包含密码、Token、API Key、环境变量真实值、完整页面内容或不必要的绝对路径。

---

## 5. 目标目录结构

建议将包组织为以下边界清晰的模块。目录名是推荐实现，不要求宿主了解内部文件布局；宿主只依赖根入口导出的公共契约。

```text
packages/playwright-engine/
├── package.json
├── README.md
├── ARCHITECTURE.md
├── tsconfig.json
├── src/
│   ├── index.ts                         # 稳定公共导出
│   ├── engine.ts                        # 默认实现组装门面
│   ├── contracts/
│   │   ├── browser.ts                   # 浏览器会话契约
│   │   ├── chromium.ts                  # 浏览器安装契约
│   │   ├── dry-run.ts                   # 试运行契约
│   │   ├── formal-run.ts                # 正式执行与报告契约（v8 预留）
│   │   ├── network.ts                   # 网络策略契约
│   │   ├── validation.ts                # 校验契约
│   │   ├── events.ts                    # 事件契约
│   │   └── errors.ts                    # 错误码与错误类型
│   ├── chromium-installer/
│   │   ├── chromium-installer.ts        # Playwright 包内 CLI 安装器
│   │   ├── chromium-detector.ts         # 可执行文件检测
│   │   └── install-process.ts           # 跨平台进程适配
│   ├── browser-session/
│   │   ├── playwright-browser-session.ts
│   │   ├── page-snapshot.ts             # 无障碍树和候选定位器压缩
│   │   └── browser-session-factory.ts
│   ├── network-policy/
│   │   ├── same-origin-policy.ts
│   │   ├── route-policy.ts
│   │   └── url-utils.ts
│   ├── dry-run/
│   │   ├── playwright-dry-run-runner.ts
│   │   ├── test-config-builder.ts
│   │   ├── process-runner.ts
│   │   ├── output-parser.ts
│   │   └── output-sanitizer.ts
│   ├── validation/
│   │   ├── playwright-script-validator.ts
│   │   ├── playwright-structure-validator.ts
│   │   ├── step-coverage-validator.ts
│   │   ├── environment-variable-validator.ts
│   │   ├── forbidden-api-validator.ts
│   │   ├── import-policy-validator.ts
│   │   ├── typescript-parser.ts
│   │   ├── typescript-semantic-validator.ts
│   │   ├── validation-types.ts
│   │   └── ast-utils.ts
│   ├── formatting/
│   │   └── playwright-script-formatter.ts
│   ├── observability/
│   │   ├── event-sink.ts
│   │   ├── runtime-event-collector.ts
│   │   └── redaction.ts
│   ├── recorder/
│   │   └── recorder-adapter.ts          # 可选扩展，不属于 v7 主流程
│   └── runner/
│       └── formal-runner-adapter.ts     # 正式执行与报告生成适配（v8 预留，见 6.9）
└── test/
    ├── chromium-installer.test.ts
    ├── browser-session.test.ts
    ├── network-policy.test.ts
    ├── dry-run-runner.test.ts
    ├── validation/*.test.ts
    └── fixtures/
```

现有校验文件可以保留原路径以降低迁移成本；新增 `contracts/` 和能力目录时，通过根入口重新导出，不让调用方依赖深层路径。

---

## 6. 核心模块设计

### 6.1 SDK 门面与工厂

**职责**：组装默认实现、校验配置、暴露能力入口，不承载业务流程。

推荐形态：

```ts
export interface IPlaywrightEngine {
  chromium: IChromiumInstaller
  browser: IBrowserSessionFactory
  dryRun: IDryRunRunner
  validator: IPlaywrightScriptValidator
}

export interface IPlaywrightEngineOptions {
  playwright?: IPlaywrightRuntime
  testRunner?: ITestRunnerRuntime
  defaults?: IEngineDefaults
  eventSink?: IEngineEventSink
  redactor?: ISensitiveDataRedactor
}

export function createPlaywrightEngine(
  options?: IPlaywrightEngineOptions,
): IPlaywrightEngine
```

设计要求：

- 默认实现可以直接使用，但每项能力都可替换；
- 工厂不自动启动浏览器、不自动安装 Chromium、不自动执行脚本；
- 每个有副作用的方法都需要由调用方显式调用；
- 配置对象只包含 SDK 能理解的运行配置，不接收整个平台配置或 Agent 会话对象。

### 6.2 `chromium-installer`：浏览器运行时准备

#### 6.2.1 主要用途

确认 Playwright 浏览器可执行，并在缺失时使用当前 npm 包依赖中的 Playwright CLI 安装 Chromium。该模块是本地运行时能力，不依赖用户全局安装 `playwright` 命令。

#### 6.2.2 公共契约

```ts
export interface IChromiumStatus {
  installed: boolean
  executablePath: string | null
  version?: string
  reason?: 'missing' | 'permission-denied' | 'invalid-path' | 'unknown'
}

export interface IInstallChromiumOptions {
  signal?: AbortSignal
  timeoutMs?: number
  browsersPath?: string
  onProgress?: (event: IChromiumInstallProgress) => void
}

export interface IChromiumInstallProgress {
  phase: 'resolving-cli' | 'downloading' | 'extracting' | 'verifying'
  message: string
  completed?: number
  total?: number
}

export interface IChromiumInstaller {
  detect(options?: { browsersPath?: string }): Promise<IChromiumStatus>
  install(options?: IInstallChromiumOptions): Promise<IChromiumStatus>
}
```

#### 6.2.3 实现策略

1. 通过 `import { chromium } from 'playwright'` 获取运行时入口；
2. 使用 `chromium.executablePath()` 和文件系统访问检查主 Chromium；
3. 使用 `createRequire(import.meta.url)` 定位包内 `playwright/cli.js`，不调用 PATH 中的命令；
4. 使用当前 Node 进程启动 CLI：`node <resolved-cli> install chromium`；
5. 保留必要的 Playwright 环境变量，允许宿主显式指定 `PLAYWRIGHT_BROWSERS_PATH`；
6. 逐行处理安装输出，禁止直接把原始输出写入 SDK 日志；
7. 安装完成后重新检测并返回最终状态；
8. 同一进程内以共享 Promise 避免并发重复安装；
9. Windows 取消时终止整个子进程树，macOS/Linux 使用进程组或等价机制；
10. 将网络、权限、磁盘、取消和超时映射为结构化错误原因。

#### 6.2.4 明确边界

- SDK 不分发 Chromium 二进制文件；
- SDK 不绕过用户代理、网络策略或系统权限；
- 自动安装失败时不得继续调用模型或启动页面核对；
- 安装器不负责持久化安装日志。

### 6.3 `browser-session`：页面核对与浏览器生命周期

#### 6.3.1 主要用途

为页面核对、元素定位和浏览器观察提供一个可控的会话抽象。它隐藏 Playwright 的 browser/context/page 组合，确保所有资源由同一所有者关闭。

#### 6.3.2 公共契约

```ts
export interface IBrowserSessionOptions {
  headed?: boolean
  baseUrl: string
  timeoutMs?: number
  navigationTimeoutMs?: number
  networkPolicy?: INetworkPolicy
  signal?: AbortSignal
  eventSink?: IEngineEventSink
}

export interface IBrowserSession {
  readonly id: string
  readonly headed: boolean
  readonly baseUrl: string
  navigate(url: string): Promise<IPageSnapshotRef>
  snapshot(options?: ISnapshotOptions): Promise<IPageSnapshot>
  query(selector: string): Promise<IElementInfo[]>
  close(): Promise<void>
}

export interface IPageSnapshot {
  url: string
  title: string
  a11yTree: string
  candidateLocators: ICandidateLocator[]
  truncated: boolean
  capturedAt: string
}

export interface ICandidateLocator {
  role?: string
  name?: string
  label?: string
  placeholder?: string
  testId?: string
  text?: string
  css?: string
  confidence?: number
}
```

#### 6.3.3 会话规则

- `headed: true` 映射为有头启动，只允许用户观察；
- `headed: false` 或缺失映射为无头模式；
- 两种模式都显式使用完整 Chromium（`channel: 'chromium'`）：无头若走默认的
  `chromium-headless-shell`，在无控制台的宿主进程里会被 Windows 新建控制台黑窗；
  完整浏览器同时保证生成（无头）与执行（有头）使用同一浏览器构建。
- 试运行器不得复用用于观察的有头会话；
- `navigate` 只允许 `baseUrl` 同源的主动文档导航；
- `snapshot` 优先返回压缩后的可访问性树和候选定位器，而不是无界完整 DOM；
- 长页面必须截断并标记 `truncated`，让上层决定是否提示信息不足；
- `query` 只返回结构化元素信息，不把页面对象泄露给 Agent 或宿主业务层；
- `close` 必须幂等，并关闭 context 与 browser；
- `AbortSignal` 触发后，未完成的导航、快照和查询应尽快失败并释放资源；
- 浏览器断连应映射为 `BROWSER_SESSION_DISCONNECTED`，不得被当作生成成功。

#### 6.3.4 页面内容安全

页面文字、属性和可访问性树均属于不可信输入。SDK 只负责采集和压缩，不执行页面文本中的指令，也不允许页面内容改变网络策略、文件边界或脚本校验规则。

### 6.4 `network-policy`：网络访问控制

#### 6.4.1 主要用途

在浏览器导航和试运行期间限制主动访问范围，落实 v7 要求的“`baseUrl` 及其同源地址，必要时放行页面所需跨源子资源”。

#### 6.4.2 公共契约

```ts
export interface INetworkPolicy {
  assertNavigable(url: string): void
  isAllowedDocument(url: string, baseUrl: string): boolean
  installRoute(
    context: BrowserContext,
    options: INetworkRouteOptions,
  ): Promise<void> | void
}

export interface INetworkRouteOptions {
  baseUrl: string
  allowSubresources?: boolean
  allowedOrigins?: ReadonlySet<string>
}
```

#### 6.4.3 默认策略

- 解析并规范化 `baseUrl`，只允许 HTTP/HTTPS；
- 主动导航的 `origin` 必须与 `baseUrl` 相同；
- 同源文档重定向允许跟随；
- 非同源的主动文档导航阻断并返回 `NETWORK_DOCUMENT_BLOCKED`；
- `script`、`style`、`img`、`font`、媒体以及页面正常工作所需的 XHR/fetch 等子资源可以按策略放行；
- 不允许通过“子资源例外”主动打开异源页面；
- 路由处理必须区分资源类型，不能简单按 hostname 全部放行；
- 每次阻断产生脱敏事件，便于宿主说明原因。

#### 6.4.4 安全限制说明

浏览器路由策略主要控制页面上下文网络访问。为防止候选 Node.js 代码绕过该策略，必须同时使用：

1. 静态导入白名单；
2. 动态 import/require 禁止；
3. `child_process`、文件写入和进程控制 API 禁止；
4. 试运行工作目录和环境变量隔离；
5. 子进程超时与强制终止。

因此网络策略不能单独被宣称为任意代码沙箱；它是纵深防御中的一层。

### 6.5 `validation`：候选脚本静态质量门禁

#### 6.5.1 主要用途

在任何候选脚本进入试运行前，使用 TypeScript AST 和内存语义检查完成不执行代码的质量与安全门禁。

#### 6.5.2 当前及目标校验器

| 校验器                        | 规则                                            | 默认严重级别 |
| ----------------------------- | ----------------------------------------------- | ------------ |
| TypeScript parser             | 语法可解析                                      | error        |
| TypeScript semantic validator | 基础类型语义无错误                              | error        |
| Import policy validator       | 仅允许 `@playwright/test` 和显式模块            | error        |
| Forbidden API validator       | 阻断 eval、Function、命令、文件写入、进程退出等 | error        |
| Structure validator           | `test`、`page`、`expect`、`page.goto` 和标题    | error        |
| Step coverage validator       | 每个启用步骤恰好覆盖，含操作和断言              | error        |
| Environment validator         | 用例声明与 `process.env` 引用完全一致           | error        |
| Locator quality check         | XPath、深层 CSS、动态选择器提示                 | warning      |
| Fixed wait check              | `waitForTimeout` 提示                           | warning      |
| Formatter                     | 统一输出格式，不执行代码                        | 无           |

#### 6.5.3 公共契约

```ts
export interface IPlaywrightValidationOptions {
  testCase: IValidationTestCase
  allowedModules?: readonly string[]
  requiredEnvironmentVariables?: readonly string[]
  policy?: IValidationPolicy
}

export interface IPlaywrightValidationResult {
  valid: boolean
  code: string
  errors: IPlaywrightValidationIssue[]
  warnings: IPlaywrightValidationIssue[]
  stepCoverage: IPlaywrightStepCoverage[]
  environmentVariables: string[]
}

export interface IPlaywrightScriptValidator {
  validate(
    code: string,
    options: IPlaywrightValidationOptions,
  ): IPlaywrightValidationResult
}
```

#### 6.5.4 类型自包含，不依赖平台类型包

SDK 的全部公共类型（校验输入、校验结果、事件、错误码和各能力契约）都在本包内定义，**不依赖 `@charlie_deng/e2e-assistant-types`**。校验输入使用 SDK 自己的最小 `IValidationTestCase`：

```ts
export interface IValidationTestCase {
  title: string
  baseUrl: string
  steps: readonly {
    id: string
    order: number
    enabled: boolean
  }[]
  environmentVariables?: readonly string[]
}
```

宿主（如 `packages/agent`、`apps/cli`）持有的平台侧用例数据，应在宿主侧通过纯数据适配器转换为 `IValidationTestCase` 后再传入 SDK，转换函数由平台提供。`playwright-engine` 不应依赖 `@charlie_deng/e2e-assistant-types`、Skill、应用服务或平台数据库类型。

#### 6.5.5 门禁结果规则

- 任意 `error` 都禁止试运行和保存；
- 只有 `warning` 时允许继续，但必须由宿主展示；
- 返回的 `code` 是格式化后的快照，不覆盖宿主正式文件；
- 校验器永不 `require`、`import` 或执行候选脚本；
- 校验器不得将环境变量真实值放入 issue、日志或结果。

### 6.6 `dry-run`：受控脚本试运行

#### 6.6.1 主要用途

对静态校验通过的候选脚本进行一次有限的本机验证。该模块只执行宿主明确传入的候选快照，不读取正式 Skill 文件，也不决定修复轮次。

#### 6.6.2 公共契约

```ts
export interface IDryRunRequest {
  workspaceDir: string
  specCode: string
  baseUrl: string
  envWhitelist: Readonly<Record<string, string>>
  networkPolicy?: INetworkPolicy
  timeout?: IDryRunTimeouts
  signal?: AbortSignal
  eventSink?: IEngineEventSink
}

export interface IDryRunTimeouts {
  testMs?: number // 默认 60_000
  overallMs?: number // 默认 180_000
  shutdownMs?: number
}

export interface IDryRunResult {
  status: 'passed' | 'failed' | 'skipped'
  attempts: number
  exitCode: number | null
  durationMs: number
  sanitizedOutput: string
  failure?: IDryRunFailure
}

export interface IDryRunFailure {
  kind:
    | 'assertion'
    | 'selector'
    | 'navigation'
    | 'timeout'
    | 'cancelled'
    | 'infrastructure'
  message: string
  file?: string
  line?: number
}

export interface IDryRunRunner {
  run(request: IDryRunRequest): Promise<IDryRunResult>
}
```

#### 6.6.3 执行流程

```text
接收候选源码快照
        ↓
确认工作区位于宿主指定的临时目录
        ↓
写入临时 spec/config/setup 文件
        ↓
构造白名单环境变量
        ↓
启动本地 @playwright/test CLI
        ↓
安装网络路由与超时控制
        ↓
消费 JSON reporter / 进程输出
        ↓
脱敏并归一化结果
        ↓
终止或等待所有子资源释放
        ↓
返回结果（不负责删除宿主工作区）
```

#### 6.6.4 工作区边界

- `workspaceDir` 必须由宿主创建并经过路径校验；
- SDK 只能创建约定的临时文件名，不能访问工作区外路径；
- 试运行不会写 `e2e_schema.json`、`SKILL.md` 或正式 `test.spec.ts`；
- 产物、日志和配置只写入临时工作区；
- SDK 返回结果前应关闭文件句柄和运行进程；
- 临时目录的删除由宿主的生命周期管理器执行，以便与 Skill 锁和其他资源协调。

#### 6.6.5 环境变量隔离

子进程环境由最小系统环境与 `envWhitelist` 合并生成：

```text
必要运行时变量（PATH、SystemRoot 等）
                         +
用例明确声明的 E2E_USERNAME/E2E_PASSWORD 等变量
                         ↓
候选脚本子进程 env
```

未声明的用户环境变量不得透传。真实值只能短暂存在于子进程环境和内存中，不得进入事件、结果、异常、报告或元数据。

#### 6.6.6 取消、超时与终止

- 单次测试超时控制 Playwright 测试级别；
- 整体超时控制试运行进程生命周期；
- `AbortSignal` 触发后先发送温和终止，再在宽限期后强制终止；
- Windows 使用 `taskkill /T /F` 处理进程树；
- macOS/Linux 使用进程组或等价的树终止方式；
- 终止完成后才向宿主报告可清理状态；
- 取消结果为 `skipped` 或 `failed(kind: 'cancelled')`，具体由宿主策略选择，但不得返回 passed。

### 6.7 `observability`：运行事件和脱敏

#### 6.7.1 主要用途

为宿主提供与 UI、SSE、日志系统无关的事件源。SDK 只发出标准化事件，不保存事件历史。

```ts
export type TEngineEvent =
  | { type: 'browser.started'; sessionId: string; headed: boolean }
  | { type: 'browser.navigation'; sessionId: string; url: string }
  | { type: 'browser.snapshot'; sessionId: string; truncated: boolean }
  | { type: 'network.blocked'; url: string; resourceType: string }
  | { type: 'dry-run.started'; workspaceId: string }
  | { type: 'dry-run.output'; message: string }
  | { type: 'dry-run.finished'; status: 'passed' | 'failed' | 'skipped' }
  | { type: 'process.cancelled'; component: string }
  | { type: 'engine.error'; code: TPlaywrightEngineErrorCode; message: string }

export interface IEngineEventSink {
  publish(event: TEngineEvent): void | Promise<void>
}
```

#### 6.7.2 脱敏顺序

任何输出进入事件、错误或 `IDryRunResult` 前必须经过：

1. 替换已知环境变量真实值；
2. 过滤 Token、API Key、密码等常见秘密模式；
3. 过滤用户目录、工作区绝对路径和临时路径；
4. 限制输出长度；
5. 仅保留诊断所需的选择器、断言和阶段信息。

脱敏器应支持宿主注入额外秘密值，但 SDK 默认不能假定某个具体业务系统的凭据格式。

### 6.8 `recorder` 与 `runner`：非 v7 核心扩展位

当前包已存在 `recorder.ts`、`runner.ts` 和 `interceptor.ts`，但其中部分能力是占位实现。为避免这些模块模糊 v7 的职责，建议：

- `recorder` 定义为可选的录制适配器；v7 不启用录制、回放或持久化；
- `runner` 区分“生成期 dry-run”和“后续正式执行”；正式执行需要独立的报告、产物和权限模型，预留契约见 6.9；
- `interceptor` 统一为运行时事件采集和网络策略适配，不承担业务消息总线；
- 在 v7 中，`runTest` 不应被误用为正式执行入口；可以改名为 `IDryRunRunner.run`，或保留兼容导出但明确其能力和限制。

### 6.9 `formal-runner`（v8 预留）：正式执行与测试报告生成

> 本节为 v8 预留设计，v7 不实现。接口为草案，落地前需随 v8 PRD 评审定稿。

#### 6.9.1 主要用途

执行调用方提供的正式 Playwright 脚本，并根据执行情况生成一次性的测试报告。调用方提供具体的脚本路径、脚本名称和报告保存目录；Engine 执行脚本、生成报告文件，并按配置的规则把截图、视频等产物保存到该目录。**Engine 只做报告生成，不做报告的管理和维护**：报告历史、查询、清理、版本和展示都由宿主负责。

#### 6.9.2 职责边界

调用方（宿主）负责：

- 提供待执行脚本的**具体路径**和**脚本名称**（例如 `<skill>/e2e/test.spec.ts` 与 `test.spec.ts`）；
- 提供**保存测试报告的目录**，并决定其创建时机、保留策略、清理和展示；
- 提供截图、视频等产物的保存规则配置。

Engine 负责：

- 校验脚本路径与报告目录的路径边界和可写性；
- 执行指定的正式脚本（只读取执行，不修改脚本内容）；
- 根据执行情况生成测试报告文件；
- 按配置规则把截图、视频等产物写入报告目录；
- 返回结构化执行结果，以及报告和产物的文件路径。

Engine 不负责：

- 不维护报告历史，不提供报告的查询、删除、版本管理和定时清理；
- 不自动删除或覆盖调用方目录中的既有报告；
- 不上传、不外发报告与产物；
- 不实现多用例编排、定时执行和 CI/CD 调度。

#### 6.9.3 公共契约（草案）

```ts
export interface IFormalRunRequest {
  /** 待执行的正式脚本路径，由调用方提供 */
  scriptPath: string
  /** 脚本名称（如 test.spec.ts），用于报告命名与展示，由调用方提供 */
  scriptName: string
  /** 测试报告保存目录，由调用方提供并拥有 */
  reportDir: string
  /** 报告与产物生成规则 */
  report?: IFormalRunReportOptions
  baseUrl?: string
  envWhitelist?: Readonly<Record<string, string>>
  timeout?: IDryRunTimeouts
  signal?: AbortSignal
  eventSink?: IEngineEventSink
}

export interface IFormalRunReportOptions {
  /** 报告格式，默认 'html' */
  format?: 'html' | 'json'
  /** 截图采集规则，默认 'only-on-failure' */
  screenshot?: 'off' | 'only-on-failure' | 'on'
  /** 视频采集规则，默认 'off' */
  video?: 'off' | 'retain-on-failure' | 'on'
  /** Trace 采集规则，默认 'off' */
  trace?: 'off' | 'retain-on-failure' | 'on'
  /** 产物目录组织方式：按执行批次 / 按用例 / 平铺，默认 'by-run' */
  artifactsLayout?: 'by-run' | 'by-test' | 'flat'
}

export interface IFormalRunResult {
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  /** 生成的报告入口文件路径 */
  reportFilePath: string
  /** 按规则生成的截图、视频等产物路径列表 */
  artifactFilePaths: string[]
  /** 脱敏后的失败摘要，结构复用 IDryRunFailure */
  failure?: IDryRunFailure
}

export interface IFormalRunner {
  run(request: IFormalRunRequest): Promise<IFormalRunResult>
}
```

#### 6.9.4 目录与产物规则

- `scriptPath` 必须指向调用方已保存的正式脚本；Engine 不回写、不格式化正式脚本；
- `reportDir` 由调用方创建并拥有，Engine 校验可写后只向该目录写入报告与产物，不触碰目录外路径；
- 报告与产物默认按执行批次子目录组织并使用时间戳命名，避免覆盖既有报告；目录中旧报告的去留由调用方决定；
- 截图、视频、Trace 按 `report` 配置的规则采集，未配置时使用保守默认值（少采集）；
- 执行完成、失败或取消后，先释放浏览器与子进程句柄，再返回报告与产物路径；
- 报告内容复用统一脱敏，不包含环境变量真实值和本机敏感绝对路径。

#### 6.9.5 与 v7 能力的复用关系

- 超时、取消、进程树终止、环境变量白名单和输出脱敏与 `dry-run` 共用同一套基础设施；
- v8 门面在 `IPlaywrightEngine` 上增加 `formalRun: IFormalRunner` 能力入口；
- 事件契约在 v8 扩展 `formal-run.started`、`formal-run.output`、`formal-run.finished`；错误码扩展 `FORMAL_RUN_FAILED`、`FORMAL_RUN_CANCELLED`、`FORMAL_RUN_TIMEOUT`、`REPORT_GENERATION_FAILED`；
- 与 dry-run 的关键差异：正式执行读取调用方指定路径的正式脚本（不再写入候选快照），且结果携带完整报告与产物路径——产物目录归调用方持有，返回路径需经过统一路径规范化。

---

## 7. 端到端集成流程

### 7.1 v7 生成任务中的调用顺序

SDK 的推荐调用顺序如下。其中 Chromium 就绪检查（`engine.chromium.detect/install`）由 `apps/cli` 在生成任务开始前执行；其余步骤由 `packages/agent` 的生成运行时执行。自动修复轮次由 Agent 侧编排，SDK 不自行重试模型。

```text
宿主校验业务输入和版本
        ↓
engine.chromium.detect()（apps/cli：Playwright 就绪检查）
        ↓ 缺失
engine.chromium.install({ signal, onProgress })
        ↓ 以下由 packages/agent 生成运行时执行
engine.browser.create({
  baseUrl,
  headed: browserVisualization === true,
  networkPolicy,
  signal,
})
        ↓
session.navigate(baseUrl)
session.snapshot()
session.query(...)
        ↓
Agent/其他生成器产出候选脚本快照
        ↓
engine.validator.validate(code, validationOptions)
        ↓ valid
engine.dryRun.run({
  workspaceDir: tempDir,
  specCode: validatedCode,
  baseUrl,
  envWhitelist,
  networkPolicy,
  signal,
})
        ↓
宿主根据失败摘要决定是否调用 Agent 修复
        ↓
finally: dry-run 进程释放 → session.close()
```

### 7.2 有头与无头模式

| 场景                    | `browserVisualization` | Engine 行为                                         |
| ----------------------- | ---------------------- | --------------------------------------------------- |
| 页面核对                | `true`                 | 启动有头 Chromium，允许用户观察，不提供用户操控入口 |
| 页面核对                | `false` 或缺失         | 启动无头 Chromium，不显示调试窗口                   |
| 生成期试运行            | 任意值                 | 独立使用无头执行上下文，不打开调试页面              |
| 任务完成/失败/取消/断连 | 任意值                 | 宿主调用 `close()`，浏览器和页面资源全部释放        |

SDK 不负责监听“用户离开页面”。宿主必须在页面离开、会话断连或任务取消时触发统一的 `AbortController` 和资源清理流程。

### 7.3 有限自动修复的职责边界

- SDK 提供校验结果和脱敏试运行失败摘要；
- SDK 不知道模型、提示词或修复策略；
- 宿主可按 PRD 设置结构/输出修复最多 1 次、试运行失败修复最多 2 次；
- 每次修复后的代码必须重新经过 `validator.validate`，通过后才能再次 `dryRun.run`；
- SDK 不自动保存正式脚本。

### 7.4 临时目录协作

`temp/` 的所有权属于宿主的工作区管理模块，Engine 只拥有调用期间的受限使用权：

```text
宿主创建并锁定 temp/
        ↓
Engine 写入候选/配置/试运行文件
        ↓
Engine 释放子进程和浏览器句柄
        ↓
宿主删除 temp/
```

如果 Engine 发现工作区不可写、路径越界或文件句柄无法释放，应返回 `TEMP_WORKSPACE_ERROR` 或资源释放错误；宿主不能将该任务显示为成功。

---

## 8. 错误模型

错误必须是可分类、可脱敏、可被宿主映射为 UI/API 文案的结构化错误。

```ts
export type TPlaywrightEngineErrorCode =
  | 'BROWSER_NOT_INSTALLED'
  | 'BROWSER_INSTALL_FAILED'
  | 'BROWSER_INSTALL_CANCELLED'
  | 'BROWSER_INSTALL_TIMEOUT'
  | 'BROWSER_SESSION_START_FAILED'
  | 'BROWSER_SESSION_DISCONNECTED'
  | 'PAGE_ACCESS_FAILED'
  | 'PAGE_NAVIGATION_BLOCKED'
  | 'NETWORK_DOCUMENT_BLOCKED'
  | 'SCRIPT_VALIDATION_FAILED'
  | 'DRY_RUN_FAILED'
  | 'DRY_RUN_CANCELLED'
  | 'DRY_RUN_TIMEOUT'
  | 'FORMAL_RUN_FAILED' // v8 预留
  | 'FORMAL_RUN_CANCELLED' // v8 预留
  | 'FORMAL_RUN_TIMEOUT' // v8 预留
  | 'REPORT_GENERATION_FAILED' // v8 预留
  | 'TEMP_WORKSPACE_ERROR'
  | 'PROCESS_TERMINATION_FAILED'
  | 'ENGINE_CONFIGURATION_INVALID'

export interface IPlaywrightEngineErrorDetails {
  component:
    | 'chromium'
    | 'browser'
    | 'network'
    | 'validation'
    | 'dry-run'
    | 'formal-run'
    | 'workspace'
  retryable: boolean
  reason?: string
  durationMs?: number
}
```

错误信息规则：

- `message` 面向宿主和用户，不能含秘密值；
- 原始异常只在进程内用于诊断，不作为公共结果直接抛出；
- `retryable` 只表示 Engine 层面的重试建议，不代表宿主一定应该自动重试；
- 页面元素与用例语义不匹配不是 Engine 错误，应由 Agent/宿主以 warning 或 assumption 表达；
- 页面完全不可访问才映射为 `PAGE_ACCESS_FAILED`；
- 静态校验硬错误不得进入 dry-run。

---

## 9. 资源所有权与生命周期

### 9.1 所有权表

| 资源                 | 创建者                  | 使用者     | 释放者                 | 释放时机               |
| -------------------- | ----------------------- | ---------- | ---------------------- | ---------------------- |
| Chromium 安装进程    | Engine                  | Engine     | Engine                 | 安装完成、取消、失败   |
| Browser/Context/Page | 宿主通过 Engine factory | Agent/宿主 | 宿主调用 session.close | 所有任务终态           |
| dry-run 子进程       | Engine                  | Engine     | Engine                 | 完成、取消、超时、异常 |
| `temp/` 目录         | 宿主                    | Engine     | 宿主                   | Engine 资源释放后      |
| 事件订阅             | 宿主                    | 宿主       | 宿主                   | 会话结束               |

### 9.2 `finally` 约束

宿主编排任务应保证以下顺序：

```text
AbortController 触发
        ↓
终止 dry-run 子进程树
        ↓
关闭 browser session
        ↓
释放任务锁
        ↓
清理 temp/
        ↓
发布最终状态
```

Engine 内部方法自身也必须使用 `try/finally` 释放它创建的进程、监听器和临时文件句柄。`close()` 和进程终止接口必须幂等，以适应取消与异常并发到达的情况。

---

## 10. 安全设计

### 10.1 候选代码安全

候选脚本被视为不可信代码。安全门禁采用多层策略：

```text
AST 语法检查
    + 导入白名单
    + 禁止动态执行/命令/文件/进程 API
    + TypeScript 语义检查
    + 工作区路径隔离
    + 环境变量白名单
    + 浏览器网络策略
    + 单次/整体超时
    + 取消与进程树强杀
```

任何一层失败都不能被“模型说明”或页面内容覆盖。

### 10.2 网络安全

- 主动文档导航限制为 `baseUrl` 同源；
- 页面必要子资源可按默认策略放行；
- 非同源文档跳转阻断并反馈原因；
- 候选脚本不能通过导入 Node 网络客户端绕过浏览器策略；
- 自定义 `allowedModules` 必须由宿主显式配置，不应接受模型输出直接决定。

### 10.3 凭据安全

- 脚本只保留 `process.env.NAME` 引用；
- 结果只保留变量名，不保留真实值；
- 安装、页面、试运行和事件输出统一脱敏；
- 不把用户完整 `process.env` 复制到子进程；
- 不把有头页面截图、视频、Trace 或完整 DOM 自动上传或持久化。

### 10.4 文件安全

- 所有 SDK 写入路径必须经过 `resolve`、根目录包含检查和符号链接防护；
- 禁止绝对路径、`..` 越界路径和未允许的文件名；
- Engine 不拥有正式 Skill 文件的写权限；
- `workspaceDir` 不可信时立即返回配置或工作区错误。

### 10.5 限制声明

Playwright Engine 不是通用恶意代码沙箱。静态校验和受控执行边界用于降低生成脚本风险，但宿主仍应在用户明确确认、隔离测试数据和合适的操作系统权限下运行试运行任务。

---

## 11. 可测试性设计

### 11.1 单元测试

- **Chromium installer**：验证可执行路径检测、包内 CLI 定位、参数、进度、取消、超时和错误分类；使用 fake process adapter，不依赖公网；
- **Browser session**：验证 headed/headless 参数、导航、快照压缩、query、幂等 close 和断连；
- **Network policy**：验证同源文档放行、异源文档阻断、同源重定向、子资源例外；
- **Dry-run**：验证工作区路径、环境变量白名单、JSON reporter、脱敏、超时、取消和进程树终止；
- **Validation**：覆盖现有安全规则、步骤覆盖、环境变量、语法和警告；
- **Redactor**：验证已知秘密、Token、路径和超长输出不泄露。

### 11.2 集成测试

使用本地 fixture server 和真实 Playwright Chromium：

1. 启动同源页面和必要跨源静态资源；
2. 验证页面导航、a11y 快照和候选定位器；
3. 验证合法候选脚本可以 dry-run；
4. 验证跨源文档导航被阻断；
5. 验证试运行失败能返回可读且脱敏的摘要；
6. 验证取消后浏览器、进程和文件句柄均释放；
7. 验证 headed 会话在 close 后窗口消失；
8. 验证 Chromium 未安装时可使用包内 CLI 安装，且测试不依赖全局命令。

### 11.3 宿主集成测试

Engine 的责任测试与 CLI/Web 的业务测试分开：

- CLI 测试生成状态、Agent 注入、修复次数、SSE 映射和保存冲突；
- Skill Manager 测试 temp 创建、遗留清理、文件树隐藏和正式文件保护；
- Web 测试 `browserVisualization`、预览和侧边栏；
- E2E 测试完整 v7 闭环，但不把所有业务断言重复塞入 Engine 单测。

### 11.4 验收标准映射

| PRD 验收项 | Engine 交付物                               | 宿主配合                                  |
| ---------- | ------------------------------------------- | ----------------------------------------- |
| AC-01      | `chromium-installer`                        | 就绪检查、用户提示和安装状态              |
| AC-02      | browser session、snapshot、query 契约       | Agent 页面核对和候选生成                  |
| AC-03      | validation pipeline                         | 生成流程阻止硬错误进入试运行              |
| AC-04      | dry-run、network policy、env/timeout/cancel | 修复轮次和预览风险提示                    |
| AC-05      | 受限 workspace 写入约定                     | temp 所有权、终态清理                     |
| AC-06      | headed/headless session                     | `browserVisualization` 解析和离开页面取消 |
| AC-07      | 校验结果和 dry-run 摘要                     | 来源版本、差异和确认保存                  |
| AC-08      | redaction、env whitelist、禁止 API          | 日志、事件、元数据过滤                    |
| AC-09      | `IEngineEventSink`                          | agent-work 会话、SSE 和侧边栏展示         |

---

## 12. 发布与依赖策略

### 12.1 运行时依赖

建议运行时依赖包括：

- `playwright`：浏览器控制、Chromium 路径和 CLI；
- `@playwright/test`：阶段 2 候选脚本试运行 CLI 和测试 fixture（阶段 0/1 不引入）；
- `typescript`：AST 解析、语义检查和格式化；
- Node.js 内置模块：`fs/promises`、`child_process`、`url`、`module` 等。

SDK 的全部类型都在本包内定义，不依赖 `@charlie_deng/e2e-assistant-types` 等平台类型包。平台侧用例数据由宿主在调用前转换为 SDK 的最小输入契约（如 `IValidationTestCase`），转换函数由平台提供，不进入 Engine 的运行时依赖。

### 12.2 导出策略

根入口只导出稳定公共 API：

```ts
// 核心门面和工厂
export * from './engine'

// 能力契约
export * from './contracts/browser'
export * from './contracts/chromium'
export * from './contracts/dry-run'
export * from './contracts/network'
export * from './contracts/validation'
export * from './contracts/events'
export * from './contracts/errors'

// v8 预留契约
export * from './contracts/formal-run'

// 默认实现
export * from './browser-session/...'
export * from './chromium-installer/...'
export * from './dry-run/...'
export * from './network-policy/...'
export * from './validation/...'
```

不建议让用户依赖 `src/validation/ast-utils` 等内部深层路径。若保留 `recorder`、`runner` 兼容导出，应在 README 和类型命名中明确其能力状态。

### 12.3 版本兼容

- 新增配置字段和结果字段优先使用可选字段；
- 错误码新增不应改变既有成功结果结构；
- `IPlaywrightValidationResult` 的现有字段保持兼容；
- 破坏性调整应通过主版本升级；
- Playwright 主版本升级需重新验证 CLI 定位、Chromium 路径、JSON reporter、route 行为和 headed/headless 行为；
- 发布包必须包含 `dist`、类型声明和必要的运行时依赖，不依赖 Monorepo 源码路径。

### 12.4 平台与独立 SDK 的发布关系

```text
@charlie_deng/e2e-assistant-agent
        └── 主要调用 @charlie_deng/e2e-assistant-playwright-engine
            （浏览器会话、静态校验、受控试运行）

@charlie_deng/e2e-assistant-cli
        └── 仅调用 Chromium 检测/安装（Playwright 就绪检查）

其他 CLI / Desktop / CI tool
        └── can independently depend on @charlie_deng/e2e-assistant-playwright-engine
```

Engine 不应为了当前 CLI 的接口形式添加 HTTP 或 Chat 专用字段。平台版本迭代可以扩展适配器，而无需迫使其他 SDK 使用者安装 Agent、Web 或 Skill Manager。

---

## 13. 实施分阶段建议

### 阶段 0：契约与兼容层（已落地）

- [x] 补充独立的 contracts 类型；
- [x] 把现有校验类型与最小 SDK 类型对齐；
- [x] 统一错误码、事件和脱敏接口；
- [x] 保持现有 `PlaywrightScriptValidator` 测试通过；
- [x] 在根入口导出稳定契约。

交付文件包括 `src/contracts/`、`src/observability/redaction.ts` 和校验器适配；本包不再依赖 `@charlie_deng/e2e-assistant-types`。历史 `runner.ts`、`recorder.ts` 和 `interceptor.ts` 继续保留兼容导出，不代表 dry-run 或正式执行已完成。

### 阶段 1：浏览器基础能力（已落地）

- [x] 实现 Chromium detector/installer；
- [x] 实现 browser session factory、导航、snapshot、query、close；
- [x] 实现默认 same-origin network policy；
- [x] 添加本地 fixture 集成测试和 fake process 测试。

阶段 1 已覆盖有头/无头参数映射、包内 CLI 定位、安装取消/超时边界、同源文档阻断、子资源例外、页面快照有界输出和幂等资源释放。真实 Chromium 未安装的环境会跳过依赖本地浏览器的 fixture 用例，但仍执行 detector、installer fake 和网络策略测试。

### 阶段 0/1 与 `PRD/v7.md` 对照

| PRD 要求                             | 本包阶段 0/1 交付                                                              | 仍由宿主或后续阶段负责                                   |
| ------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| AC-01：Chromium 检测、无全局命令安装 | `ChromiumDetector`、包内 `playwright/cli.js` 定位、安装进度/取消/超时/错误分类 | CLI 的生成前环境检查、用户提示和失败后不请求模型         |
| AC-02：页面核对使用真实页面元素      | `IBrowserSession`、导航、快照、候选定位器和结构化查询                          | Agent 按步骤生成候选脚本并披露断点/假设                  |
| AC-03：候选脚本静态质量门禁          | 包内最小 `IValidationTestCase`、语法/安全/结构/步骤/环境变量校验和统一根入口   | 宿主阻止硬错误进入后续流程                               |
| AC-04/AC-05：受控试运行和 `temp/`    | 当前只提供 dry-run 契约；默认门面显式返回“阶段 2 未实现”，不执行候选代码       | 阶段 2 的 CLI、工作区、环境白名单、超时/进程树和宿主清理 |
| AC-06：有头/无头浏览器和终态关闭     | `headed` 映射 `headless: !headed`，会话 `close()` 幂等，取消/断连释放资源      | 宿主解析 `browserVisualization`，监听页面离开并触发取消  |
| AC-08：敏感信息保护                  | 事件、错误、URL、快照、查询结果使用脱敏边界；校验结果只返回环境变量名称        | 宿主实际环境变量注入、预览/日志/侧边栏过滤               |
| AC-09：生成过程事件                  | `IEngineEventSink` 和标准浏览器/网络/错误事件                                  | Agent/CLI 映射到生成任务、SSE 和侧边栏                   |

对照结果：本次任务范围内没有发现需要追加到阶段 0/1 的 Engine 能力；未实现项均属于阶段 2 dry-run 或宿主编排职责，不在本次仅修改 `playwright-engine` 的实施范围内。

### 阶段 2：受控试运行（未实现）

- [ ] 引入 `@playwright/test` 运行时依赖；
- [ ] 实现临时配置、JSON reporter、环境变量白名单；
- [ ] 实现跨平台取消、超时和进程树终止；
- [ ] 实现输出脱敏与标准化结果。

### 阶段 3：Agent/CLI 接入

- Agent 创建并持有 session，通过接口使用 navigate/snapshot/query；
- Agent 将校验器和 dry-run runner 接入生成流水线；
- CLI 仅接入 Chromium 就绪检查：检查用户本机 Playwright 状态、检测 Chromium 并在缺失时安装；
- 通过 `IEngineEventSink` 映射到 agent-work；
- 将取消和终态清理接入 generation-runtime。

### 阶段 4：v7 回归与发布

- 完成 PRD AC-01 至 AC-09 的回链测试；
- 回归 v5/v6 用例、Skill 和保存流程；
- 在无全局 Playwright 命令的环境中验证；
- 在 Windows、macOS、Linux 验证安装取消、进程终止和文件清理；
- 执行独立包 build、test、pack 和安装后 smoke test。

---

## 14. 关键架构决策记录

### ADR-01：不把 Agent 放入 Playwright Engine

**决策**：Engine 只提供确定性的浏览器和脚本执行能力，不包含模型循环。

**原因**：Agent 的模型、提示词、会话和修复策略会随产品变化；将其放入 Engine 会导致 SDK 与当前平台绑定，难以复用和测试。

### ADR-02：试运行与正式执行分离

**决策**：v7 只提供 dry-run 能力，正式执行和报告在后续独立模块实现。

**原因**：两者在权限、产物、历史、并发和用户预期上不同。混用会导致试运行结果被误认为正式报告。

### ADR-03：浏览器会话不暴露 Playwright 原始对象

**决策**：公共接口返回快照和元素信息，不返回 Browser、BrowserContext 或 Page。

**原因**：限制调用方越过网络、生命周期和数据边界；同时使 Agent 工具和单元测试可以使用 fake session。

### ADR-04：安装器定位包内 CLI

**决策**：通过当前 npm 依赖解析 `playwright/cli.js`，使用 Node 启动，不依赖全局命令。

**原因**：符合 npm 包在用户本机运行的产品要求，避免 PATH、shell 和全局版本差异造成失败。

### ADR-05：宿主拥有 temp 生命周期

**决策**：Engine 只使用宿主传入的临时工作区，宿主负责锁、终态清理和正式文件保护。

**原因**：Skill Manager 才知道业务文件、版本冲突和并发锁；Engine 不应直接修改或删除业务目录中的正式产物。

### ADR-06：静态校验是执行前硬门禁

**决策**：任何候选脚本必须先通过硬性校验，才能进入 dry-run。

**原因**：候选代码在用户审阅前会在本机执行，必须先阻断危险 API、越权导入、错误环境变量和不完整步骤。

### ADR-07：正式执行与测试报告“只生成、不管理”（v8 预留）

**决策**：v8 正式执行由调用方提供脚本路径、脚本名称和报告保存目录；Engine 执行脚本并一次性生成测试报告，截图、视频等产物按配置规则写入该目录。报告的历史、查询、清理和展示由宿主负责。

**原因**：报告生命周期与 Skill 版本、并发锁和用户预期强相关，属于业务决策；Engine 保持无状态、可独立复用，不应把存储与运维职责带入 SDK。

---

## 15. 完成定义

当以下条件全部满足时，认为 `playwright-engine` 达到 v7 架构交付要求：

- [ ] 根入口提供独立、稳定、可替换的 Chromium、浏览器、网络、校验和 dry-run API；
- [ ] Engine 不依赖 Agent、CLI、Web、Skill Manager 或 `@charlie_deng/e2e-assistant-types`，公共类型全部在本包定义；
- [ ] Chromium 检测和安装不依赖全局 `playwright` 命令；
- [ ] headed/headless 语义与 `browserVisualization` 对齐，试运行始终不打开调试页面；
- [ ] 浏览器会话、安装进程和试运行进程均支持取消、超时和幂等释放；
- [ ] 主动文档导航遵守同源策略，必要子资源例外可配置且有测试；
- [ ] 候选脚本通过静态硬性校验后才能执行；
- [ ] 试运行只使用工作区和声明环境变量，结果经过统一脱敏；
- [ ] Engine 不自动保存正式 `test.spec.ts`，不管理 v7 之外的业务状态；
- [ ] 真实 Playwright、fake adapter 和跨平台进程行为均有测试覆盖；
- [ ] 包可独立 build、pack，并在脱离 Monorepo 源码目录后被其他 Node.js 应用安装使用。

---

## 16. 与当前代码的迁移对照

| 当前代码                        | 目标归属                                             | 迁移说明                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runner.ts`                 | `dry-run/`（v7）与 `runner/formal-runner`（v8 预留） | dry-run 在 v7 落地；正式执行与报告生成按 6.9 契约在 v8 实现                                                                                  |
| `src/recorder.ts`               | `recorder/` 扩展位                                   | 保留兼容接口，v7 不接入录制闭环                                                                                                              |
| `src/interceptor.ts`            | `network-policy/` / `observability/`                 | 按网络策略和运行事件拆分职责                                                                                                                 |
| `src/formatting/*`              | `formatting/`                                        | 保持无副作用格式化能力                                                                                                                       |
| `src/validation/*`              | `validation/`                                        | 保持现有规则，增加独立最小输入契约适配                                                                                                       |
| `src/index.ts`                  | 根公共入口                                           | 从“文件导出集合”升级为稳定 SDK API 与契约导出                                                                                                |
| `@charlie_deng/e2e-assistant-types` 导入 | 本包自有类型                                         | 校验输入收敛为本包 `IValidationTestCase`，平台用例数据由宿主转换后传入                                                                       |
| `package.json`                  | 运行时依赖声明                                       | 阶段 0/1 已移除 `@charlie_deng/e2e-assistant-types` 依赖；`@playwright/test` 运行时依赖留到阶段 2 的 dry-run 实现时再增加，并在发布前验证包内解析路径 |

该迁移不要求一次性重写所有校验器。优先稳定公共契约和安全边界，再逐步替换占位实现，能够降低对现有 v5/v6 流程的回归影响。
