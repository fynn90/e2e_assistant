# `@authine-e2e-agent/cli`

`apps/cli` 是 Authine E2E Agent Platform 的 **CLI 命令层**。它只负责命令行本身的事：解析命令、
检查用户环境、管理本地服务的进程生命周期、唤起浏览器、提供终端交互界面。

v18 起，全部后端服务能力（HTTP API、Agent 运行时、生成与执行编排）已迁入独立的
[`packages/service`](../../packages/service) 包。CLI 通过 `@authine-e2e-agent/service`
的启动入口拿服务，不再自己承载业务实现。

## 1. 包的作用与依赖项

### 当前包的作用

- 提供 `e2e_assistant` 和 `authine-e2e-agent` 两个可执行命令入口。
- 提供 `web`、`start`、`log`（别名 `logs`）、`stop`、`status`、`authine-tui` 六个命令。
- 命令执行前做环境前置检查：Node 版本门槛、bash 可执行文件探测。
- 进程生命周期管理：探测服务是否已在运行、派生后台服务进程、登记运行态记录、
  经关闭端点或信号终止、注册退出清理钩子。
- 启动服务后自动打开浏览器，或在 `--no-open` 时打印可访问地址。
- 提供终端交互式界面入口（`authine-tui`），按需动态加载、不装配服务层。

### 命令一览（v19）

| 命令                                                   | 行为                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `e2e_assistant start [--port] [--strict-port] [--no-open]` | **默认后台运行**：派生独立服务进程后启动器立即返回；日志写入 `<配置目录>/logs/service.log`                                  |
| `e2e_assistant start --foreground`（`-f`）                 | 前台运行：服务跑在当前进程内，日志打终端、Ctrl+C 结束（不写日志文件）                                                       |
| `e2e_assistant web [...]`                                  | 与 `start` 完全等价（同样支持 `--foreground`）                                                                              |
| `e2e_assistant log [-n <行数>] [-f]`（别名 `logs`）        | 查看后台日志；默认 100 行，`-f` 持续跟随（Ctrl+C 只退出本命令）                                                             |
| `e2e_assistant stop`                                       | 优先请求优雅关闭端点（中止在跑任务 → 关浏览器 → 释放资源 → 退出）；端点不可用时回退信号并说明                               |
| `e2e_assistant status`                                     | **只读**查看服务状态：运行中给出地址与 PID（可直接在浏览器打开）、未运行给出启动命令；退出码 0 运行 / 1 未运行 / 2 无法确认 |
| `e2e_assistant authine-tui`                                | 终端交互式界面                                                                                                              |

`status` 有一条硬性质：**不改变任何状态**——不启动、不结束进程、不清理记录。
即使判定为「无法确认」（端口被占但不回应健康探测）也只如实报告，绝不替用户
做决定。退出码因此区分三态，可直接写进脚本：

```bash
if e2e_assistant status > /dev/null; then
  echo "服务在运行"
fi
```

### 终端输出的三种呈现层级

`start` / `stop` / `log` / `status` 的输出由 `src/presentation/console/` 统一渲染，按终端能力自动分级：

| 层级      | 触发条件                  | 形态                                   |
| --------- | ------------------------- | -------------------------------------- |
| `card`    | 是 TTY 且列数 ≥ 64        | 圆角卡片，含配色、状态图标与吉祥物台词 |
| `colored` | 是 TTY 但终端更窄         | 去掉边框的彩色行，避免边框挤成一团     |
| `plain`   | 输出被重定向（管道 / CI） | 纯文本，无 ANSI 转义序列与边框字符     |

分级判据在 `terminal-output-mode.ts`；宽度按可见列数计算（CJK 与 emoji 占 2 列、
组合符占 0 列、ANSI 不计宽），见 `text-width.ts`——**面板对齐不能依赖 `String.length`**。

配色用 Node 内置的 `util.styleText`（零依赖，非 TTY 时自动降级、遵守 `NO_COLOR`），
而非引入颜色库：v18 曾审计并移除闲置的 `chalk`（PRD v18 AC-07）。

### 单行提示（信息 / 警告 / 错误）

面板负责「一次操作的结果」，散落在各条路径上的单行提示由
`presentation/console/message-line.ts` 渲染：`ℹ️` / `⚠️` / `❌` + 与面板同一套配色。

**分层约束**：application 与 infrastructure 层**只返回结果，不打印**——

| 模块                | 返回什么                                                | 谁呈现                  |
| ------------------- | ------------------------------------------------------- | ----------------------- |
| `bash-shell-check`  | `{ outcome: 'found' \| 'missing' \| 'not-applicable' }` | 启动面板的 `🐚 bash` 行 |
| `log-file`（轮转）  | `{ rotated, failureReason }`                            | 启动面板的说明行        |
| `environment-check` | `{ satisfied, message }`                                | 命令包装器输出到 stderr |

**错误与警告一律走 stderr**，stdout 只承载正常输出——否则管道下游会把错误
当成正常结果。唯一的错误出口是 `reportCliCommandError`（`Authine CLI 执行失败：<原因>`
的措辞与堆栈按 PRD v18 约定保留）。

**它不包含**任何「用户请求某项能力」的业务实现（见 PRD v18 §4.0 原则一/二）。

### 当前包依赖的内部包

- `@authine-e2e-agent/service`
  本地服务层（纯 API）。本包调用它的 `startLocalServer()` 启动服务，并消费其类型。
- `@authine-e2e-agent/web-host`
  前端产物托管。本包通过服务层的 `extendApp` 扩展点把 Web 工作台页面挂到同一地址上——
  服务层因此不需要依赖任何前端包，可独立部署到服务器端。
- `@authine-e2e-agent/config`
  共享的用户级配置目录约定。CLI 的 `runtime.json` 与服务层的 `config.json` 必须落在同一目录下。
- `@authine-e2e-agent/types`
  跨包线协议常量：`LOCAL_SERVICE_PROTOCOL_VERSION`（版本比对）与 `localServiceHealthSchema`（`/health` 应答校验）。

### 当前包依赖的第三方库

- `cac`：CLI 命令定义与参数解析。
- `open`：启动服务后自动打开浏览器。
- `@earendil-works/pi-tui`：终端交互式界面。

## 2. 包代码组织架构

```text
apps/cli/
├── src/
│   ├── index.ts                        命令注册（cac）+ 进程级错误兜底
│   ├── commands/
│   │   ├── shared/run-command-with-environment-check.ts
│   │   ├── web-command.ts              复用 start 流程
│   │   ├── start-command.ts            启动分派器（后台 / 前台）+ 打印地址 + 打开浏览器
│   │   ├── log-command.ts              查看 / 跟随后台日志（v19）
│   │   ├── stop-command.ts             停止服务
│   │   ├── status-command.ts           只读查看服务状态（三态退出码）
│   │   └── tui-command.ts              终端界面（动态 import）
│   ├── application/
│   │   ├── environment-check.ts        Node 版本门槛
│   │   ├── bash-shell-check.ts         bash 可执行文件探测
│   │   ├── platform-config-storage.ts  启动前的配置目录预检
│   │   ├── service-lifecycle.ts        启停编排（★ 进程管理的核心）
│   │   ├── background-service-launcher.ts  后台启动器：探测 / 派生 / 等待就绪（v19）
│   │   ├── service-shutdown-request.ts 优雅关闭端点的请求与结果判定（v19）
│   │   ├── shutdown-routine.ts         关闭例行程序（信号与端点共用，v19）
│   │   ├── service-status.ts           只读状态查询（绝不写盘）
│   │   └── service-identity.ts         服务身份判定（三态收敛）
│   ├── infrastructure/
│   │   ├── config/
│   │   │   ├── config-path.ts          runtime.json 路径解析
│   │   │   ├── runtime-store.ts        运行态记录读写（含 mode / shutdownToken）
│   │   │   ├── secure-file.ts          安全写文件（与服务层各持一份）
│   │   │   └── storage-error.ts        存储错误转换（与服务层各持一份）
│   │   ├── log/log-file.ts             日志路径 / 轮转 / 尾部读取 / 跟随（v19）
│   │   ├── http/service-probe.ts       健康探测（判断记录里的服务是否真在跑）
│   │   ├── service-mode.ts             后台标记的环境变量约定（v19）
│   │   └── network/port.ts             仅 getDefaultCliPort（读 AUTHINE_CLI_PORT）
│   ├── presentation/console/           命令行输出呈现（交付物见下）
│   └── presentation/tui/start-terminal-ui.ts
├── test/                               21 个测试文件
├── package.json
└── tsconfig.json
```

### 各层职责说明

- `src/index.ts`
  CLI 总入口，只负责命令注册、参数默认值与进程级错误兜底。
- `src/commands/`
  各命令的处理逻辑与面向用户的输出文案。
- `src/commands/shared/`
  多命令共用的执行包装：环境检查 + 统一错误上报。
- `src/application/`
  进程生命周期编排。`service-lifecycle.ts` 负责「决定要不要起、起了登记谁、怎么停」，
  `service-identity.ts` 负责「记录里的服务到底还在不在」的三态判定。
- `src/infrastructure/config/`
  运行态记录的读写与配置目录路径解析。
- `src/infrastructure/http/`
  健康探测：向目标地址请求 `/health` 并校验服务自报身份。
- `src/infrastructure/network/`
  仅保留 `getDefaultCliPort`（读 `AUTHINE_CLI_PORT` 作为参数默认值）。
- `src/presentation/tui/`
  终端 UI 的展示与交互入口。
- `src/presentation/console/`
  命令行的输出呈现：渲染层级判定、配色、可见宽度计算、面板渲染器、单行提示渲染
  与四条命令的内容装配。纯函数为主，`renderPanel` 与 `renderNoticeLine` 都不做 I/O，
  故边框对齐与降级行为都能以单测锁定。命令层只把结果翻译成面板输入，不自行拼字符串。
  **本层是终端文案的唯一落点**：application / infrastructure 只返回结果。

  命令提示（`👀 e2e_assistant log -f` 这类）的**命令与作用说明统一定义在
  `panel-actions.ts`**，各面板按需引用。同一命令会出现在多个面板上（`stop` 在
  start / status / log 都有），各拼一份必然漂移——实测已出现过 `log -f` 的说明
  并存两种说法。渲染时每条命令独占一行（并排会让窄卡片整条让位，表现为
  「少了一条命令」），说明按最长命令左对齐成一列。

### 主要调用链路

**后台（默认）**：

1. 用户执行 `e2e_assistant start`。
2. `src/index.ts` 注册命令并调用 `commands/shared` 中的通用执行包装器。
3. 通用执行包装器先做环境检查（Node 版本）。
4. `start-command` 分派到 `application/background-service-launcher`：先探测已登记的服务状态。
5. 已在运行 → 复用并返回（不派生、不轮转日志）；否则轮转日志 → 派生独立服务进程 →
   等待就绪（记录出现 + 进程存活 + `/health` 确认身份，至多 30 秒）。
6. 打印地址、日志路径与停止方式，启动器退出（退出码 0）。

**前台（`--foreground`）**：

1. `start-command` 分派到 `application/service-lifecycle`，先探测已登记的服务状态。
2. 若需启动新服务：探测 bash 路径 → 调用 `@authine-e2e-agent/service` 的 `startLocalServer()` →
   登记 `runtime.json`（含运行形态与关闭凭据）→ 注册 SIGINT/SIGTERM 清理钩子。
3. 打印启动文案并自动打开浏览器。

**停止**：

`stop-command` → `service-lifecycle.stopPlatformService()`：三态判定确认身份 →
记录含凭据则请求 `POST /api/shutdown`（服务应答后自行收尾）→ 等待进程退出 →
清理记录。端点不支持 / 凭据不匹配 / 无响应时回退信号，并明确告知回退原因。

> **与「CLI 进程语义」的分界**：服务层提供「起一个绑回环的服务」这一能力（含端口解析与
> 绑定地址）；CLI 负责「决定要不要起、起了登记谁、怎么停」。`process.exit`、`process.kill`、
> 信号钩子全部在 CLI，服务层内一个都没有。

## 3. 当前包使用的技术栈

### 语言与运行时

- 语言：TypeScript
- 运行时：Node.js（≥ 22.19.0）
- 模块规范：ESM

### CLI 能力

- CLI 框架：`cac`
- 浏览器自动打开：`open`
- 终端交互界面：`@earendil-works/pi-tui`

### 构建与开发工具

- 构建工具：`tsup`
- 开发调试：`tsx`
- 类型支持：`typescript`、`@types/node`

### 包输出与发布形式

- 输出入口：`dist/index.js`
- 可执行命令：`e2e_assistant`、`authine-e2e-agent`
- 包名：`@authine-e2e-agent/cli`

> ⚠️ **本包是依赖图的最顶端，不得被任何包依赖。** 一旦服务层或未来的桌面端依赖 CLI，
> 它们就能触达「启动进程 / 结束进程」的能力，「谁提供能力」与「谁管理进程」的边界立刻失效。
> 该不变式由 `pnpm release:check` 的护栏强制。

## 4. 数据归属

| 数据                    | 位置                                                             | 归属               |
| ----------------------- | ---------------------------------------------------------------- | ------------------ |
| 运行态记录              | `~/.config/e2e_assistant/runtime.json`                               | **本包**           |
| 后台服务日志            | `~/.config/e2e_assistant/logs/service.log`（轮转件 `service.log.1`） | **本包**           |
| 平台配置                | `~/.config/e2e_assistant/config.json`                                | `packages/service` |
| Agent 会话库 / 工作块库 | `<工作区>/.e2e-agent/{sessions,work-blocks}.db`                  | `packages/service` |

（Windows 上配置目录为 `%APPDATA%\e2e_assistant`；macOS / Linux 上为 `$XDG_CONFIG_HOME/e2e_assistant`，
缺省 `~/.config/e2e_assistant`。日志文件 0600、目录 0700。）

平台差异（v19 已按此实现，Windows / macOS / Linux 三端行为一致）：

| 方面            | Windows                                                      | macOS / Linux                                             |
| --------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| `stop` 主路径   | `POST /api/shutdown`（`SIGTERM` 在这个平台是硬杀，不可捕获） | 同一个端点                                                |
| `stop` 回退路径 | 信号 = 强制结束，**不执行服务侧清理**                        | `SIGTERM` 可捕获，服务会执行与端点相同的收尾流程          |
| 服务脱离终端    | `detached` + `unref`，并经 `wscript` 以**隐藏控制台**派生（v21） | `detached` + `unref`，自成一进程组，终端 Ctrl+C 不影响服务 |
| 浏览器打开失败  | 忽略（仅提示地址）                                           | 同左——无图形环境（服务器 / 容器）上不会把成功启动报成失败 |

`runtime.json` 保存 `pid` / `port` / `serverUrl` / `startedAt` / `mode` / `shutdownToken`，
采用「临时文件 + 重命名」原子写入（0600）。它**只表示「我们启动过一个服务」**，不表示服务
还活着——存活判定一律通过 `/health` 健康探测确认身份。`shutdownToken` 是优雅关闭的一次性
凭据（仅存于此文件，不进任何 API 响应）；`mode` 区分前台 / 后台，旧记录缺该字段时按前台处理。

日志只在**后台模式**产生：后台子进程的 stdout/stderr 被重定向到该文件（POSIX 上是启动器
直接把日志文件 fd 作为子进程的 stdio；Windows 上是 VBS 内的 `cmd` 追加重定向），服务进程
自身没有任何写日志文件的代码；前台模式的日志只在其终端，不落盘。文件超过 5 MiB 时在
下次后台启动前轮转为 `service.log.1`（只保留一份旧文件）。

**Windows 的隐藏控制台（v21）。** Windows 无法通过 Node 的 `spawn` 创建「隐藏控制台」
（只有「无控制台」与「继承父控制台」两档），而没有控制台的服务会让每一个控制台子系统
子进程（node 测试进程、`chrome-headless-shell` 等）弹出可见黑窗。因此 Windows 上改为
用 `wscript.exe` 执行一段静态 VBS（`hidden-launch.vbs`，每次启动写入配置目录）：
`WScript.Shell.Run(cmd, 0, True)` 为目标进程创建**隐藏的**控制台，服务及其全部后代都继承
它。代价是派生壳（wscript）PID 与服务 PID 不同：`runtime.json` 由服务自己写入，启动器
的就绪判据因此是「本次启动之后新写入的记录」而不是「记录指向派生的 PID」。

## 常用脚本

```bash
pnpm --filter @authine-e2e-agent/cli dev
pnpm --filter @authine-e2e-agent/cli build
pnpm --filter @authine-e2e-agent/cli test
```

## 开发说明

- 修改本包时，优先保持 `src/index.ts` 轻量，只做命令注册与装配。
- **不要**在本包内添加 HTTP 路由、Agent 运行时或业务编排——那些属于 `packages/service`。
- 命令相关逻辑放到 `src/commands/`，进程生命周期逻辑放到 `src/application/`。
- `secure-file.ts` 与 `storage-error.ts` 是从服务层复制而来的稳定工具代码（各持一份，
  避免 CLI 访问服务层内部模块）。若需修改，请同步两侧。
