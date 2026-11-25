# `@authine-e2e-agent/service`

`packages/service` 是 Authine E2E Agent Platform 的**本地服务层**，承载 Web 工作台的全部
后端能力：HTTP API、Agent 工作通道运行时、生成与执行编排、平台配置读写、Skill 编排。

它从 `apps/cli` 中剥离而来（v18 架构分层），目的是让服务能力可以被 CLI 之外的客户端形态
（未来的桌面应用）直接复用，而不必「启动一个 CLI 进程」或复制一份服务代码。

## 1. 对外形态

本包对外只暴露**两件事**：装配（构造 HTTP 应用）与启动（在可用端口上监听）。

```ts
import { startLocalServer } from '@authine-e2e-agent/service'

const started = await startLocalServer({ port: 5826, strictPort: false, shellPath })
// started.port / started.serverUrl / started.closeServer()
```

### 它不做什么

**本包不含任何进程生命周期管理**（PRD v18 §4.2 G4）：

- 不登记 PID、不读写运行态记录 `runtime.json`；
- 不注册 `SIGINT` / `SIGTERM` 信号处理器；
- 不存在 `process.exit` / `process.kill`，不提供「结束某个进程」的能力；
- 不读取 `AUTHINE_CLI_PORT`——首选端口由调用方传入（环境变量的读取归 CLI）。

这些是「管理进程」，不是「提供服务」。把它们留在调用方，内嵌式客户端（未来的桌面端）
才不会继承它不该有的能力。

> **`serve()` 为何不违反上述约束**：它是在**本进程内**提供一个服务，属「提供能力」；
> 被禁止的是管理其它进程或终结自身。二者的分界写在 `src/http/server.ts` 的文件头注释中。

### 绑定地址固定在服务层

服务能读写用户工作区文件，绑回环是它的安全性质。绑定地址（`127.0.0.1`）写死在
`src/http/server.ts` 内、**不接受调用方覆盖**——集中在一处意味着任何客户端都不可能把它
误暴露到网络；若交给调用方，安全就退化为调用方的纪律。

## 2. 代码组织

```text
packages/service/
├── src/
│   ├── http/               Hono 应用 · 路由 · 静态托管 · 监听 · 错误映射
│   │   ├── server.ts       ★ 含 serve() + 端口解析 + 绑 127.0.0.1
│   │   ├── port.ts         顺延 / 严格模式两条端口决策分支
│   │   ├── error-mapper.ts toApiError：把四类域错误映射为 HTTP 状态码
│   │   └── routes/
│   ├── application/        业务编排（agent-workbench / e2e-test-case / test-execution）
│   ├── agent-runtime/      Agent 工作通道运行时
│   ├── generation-runtime/ 生成任务运行时（浏览器会话宿主 + 任务注册表）
│   ├── config/             平台配置读写（config.json）
│   ├── workspace/          目录浏览与工作区文件
│   ├── shared/             ★ 最底层：域错误定义、跨层端口契约、异步并发工具
│   └── index.ts            ★ 对外唯一出口
├── test/
├── package.json
└── tsconfig.json
```

### 内部依赖方向（单向无环）

```text
http ──▶ application ──▶ agent-runtime · generation-runtime · config · workspace
  │            │
  └────────────┴──────▶ shared ──▶ @authine-e2e-agent/types
```

三条硬约束（可用 grep 验证）：

1. `application` **不得**指向 `http`；
2. `agent-runtime` / `generation-runtime` **不得**指向 `application`；
3. `shared` **不得**指向 `application` 或 `http`。

### `shared` 的双重身份（勿「顺手」整理）

`shared` 既承载「与业务无关的工具」（`async-concurrency`、`path-guard`），也承载
「业务要用的错误定义」（`ApiError` 及其同族）。后者**事实上是与 `http` 同层的协议概念**，
把它放在最底层是**打破循环依赖的权衡结果，而非纯粹的层次美学**：

- `application` 抛 `ApiError`（错误码 + 消息 + 可选 HTTP 状态）；
- `http` 用 `toApiError` 把域错误映射为 HTTP 状态码。

若把 `ApiError` 挪回 `http/`，`application` 就会反向依赖传输层，重新引入环。
同理，`shared/ports/` 承载的 `ISkillGenerationSessionRunner` 是「跨层共享的契约」——
它不下沉，`agent-runtime` 就会反向依赖 `application`。

## 3. 前端资源托管（不在本包）

**本包是纯 API 服务，不依赖任何前端包**——这样它才能独立部署到服务器端。

页面由 [`@authine-e2e-agent/web-host`](../web-host) 托管，它依赖 `web` 并把其 `dist`
挂到宿主 HTTP 应用上。两者的组合由调用方（`apps/cli`）完成：

```ts
const started = await startLocalServer({
  port,
  // 在全部 API 路由之后，把应用交给调用方挂载前端页面。
  extendApp: registerWebStaticRoutes,
})
```

`extendApp` 是服务层提供的**通用扩展点**：它只承诺「此时 API 路由已全部注册完毕」，
不关心调用方挂什么。服务层因此对前端零知识，而页面与 API 仍能在同一地址上共存。

> `pnpm release:check` 有护栏：任何包把 `web` 加进 `service` 的依赖会直接报错。

## 4. 数据归属

| 数据 | 位置 |
| --- | --- |
| 平台配置 | `~/.config/e2e_assistant/config.json` |
| Agent 会话库 / 工作块库 | `<工作区>/.e2e-agent/{sessions,work-blocks}.db` |
| Skill 与用例 | 平台配置中的 `projectDirectory` 之下 |
| 测试报告 | `<Skill>/test_report/<runId>/` |

用户级配置根目录由 `@authine-e2e-agent/config` 统一解析（Windows 用 `APPDATA`、
POSIX 用 `XDG_CONFIG_HOME`、兜底 `homedir()`），CLI 与服务层各自拼接自己的文件名。

## 5. 测试

```bash
pnpm --filter @authine-e2e-agent/service test
```

`vitest.config.ts` 中 **`fileParallelism: false` 必须保留**：多个测试文件通过设置
`APPDATA` / `XDG_CONFIG_HOME` 环境变量隔离配置目录，并行执行会互相覆盖，且症状是随机失败。
