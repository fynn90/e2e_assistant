# e2e_assistant

> e2e_assistant 是一个本地优先的 Web E2E 测试 Agent 平台：把结构化测试用例交给 AI Agent，自动生成、静态校验并执行 Playwright 脚本，同时把人工审阅与确认保留在闭环中。
> 它解决的是「测试人员不熟悉 Playwright、开发人员维护脚本成本高、AI 生成的测试代码不可直接信任」这三类问题，让端到端测试从手写代码变成「描述意图 → 审阅产物 → 本地执行」。

---

## 1. 项目定位

### 1.1 面向谁

主要用户是**测试工程师**和需要维护 Web E2E 用例的**开发人员**。用户不需要从零编写 Playwright 代码，而是用中文结构化地描述测试意图，由 Agent 完成页面核对、代码生成与校验，最终由人确认后落盘。

### 1.2 核心闭环

```text
结构化用例（e2e_schema.json）
   │  Agent 读取用例 + 用真实浏览器核对页面元素
   ▼
SKILL.md（可读、可分享的测试说明）
Playwright 脚本（test.spec.ts）
   │  静态校验 + 差异预览 + 用户确认
   ▼
本地有头执行 ──▶ 自包含 HTML 测试报告 + 视觉基线
```

平台提供两个工作入口：

- **Skill 开发页**（`/skill-dev/:skillId`）：围绕单个用例完成编辑、生成、执行、看报告。
- **全局 Agent 工作台**（`/agent`）：用自然语言操作整个工作区的用例，跨用例查询、执行、生成、修复与清理。

### 1.3 本地优先

平台以本地服务 + 本地浏览器的形态运行：

- 服务固定绑定 `127.0.0.1`，不对局域网暴露；
- 用例、脚本、报告、基线全部保存在用户指定的项目目录；
- 除调用用户自己配置的模型端点外，不向任何第三方服务上传数据。

---

## 2. 快速开始

### 2.1 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | `>= 22.19.0`（根 `package.json` 的 `engines` 与 `volta` 均固定为 22.19.0） |
| pnpm | `10.13.1`（根 `package.json` 的 `packageManager`；推荐 `corepack enable` 自动启用） |
| bash | Agent 的工作区命令工具依赖 bash；Windows 建议安装 Git Bash。启动时探测一次，探测失败只警告、不阻断启动 |
| 网络 | 首次生成或执行时若缺少 Playwright Chromium 会自动下载；模型调用需要访问你配置的 LLM 端点 |
| 模型 | 任意 **OpenAI Chat Completions 兼容**端点；页面截图核对需要模型支持图片输入（vision） |

### 2.2 从源码启动（开发模式）

```bash
git clone git@github.com:fynn90/e2e_assistant.git
cd e2e_assistant

# 可选：使用 nvm 时显式切到要求的版本
nvm install 22.19.0
nvm use 22.19.0

corepack enable
pnpm install
pnpm dev
```

`pnpm dev` 会并行启动：

- Web 开发服务器：`http://127.0.0.1:5176`（Vite，热更新）
- 本地服务：`http://127.0.0.1:5826`（CLI 前台运行，Web 的 `/api` 与 `/health` 反向代理到它）
- 各 `packages/*` 的 `tsup --watch` 构建

打开 `http://127.0.0.1:5176` 使用工作台。开发端口可通过环境变量覆盖：

```bash
AUTHINE_WEB_PORT=5177 AUTHINE_CLI_PORT=5827 pnpm dev
```

`pnpm dev` 启动前会执行端口预检；若端口被占用，会询问是否结束占用进程（非交互环境则直接提示手动处理）。

> 开发模式下 CLI 以 `--foreground --no-open --strict-port` 运行，按 `Ctrl+C` 结束即可。

### 2.3 从源码构建并运行（接近发布形态）

```bash
pnpm build

# 默认后台运行：启动器派生独立服务进程后返回
node apps/cli/dist/index.js start

# 或前台运行：日志输出到当前终端，Ctrl+C 结束
node apps/cli/dist/index.js start --foreground
```

构建后也可以使用包脚本：

```bash
pnpm --filter @charlie_deng/e2e-assistant-cli start
```

`start` 默认会打开浏览器；加 `--no-open` 可只打印地址。默认端口为 `5826`，被占用时会自动顺延到下一个可用端口；加 `--strict-port` 则直接报错。

### 2.4 通过 npm 安装与使用（推荐）

适合只需要使用平台、不参与开发的使用者。前置条件：**Node.js `>= 22.19.0`**（`node -v` 检查），无需安装 pnpm。

#### 2.4.1 安装

```bash
npm install -g @charlie_deng/e2e-assistant-cli
```

安装后提供两个等价命令入口：`e2e_assistant` 与 `authine-e2e-agent`。

```bash
e2e_assistant --help
```

npm 页面：<https://www.npmjs.com/package/@charlie_deng/e2e-assistant-cli>

> Windows 用户请先安装 Git Bash：Agent 的工作区命令工具依赖 bash。

#### 2.4.2 启动、查看与停止

```bash
e2e_assistant start      # 后台启动服务，默认打开浏览器
e2e_assistant status     # 查看地址、端口、PID、版本与运行时长
e2e_assistant log -f     # 实时跟随后台日志
e2e_assistant stop       # 优雅停止服务
```

启动后按终端打印的地址访问工作台（默认 `http://127.0.0.1:5826`）。常用参数：

- `-p, --port <port>`：指定端口，默认 `5826`；端口被占用时自动顺延，`--strict-port` 则直接报错；
- `--no-open`：只打印地址，不自动打开浏览器；
- `-f, --foreground`：前台运行，日志输出到当前终端，`Ctrl+C` 结束。

完整命令与参数见第 3 节。

#### 2.4.3 首次配置

第一次打开工作台后，按 [2.5 首次配置](#25-首次配置) 填写项目目录、LLM Base URL、模型名称与 API Key，即可创建第一个 Skill。

#### 2.4.4 升级与卸载

升级前先停止旧版本的后台服务，安装新版本后重新启动：

```bash
e2e_assistant stop
npm install -g @charlie_deng/e2e-assistant-cli@latest
e2e_assistant start
```

卸载：

```bash
e2e_assistant stop
npm uninstall -g @charlie_deng/e2e-assistant-cli
```

#### 2.4.5 可复用的 SDK 包

平台能力也以独立 npm 包发布，可按需安装：

| 包 | 用途 |
| --- | --- |
| `@charlie_deng/e2e-assistant-agent` | E2E Agent SDK（Loop / Harness / 工具 / 会话） |
| `@charlie_deng/e2e-assistant-playwright-engine` | Playwright 能力 SDK（浏览器会话、校验、执行器、报告） |
| `@charlie_deng/e2e-assistant-skill-manager` | Skill 领域存储 |
| `@charlie_deng/e2e-assistant-types` | 跨包契约（Zod Schema、API 与事件类型） |

```bash
npm install @charlie_deng/e2e-assistant-playwright-engine
```

#### 2.4.6 从源码本地链接（开发调试）

```bash
pnpm install
pnpm build
cd apps/cli
npm link
```

之后即可在任意目录执行 `e2e_assistant start`、`e2e_assistant status`。

### 2.5 首次配置

1. 启动服务并打开工作台；
2. 进入 **系统配置**（`/config`），填写：
   - **项目目录**：Skill 与用例的本地存储根目录；
   - **LLM API Base URL**：OpenAI Chat Completions 兼容地址；
   - **模型名称**：例如你的服务商提供的模型 ID；
   - **API Key**：仅保存在本地配置文件中，界面上以掩码展示。
3. 进入 **Skill 管理**（`/skills`）新建第一个用例；
4. 进入 Skill 开发页编辑结构化用例，或直接到 **Agent 工作台**（`/agent`）用自然语言开始。

---

## 3. CLI 命令

安装或链接后提供两个等价的命令入口：**`e2e_assistant`** 与 **`authine-e2e-agent`**（同一份可执行文件）。

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `e2e_assistant start` | 启动本地服务。**默认后台运行**：派生独立服务进程后立即返回，服务脱离终端继续存活 | `-p, --port <port>` 指定端口（默认 5826）；`--strict-port` 端口被占用时报错而非顺延；`--no-open` 不自动打开浏览器 |
| `e2e_assistant start --foreground` | 前台运行：服务跑在当前进程内，日志输出到终端，`Ctrl+C` 结束 | `-f, --foreground` |
| `e2e_assistant web` | 与 `start` 完全等价（含 `--foreground`、`--port` 等参数） | 同上 |
| `e2e_assistant log`（别名 `logs`） | 查看后台服务日志；服务未运行时仍可回看最后一次后台运行的日志 | `-n, --lines <lines>` 默认 100 行；`-f, --follow` 持续跟随（`Ctrl+C` 只退出本命令） |
| `e2e_assistant status` | **只读**查看服务状态：运行中给出地址、端口、PID、启动时间、运行时长、CLI/协议版本与日志路径；未运行给出启动命令 | 无。退出码：`0` 运行 / `1` 未运行 / `2` 无法确认 |
| `e2e_assistant stop` | 优雅停止服务：优先请求本地关闭端点（中止在跑任务 → 关闭浏览器 → 释放资源 → 退出），端点不可用时回退信号并说明原因 | 无 |
| `e2e_assistant authine-tui` | 启动终端交互式界面入口 | 无 |
| `e2e_assistant --help` | 查看命令帮助 | 无 |

常用组合：

```bash
e2e_assistant start          # 启动后终端立即可用
e2e_assistant status         # 确认是否在运行
e2e_assistant log -f         # 实时看后台日志
e2e_assistant stop           # 优雅停止
```

说明：

- **后台模式**日志写入 `<配置目录>/logs/service.log`，超过 5 MiB 在下次后台启动前轮转为 `service.log.1`；前台模式不落盘。
- `status` 不改变任何状态：不启动、不结束进程、不清理记录，因此可以安全地写进脚本。
- 端口顺延逻辑在服务层：首选端口被占用时逐个 `+1` 直到找到可用端口；`--strict-port` 则要求首选端口必须可用。
- 两个命令入口都支持同一套参数，便于兼容旧脚本。

---

## 4. 功能详解

### 4.1 用例即 Skill：目录化的测试资产

平台把一个 E2E 用例建模为一个 **Skill**，它是项目目录下的一个独立文件夹，而不是数据库里的一行记录。

- 创建 Skill 时自动生成 `manifest.json`、默认 `e2e_schema.json`、`env.json`、`userWorkSpace/`；
- 支持 Skill 列表、创建、删除；删除会检查该 Skill 是否有生成或执行任务在跑；
- 文件树支持浏览、打开、编辑、保存、新建文件/目录、删除文件/目录、图片预览；
- 文本文件带自动保存、保存状态提示、版本冲突保护与路径越界校验；
- `manifest.json` 与 `skill.list.json` 只作为列表投影，业务数据以 `e2e_schema.json` 为唯一数据源。

**收益**：一个用例就是一个可拷贝、可用 Git 管理的目录，天然适合在团队内传递和审阅，不被平台数据库锁定。

### 4.2 结构化 E2E 用例编辑

提供表单 + 表格形态的专用编辑器，而不是让用户直接编辑 JSON：

- 基础信息：标题、描述、目标地址（Base URL）、标签；
- 前置条件：可增删、可排序；
- 测试步骤：步骤描述、操作动作、预期结果、启停状态、排序、复制、删除；
- 每个步骤可维护测试数据键值，并支持把「敏感数据」类型的数据替换为 `${ENV:KEY}` 引用；
- 保存前做字段级与业务级校验：必填项、Base URL、稳定 ID 唯一性、步骤顺序连续、敏感数据是否已选择 key；
- 编辑过程自动保存，并处理文件版本冲突；生成前还有更严格的「生成就绪」校验。

**收益**：测试人员用自然语言表达意图即可，不需要懂 Playwright API；同时数据结构化、可校验，为后续 AI 生成提供稳定输入。

### 4.3 根据用例生成 SKILL.md

- Agent 读取结构化用例，按固定规范生成 `SKILL.md`：frontmatter、测试目标、执行上下文、前置条件、测试步骤、执行注意事项；
- 步骤的 `action` 与 `expectedResult` 用 `text` 代码块承载原文，多行内容不会被 Markdown 列表结构破坏；
- 生成过程流式展示在工作台中，生成后校验章节与步骤覆盖度；
- 用户确认后才提交 `manifest.generatedSkill` 元数据，Agent 不得写入 `manifest.json`、`e2e_schema.json` 或 Skill 目录外的文件。

**收益**：每个用例都有一份人类可读、可评审、可分享的测试说明，便于知识传递和用例交接。

### 4.4 根据用例生成 Playwright 脚本（核心能力）

这是平台最有价值的一条链路，目标不是「让模型凭空写代码」，而是「让模型先看清真实页面，再写可校验的代码」。

**页面核对**：Agent 在生成前通过注入的浏览器会话真实访问目标页面，可用工具包括：

| 工具 | 作用 |
| --- | --- |
| `browser_navigate` | 在用例 `baseUrl` 同源范围内打开页面 |
| `browser_snapshot` | 采集有界可访问性树与候选定位器 |
| `browser_query` | 按 selector 查询元素标签、角色、文本与属性 |
| `browser_list_frames` | 枚举主文档与 iframe，获得 `frameId`（v20） |
| `browser_click` / `browser_select` / `browser_fill` / `browser_waitFor` | 核对「交互后才出现」的元素、下拉选项、输入态与等待条件 |
| `browser_screenshot` | 页面或元素截图，图片回传模型 |
| `browser_capture_baseline` | 把元素完整内容截图保存为视觉基线（v12） |
| `todo_write` | 维护多步骤核对清单，驱动时间线进度展示 |

**生成与校验**：

1. 候选脚本只写入当前 Skill 的 `temp/` 临时工作区，任务结束整体删除；
2. 平台对候选脚本做多层静态门禁：
   - TypeScript 语法与语义检查；
   - 只允许导入白名单模块：以 `@playwright/test` 为主；文件操作仅放行 `node:fs` / `node:fs/promises` / `node:path` 的白名单成员，且必须限制在当前 Skill 的 `userWorkSpace/` 内；
   - 禁止 `eval`、`Function`、`child_process`、Shell 与进程控制 API（如 `process.exit` / `process.kill`）；文件写入按 `userWorkSpace` 边界单独校验；
   - 校验 `test()`、`page`、`page.goto()`、`expect()` 等结构；
   - 校验每个启用步骤有且仅有一个对应的 `test.step('<step-id>')`，且每步至少有一个操作和一个断言；
   - 校验脚本引用的环境变量与用例声明一致；
   - 对 XPath、深层 CSS、动态选择器、`waitForTimeout()` 等给出警告；
3. **质量类问题不再阻断写入**（v15）：章节缺失、步骤覆盖不足、类型检查未通过等以警告呈现；**安全边界类问题仍硬阻断**；
4. 生成结果在工作台中展示代码、警告、假设与差异，用户确认后才写入 `test.spec.ts`；
5. 通过来源哈希识别「用例已变更但脚本未更新」的过期状态；手工编辑过的脚本在重新生成前会要求确认覆盖。

**收益**：

- 选择器来自真实 DOM 与可访问性树，而不是模型猜测；
- 生成结果在落盘前就可读、可审、可对比；
- 脚本保持标准 Playwright 形态，离开平台仍可运行；
- 安全门禁把「模型写坏文件」的风险挡在写入之前。

### 4.5 敏感数据隔离（`env.json`）

- 每个 Skill 有一份 `env.json`，保存该用例全部敏感数据的**真实值**；
- 结构化用例中只保存 `${ENV:KEY}` 引用，不保存明文；
- **Agent 在生成链路中被结构性禁止读取 `env.json` 的值**：生成脚本只需要引用，执行时由本地服务层注入真实值；
- 浏览器核对阶段的 `browser_fill` 支持凭据代理：Agent 只传 `${ENV:KEY}`，宿主在填入前换取真值，真值立即登记进会话脱敏器；密码输入框的值在快照与元素查询中恒被屏蔽，无法回读；
- 测试报告、日志、事件流均不包含环境变量的值。

**收益**：可以让 AI 协助完成登录等敏感流程，而密钥、密码不会进入模型上下文、对话记录或测试报告，满足企业环境对凭据的基本要求。

### 4.6 本地执行与测试报告

- **执行入口**：Skill 文件树顶部的「执行测试用例」按钮（根目录存在 `test.spec.ts` 时显示），以及全局 Agent 工作台中的对话发起；两者走同一条执行链路；
- **执行前就绪校验（J1–J8）**：脚本存在、脚本内至少一条测试、没有未保存修改、脚本引用的环境变量 key 都存在、目标 URL 已配置、同一 Skill 无并行任务、Chromium 可用（缺失时自动安装）、报告目录可写；任一项不通过都不启动，并列出全部问题；
- **执行语义**：固定**有头模式**；执行使用发起时刻的磁盘快照，执行期间的编辑不影响本次运行；`baseUrl` 与环境变量由服务层注入；单条测试默认 120 秒超时，整次执行默认上限 10 分钟；
- **实时反馈**：侧边栏执行区块展示状态、日志流、`test.step()` 粒度的步骤进度；支持停止执行；用户手动关闭浏览器窗口视为中断；
- **测试报告**：每次启动过浏览器的执行都会生成一份自包含单文件 `report.html`（零外部依赖），包含汇总统计、每条测试结果、失败步骤、错误信息与失败截图；失败、超时、中断都会生成；
- **历史与清理**：报告保存在 `<Skill>/test_report/<yyyyMMdd-HHmmss>/`，全部保留；同时写入 `summary.json` 供执行历史与两次执行对比查询；支持删除单份报告（需确认）。

**收益**：生成脚本后不必离开平台搭建 Playwright 环境，一键即可验证；失败有截图、有步骤定位、有历史记录，回归时可直接对比结果。

### 4.7 视觉回归（新旧 DOM 截图对比）

当测试步骤要求「截图对比 / 新旧 DOM 对比」时，平台提供从基线捕获到差异展示的完整能力：

- `browser_capture_baseline` 截取元素**内部滚动区域的完整内容**（临时展开 `overflow` 与尺寸，`finally` 还原），并在捕获前做稳定性校验；
- 基线保存在 `<Skill>/userWorkSpace/baselines/`，跨会话长期保留，由用户主动维护；
- 生成脚本使用**纯 Playwright 内联模板**完成比对，不引入平台专属运行时，脚本仍可移植；
- 报告按附件名后缀识别 `-diff.png`（差异热点图）、`-expected.png`（基线）、`-actual.png`（实际），差异图置顶高亮，基线与实际并排对照；
- 执行器配置把 `snapshotPathTemplate` 指向基线目录，并恒写 `updateSnapshots: 'none'`，避免执行期误写基线、造成「比对的是错文件」。

**收益**：把「看起来不一样」变成可量化、可审阅的差异报告；同时避免滚动容器截图只截可视区、CDP 截图空白等常见陷阱。

### 4.8 全局 Agent 工作台（`/agent`）

`/agent` 是整个测试工作区的对话式操作入口，不绑定单个 Skill。它按八个能力域组织：

| 能力域 | 能做什么 |
| --- | --- |
| **问询** | 盘点工作区用例、查看用例详情、查执行历史、解读失败原因、对比两次执行 |
| **执行** | 单次执行、重新执行、执行前体检、会话内连续执行多个用例（串行） |
| **生成与修复** | 生成或更新 SKILL.md / 脚本；根据失败报告修复脚本并复跑 |
| **用例变更** | 以「变更提案 → 用户确认 → 平台写入」的方式修改用例；Agent 不直接写用例数据 |
| **环境准备** | 列出缺失的环境变量 key，由用户在卡片内就地填写并保存，值不进入对话 |
| **清理** | 删除旧报告、删除用例；均需二次确认，逐个执行 |
| **引导** | 回答「你能做什么」、空态建议问题、能力边界说明 |
| **能力外回应** | 对平台确实不具备的能力（导入导出、定时执行、CI 集成等）如实说明原因并给出替代路径，不编造、不变通 |

此外还提供会话管理：会话重命名、删除（只删对话记录，不影响用例与报告）。

关键机制：

- **信息充分性门槛**：有副作用的动作在目标唯一、动作明确、参数完整之前必须询问，不得推断；信息已充分时必须直接执行；
- **能力外请求如实告知**：平台不具备的能力（导入导出、定时执行、CI 集成等）不编造、不变通，并给出替代路径；
- **失败修复闭环**：执行失败 → 定位失败步骤 → 修复脚本或提出「用例与页面不一致」的修复提案 → 重新执行 → 对比结果。**断言层红线**：预期结果一律不得被 Agent 修改；若实际结果与预期不符，平台提示这可能是产品缺陷，而不是改断言掩盖问题；
- **会话持久化**：会话与工作块存入工作区 `.e2e-agent/` 下的 SQLite，刷新页面、离开页面甚至服务重启后都可以恢复；
- **后台任务与完成提示**：长任务在服务端运行，用户离开页面后完成时仍会收到通知；`/agent` 空态提供可点击的示例问题。

**收益**：不用在多个页面之间来回跳转，一句话就能完成「查、跑、修、改、清」；连续执行与失败修复把回归工作流真正闭合。

### 4.9 Skill 开发页 Chat 与全局工作台

- Skill 开发页的 Chat 绑定当前 Skill 上下文，支持多轮、流式输出、停止生成与失败重试；
- Agent 工具调用以时间线形式展示：动作图标、耗时、命令输出、待办清单、截图缩略图；
- Agent 工作台自 v13 起是**全局**的：在任意页面都可见，切换页面不销毁任务，新任务会清空旧内容；
- 离开 Skill 开发页后执行仍继续，点「查看测试报告」会回到该用例的开发页并打开报告。

**收益**：长任务不再绑住用户，用户可以边等生成/执行边处理别的事，符合真实测试工作流的节奏。

### 4.10 iframe 页面支持（v20）

- Engine 新增 `listFrames()` 与 frame-scoped 操作 API；
- Agent 新增 `browser_list_frames`，既有的 `browser_snapshot/query/click/fill/select/waitFor/screenshot` 都支持可选 `frameId`；
- 默认 **same-origin-only**：跨源 iframe 需要显式授权；
- 生成的脚本使用 Playwright 原生 `page.frameLocator()` 回放，不依赖平台私有运行时；
- iframe 内同样支持 `${ENV:KEY}` 凭据代理。

**收益**：可以覆盖大量使用 iframe 嵌入的中后台 SaaS 页面，而不是只能测试主文档。

### 4.11 平台配置与工作区

- 配置项：项目目录、LLM Base URL、模型名称、API Key；
- API Key 只存本地，界面掩码展示；配置损坏、目录不可用、Key 缺失等问题会在界面上明确提示；
- 切换项目目录后，旧工作区的 Skill 状态会失效并重新加载；
- 配置目录跨平台统一解析：Windows 使用 `%APPDATA%\e2e_assistant`，macOS / Linux 使用 `$XDG_CONFIG_HOME/e2e_assistant`（缺省 `~/.config/e2e_assistant`）。

### 4.12 安全边界

平台把安全边界当作产品能力的一部分，而不是提示词里的建议：

- 服务只绑定 `127.0.0.1`，绑定地址写死在服务层，调用方无法覆盖；
- 所有文件访问经过路径守卫：拒绝 `..` 逃逸、符号链接逃逸、跨 Skill 路径；
- Agent 工具按任务白名单开放：生成任务只放行 `load_skill`、`browser_*`、`todo_write`、`ask_user_question`、工作区内 `read`、`bash`（危险命令拦截）与指定目标 `write`；
- 生成任务拒绝读取 `env.json` 的真实值（结构性隔离，不依赖提示词）；
- bash 命中危险命令清单（递归强删、磁盘/系统操作、注册表/权限、远程执行、计划任务、引用 `env.json`）时拒绝执行，但不终止会话；
- 浏览器主动导航限制在用例 `baseUrl` 同源范围；跨源文档默认阻断；
- 截图与基线单张上限 2 MiB；报告不含环境变量值；
- 测试执行只写 `test_report/<runId>/`，不得修改 Skill 中的任何既有文件。

### 4.13 当前明确不做的事

为避免预期偏差，以下能力当前**不在**平台范围内：

- 定时 / 周期 / 无人值守执行、CI 集成、跨工作区或云端执行；
- 导入 / 导出 / 分享用例包（用例以目录形式保存，可手动拷贝整个目录）；
- 用例或文件的重命名、移动、复制；
- 只执行脚本中的某一条 `test()`（按整份脚本执行）；
- 平台级批量任务（只有会话内的串行连续执行，不产生批次报告或批次重跑）；
- 执行结果趋势与统计报表；
- 执行报告中的 trace、视频与失败自动重试；
- 无头执行（测试执行固定有头；生成阶段的页面核对可通过 `browserVisualization` 选择有头/无头）；
- 未经用户确认的脚本覆盖或修复动作。

---

## 5. 技术栈

| 层面 | 技术 |
| --- | --- |
| 语言 / 运行时 | TypeScript 6、Node.js `>= 22.19.0`、ESM |
| Monorepo | pnpm 10 workspace、Turborepo 2、Changesets |
| 构建 | tsup（Node 包）、Vite 8 + `vue-tsc`（Web） |
| 前端 | Vue 3.5、Vue Router 4、Pinia 2、Naive UI 2、Monaco Editor、markdown-it + DOMPurify + highlight.js、Tailwind CSS 4 |
| 本地服务 | Hono 4 + `@hono/node-server`、Zod 4、SSE、better-sqlite3 13 |
| Agent | `@earendil-works/pi-ai` 0.84 + `@earendil-works/pi-agent-core` 0.84；自研 Harness 插件层；对接 OpenAI Chat Completions 兼容端点 |
| 浏览器 | Playwright 1.64、Chromium 自动检测与安装、有头执行、`frameLocator` |
| CLI | `cac`、`open`、`@earendil-works/pi-tui` |
| 存储 | 本地文件系统 + SQLite（WAL）；无云数据库依赖 |
| 测试 | Vitest 4（单元 / 集成）、Playwright Test（仓库级 E2E）、Node 内置 test runner（脚本） |
| 发布 | Changesets 版本管理；npm scope 为 `@charlie_deng` |

---

## 6. 架构与工程设计

### 6.1 总体架构

```text
浏览器（apps/web · Vue 3）
   │  HTTP /api + SSE
   ▼
apps/cli ── 命令解析 / 进程生命周期 / 终端展示
   ├─▶ packages/service ── Hono API · Agent 运行时 · 生成与执行编排 · 配置/工作区
   │        ├─▶ packages/agent ── Agent SDK（Loop + Harness + 工具 + 技能 + 会话）
   │        ├─▶ packages/playwright-engine ── 浏览器会话 / 校验 / 执行器 / 报告
   │        ├─▶ packages/skill-manager ── Skill 文件与用例领域存储
   │        └─▶ packages/types · packages/config
   └─▶ packages/web-host ──▶ apps/web 构建产物（同一地址托管页面与 API）
```

### 6.2 各包职责

| 路径 | 包名 | 职责 |
| --- | --- | --- |
| `apps/cli` | `@charlie_deng/e2e-assistant-cli` | CLI 命令层：命令注册、环境检查、进程生命周期（启动/探测/停止/日志）、终端面板与 TUI、打开浏览器。**依赖图的最顶端，任何包都不得依赖它** |
| `apps/web` | `@charlie_deng/e2e-assistant-web` | Vue 工作台：Agent 工作台、Skill 管理、系统配置、Skill 开发页（Chat / 代码 / 结构化用例 / 报告 / 图片） |
| `apps/desktop` | `@charlie_deng/e2e-assistant-desktop` | 桌面端壳层预留位（Electron / Tauri 迁移用），当前未实现 |
| `packages/service` | `@charlie_deng/e2e-assistant-service` | 本地服务层（纯 API）：Hono 路由、Agent 工作通道运行时、生成运行时、测试执行编排、平台配置、工作区访问。**不含任何进程生命周期管理** |
| `packages/web-host` | `@charlie_deng/e2e-assistant-web-host` | 把 Web 构建产物挂到任意 Hono 应用上；路径穿越防护、安全响应头、产物缺失时返回 503 降级页 |
| `packages/agent` | `@charlie_deng/e2e-assistant-agent` | E2E Agent SDK：`AgentService.chat` 门面、`AgentLoop` 核心、Harness 插件、工具（工作区 / 浏览器 / 工作台 / 提问）、系统技能、SQLite 会话 |
| `packages/playwright-engine` | `@charlie_deng/e2e-assistant-playwright-engine` | 独立 Playwright 能力 SDK：Chromium 安装、浏览器会话与 frame、网络策略、候选脚本静态校验、真实测试执行器、HTML 报告渲染 |
| `packages/skill-manager` | `@charlie_deng/e2e-assistant-skill-manager` | Skill 领域存储：manifest、`e2e_schema.json`、`SKILL.md`、`test.spec.ts`、`env.json`、文件树、路径守卫、基线、报告、锁与原子写入 |
| `packages/types` | `@charlie_deng/e2e-assistant-types` | 跨包契约：Zod 领域 Schema、API 请求/响应类型、事件与工作块协议、协议版本常量 |
| `packages/config` | `@charlie_deng/e2e-assistant-config` | 用户级配置目录解析（跨平台路径约定） |

### 6.3 依赖方向与边界

核心不变式：

```text
apps/cli ──▶ packages/service ──▶ packages/agent / playwright-engine / skill-manager
    │                │
    │                └──▶ packages/types · packages/config
    └──▶ packages/web-host ──▶ apps/web
```

- **CLI 在最顶端**：`pnpm release:check` 会检查没有任何包依赖 CLI，避免「提供能力」与「管理进程」的边界失效；
- **service 不依赖任何前端包**：它因此可以独立部署为纯 API 服务；页面由 `web-host` 通过 `extendApp` 扩展点挂到同一地址；
- **web-host 与 service 互不依赖**：两者只在调用方（CLI）处组合；
- **agent 不依赖 playwright-engine 的启动实现**：浏览器会话、凭据解析、截图归档、测试执行器都以端口（接口）注入，agent 包只消费能力；
- **跨包契约集中在 types**：前后端共用同一份 Zod Schema 与 API 类型，减少协议漂移；需要独立发布的 SDK（如 playwright-engine）可保留自包含的校验契约，避免被平台类型绑定。

### 6.4 工程设计思想

1. **分层与单一职责**：CLI 只管进程与命令，service 只提供能力，web-host 只管静态托管，agent 只管 Agent 循环与工具，engine 只管浏览器与确定性校验。谁提供能力、谁管理进程、谁负责展示，边界清晰。
2. **依赖倒转与可复用 SDK**：`packages/agent` 与 `packages/playwright-engine` 都是可独立使用的 SDK。Agent 需要浏览器时通过 `IBrowserSessionHost` 端口访问，宿主在生成任务开始前创建会话并按 `sessionId` 注册；未注册的会话拿不到浏览器工具。
3. **契约优先**：领域 Schema、API 契约、事件协议集中在 `packages/types`，用 Zod 在边界解析未知数据；前端与后端共享同一份类型。
4. **Harness 插件化**：`AgentLoop` 只依赖 `ISessionStore`、`IContextPolicy`、`IRetryPolicy`、`IEventAdapter`、`IObservability`、`IToolGuard` 等接口，默认用 Noop 实现补齐；新增能力 = 新增插件实现，而不是改核心。
5. **默认安全、显式放宽**：回环绑定、路径守卫、工具白名单、网络同源限制、危险命令清单、敏感值脱敏、截图大小上限。跨源 iframe 等能力必须显式授权，不能靠提示词约束。
6. **人审闭环**：所有 AI 产物都走「候选 → 静态校验 → 预览/差异 → 用户确认 → 落盘」；质量问题和安全问题分级处置——质量问题提示，安全问题阻断。
7. **单一数据源与目录边界**：`e2e_schema.json` 是用例唯一业务数据源，`manifest.json` 只做列表投影；`temp/`（任务中间产物）、`userWorkSpace/`（长期测试产物）、`test_report/`（平台报告）三者边界互斥。
8. **可观测性内建**：Agent 工作以工作块（work block）物化，SSE 支持断线续传与恢复；工具动作有细粒度图标、耗时、命令输出、待办进度；CLI 有状态面板、日志与只读 `status`。
9. **工程护栏**：Turborepo 统一构建/测试流水线；Changesets 管理版本；`release:check` 校验包元数据、bin shebang、依赖方向（禁止依赖 CLI、禁止 service 依赖 web、web-host 必须声明 web 依赖）。
10. **本地优先**：不引入云数据库与平台侧后端，除模型调用外全部在本地完成；用户的项目目录就是事实来源，平台崩溃或卸载后，用例、脚本、报告仍然可用。

---

## 7. 数据与目录

### 7.1 用户级配置目录

| 数据 | 位置 | 归属 |
| --- | --- | --- |
| 平台配置 | `~/.config/e2e_assistant/config.json`（Windows：`%APPDATA%\e2e_assistant\config.json`） | `packages/service` |
| 运行态记录 | `~/.config/e2e_assistant/runtime.json` | `apps/cli` |
| 后台服务日志 | `~/.config/e2e_assistant/logs/service.log`（轮转件 `service.log.1`） | `apps/cli` |
| Agent 会话库 / 工作块库 | `<工作区>/.e2e-agent/{sessions,work-blocks}.db` | `packages/service` |

### 7.2 项目目录与 Skill 目录

```text
<projectDirectory>/
├── skill.list.json                    # Skill 列表投影
└── <安全化后的Skill名称>_<skillId>/     # 一个 Skill = 一个 E2E 用例
    ├── manifest.json                  # 身份、摘要、版本、生成元数据
    ├── e2e_schema.json                # 结构化用例（唯一业务数据源）
    ├── SKILL.md                       # Agent 生成的可读测试说明
    ├── test.spec.ts                   # Playwright 测试脚本（生成或手写）
    ├── env.json                       # 敏感数据真实值（Agent 不可读值）
    ├── userWorkSpace/                 # 长期保留的测试产物
    │   └── baselines/                 # 视觉基线（默认位置）
    ├── test_report/
    │   └── <yyyyMMdd-HHmmss>/         # 每次执行一份
    │       ├── report.html            # 自包含单文件报告
    │       └── summary.json           # 机器可读摘要（执行历史/对比）
    └── temp/                          # Agent 任务期间临时区，任务终态整体删除
        └── exploration/               # 页面核对截图（仅生成期间可见）
```

> 目录约定：`test_report/` 与 `temp/` 不属于 Skill 的正式产物；`userWorkSpace/` 属于正式产物，跨会话保留。

---

## 8. 开发与测试

```bash
# 全仓构建（按依赖顺序构建所有 packages 与 apps）
pnpm build

# 只构建 Web 或 CLI
pnpm build:web
pnpm build:cli

# 运行全部单元 / 集成测试（Vitest）
pnpm test

# 类型检查
pnpm typecheck

# 仓库级 Playwright E2E（会先 pnpm build；本机需安装 Chrome）
pnpm test:e2e

# 清理开发数据库（工作区 .e2e-agent 下的会话库与工作块库，业务文件不受影响）
pnpm db:reset

# 发包前静态自检（包元数据、bin shebang、依赖方向、changeset；需存在 .changeset/config.json）
pnpm release:check

# 格式化
pnpm format
```

开发提示：

- `pnpm dev` 会同时监听 `packages/*` 的 `dist` 与 `apps/cli/src`，CLI 自动重启；修改 Web 由 Vite 热更新；
- `scripts/check-dev-ports.mjs` 会在 `pnpm dev` 前检查 5176 / 5826，避免端口冲突；
- agent 包源码使用 `?raw` 导入 Markdown，直接 `node` / `tsx` 运行需配合 `packages/agent/scripts/md-raw-loader.mjs`（详见 `packages/agent/README.md` 的本地调试章节）。

---

## 9. 文档索引

各包 README 记录了更细的模块边界、数据归属与设计取舍：

- [CLI 命令层](apps/cli/README.md)：命令语义、进程生命周期、终端展示分层
- [本地服务层](packages/service/README.md)：HTTP API、内部依赖方向、扩展点
- [Agent SDK](packages/agent/README.md)：AgentLoop / Harness / 工具 / 技能 / 会话
- [Playwright Engine SDK](packages/playwright-engine/README.md)：浏览器会话、校验、执行器、报告
- [Playwright Engine 架构设计](packages/playwright-engine/ARCHITECTURE.md)：更完整的 SDK 设计说明
- [Web 静态托管桥](packages/web-host/README.md)：页面与 API 的同源组合方式

---

**License**：仓库当前未声明开源许可证，使用前请与作者确认。
