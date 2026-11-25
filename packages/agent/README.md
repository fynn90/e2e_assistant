# Authine E2E agent

E2E Agent SDK。核心职责：将用户编写的 E2E 测试用例转换为可执行的 `SKILL.md + Playwright 脚本`，
并通过 Agent 对话驱动工具在指定工作区中完成创建、更新、执行与校验。

核心模型：**一个会话（sessionId）= 一个复用的 AgentLoop + 一份持久化历史**。
`AgentService` 对外只提供 `chat` 方法；具体 Skill 由客户端在 prompt 中通过 `load_skill` 按需触发。

技术栈：

- @earendil-works/pi-ai@0.84.1
- @earendil-works/pi-agent-core@0.84.1

> 📖 面向调用方的多轮对话用法见 [docs/agent-service.md](docs/agent-service.md)。

---

## 设计思想

### 1. 核心与外围分离

`AgentLoop`（核心驱动）只负责把 pi-agent-core 的 `Agent` 跑起来——驱动主循环、执行工具、发射事件。
对话之外的一切生产问题（持久化、压缩、重试、事件翻译、观测、安全）全部收敛到外围 **Harness 层**，
不在核心代码里耦合。

### 2. 插件机制（Harness）

Harness 的每个能力都是**一个接口（契约）**，实现可替换、可组合、可扩展：

- 核心 `AgentLoop` 只依赖插件接口，不依赖实现；
- 同一接口可有多个实现，构造时传入即可替换，核心零改动；
- 未传的插件用 Noop 默认实现补齐，缺省可用、向后兼容。

```text
┌──────────────────────────────────────────────┐
│                  上层调用方                    │
│           （CLI / Web / service）              │
└──────────────────┬───────────────────────────┘
                   │ run(input) / subscribe(appEvent)
┌──────────────────▼───────────────────────────┐
│        AgentLoop（核心驱动，组合根）             │
│   驱动 pi-agent-core Agent + 编排插件生命周期    │
└──────┬────────┬────────┬────────┬────────────┘
       │        │        │        │
  ISessionStore IContextPolicy IEventAdapter IObservability
  IRetryPolicy  IToolGuard     （实现可替换）
```

插件接口：`ISessionStore`（会话持久化）、`IContextPolicy`（上下文压缩）、`IRetryPolicy`（重试退避）、
`IEventAdapter`（事件协议翻译）、`IObservability`（日志 / 用量 / 成本）、`IToolGuard`（工具安全守卫）。
详见 [PRD/harness-plan.md](PRD/harness-plan.md)。

### 3. 自研而非套壳

不直接消费 pi-agent-core 的 `AgentHarness`，而是以 `Agent` 为核心驱动、按自身架构自研 Harness。
目的：**边写边学生产环境 Harness 需要哪些组件**，并贴合 E2E 测试平台的实际形态。
pi-agent-core 的类型定义（`AgentHarness` / `Session` / compaction）作为学习参照。

### 4. 契约优先 + 依赖单向

- 每个模块先有接口（`I*`），再谈实现；模块之间只依赖接口。
- 依赖方向统一为 `service → loop → plugins(harness) → agents/model/tools → resources`，禁止反向依赖。
- 遵守单一职责与开闭原则：新增能力 = 新增插件实现，而不是改核心。

---

## 架构设计

### 模块总览

```text
src/
├── service.ts             # AgentService（SDK 对外门面：仅 chat）
├── service/               # 业务门面：把用户输入接入多轮任务引擎
│   ├── create.ts          #   历史 create 类型任务实现（不作为 AgentService 公开入口）
│   ├── update.ts          #   历史 update 类型任务实现（不作为 AgentService 公开入口）
│   ├── chat.ts            #   createE2EChat（chat 类型任务入口）
│   └── skill-chat.ts      #   createSkillChatRuntime（Skill Chat SSE 桥接）
├── task/                  # 多轮任务引擎：任务 = 会话 + AgentLoop + 持久化历史
│   ├── types.ts           #   IAgentTaskHandle / ITaskStatus / 配置类型
│   ├── task-handle.ts     #   AgentTaskHandle（句柄：send / continue / subscribe / …）
│   └── task-runner.ts     #   AgentTaskRunner（任务注册表 + 轮次串行化）
├── loop/                  # 核心驱动：封装 pi-agent-core Agent
│   └── agent-loop.ts      #   AgentLoop / createAgentLoop（组合根，编排插件生命周期）
├── harness/               # Harness 插件机制
│   ├── interfaces.ts      #   插件接口（ISessionStore / IContextPolicy / …）
│   ├── resolver.ts        #   未配置插槽用默认实现补齐
│   ├── defaults.ts        #   Noop / 透传默认实现
│   └── index.ts
├── agents/                # Agent 配置：系统提示词 + 工具组合
│   ├── authineE2E-agent.ts#   createAuthineE2EAgentConfig
│   ├── factory.ts         #   AgentFactory（按操作类型创建配置）
│   └── types.ts           #   IAgentBaseConfig / AgentOperateType
├── model.ts               # 模型运行时：IModelInfo → pi-ai 模型 + streamFn + 思考等级
├── session/               # 会话层：memory / sqlite 持久化 + 上下文压缩
├── tools/                 # 工具：load_skill + 工作区 bash/read/write/edit + 浏览器页面核对
│   └── browser/           #   browser_navigate / snapshot / query（只读核对）
│                          #   + browser_click / select / fill / waitFor / screenshot
│                          #     （v12-pre 交互与视觉；fill 为 v20 凭据代理）
│                          #   + 按会话授权的浏览器宿主注册表（sessionId 接缝）
├── prompt/ skills/        # 系统提示词与系统技能（markdown 资源）
├── resourceLoader.ts      # 资源加载器：prompt / skill 注册、解析、缓存、模板渲染
└── resources/             # 资源解析基础设施（frontmatter / registry / template）
```

### 多轮会话模型

一个会话（sessionId）对应一个复用的 `AgentLoop` 与一份持久化历史：

- `chat(prompt, options?)` 返回任务句柄，同一 sessionId 的多次调用共享会话；
- 客户端可在 prompt 中要求 Agent 调用 `load_skill` 选择具体业务 Skill，也可只描述业务意图，由 Agent 依据系统提示词中的技能列表自行匹配；
- `handle.send(input)` 在同一会话内续轮，历史自动带上；会话在显式释放前保持打开；
- 同一会话并发轮次自动串行排队，不同会话并行；
- 默认会话存储为 SQLite（`<workspace>/.e2e-agent/sessions.db`），服务重启后按 sessionId 断点续跑。

用法示例见 [docs/agent-service.md](docs/agent-service.md)。

### 测试用例 Skill 文档生成

使用 `chat` 时，客户端在 prompt 中传入结构化 `test_case`，并要求 Agent 调用
`load_skill` 加载 `test_case_Skill_document`。该 Skill 规定 frontmatter、章节、步骤映射、
敏感数据处理和固定目标文件写入规则；Agent 使用受限 `write` 工具将最终 Markdown 写入服务端
指定的 `<skill-directory>/SKILL.md`。CLI 读取并校验该固定文件，Web 展示后由确认接口提交
`manifest.generatedSkill` 元数据。

步骤的 `action` 与 `expectedResult` 以 ```text 围栏代码块承载原文（v12）。代码块内不参与
Markdown 结构解析，因此多行字段无需为保持列表从属关系而改写缩进——这正是此前含多行字段的
用例无法生成的原因。对应的服务端覆盖度校验（`checkEnabledSteps`）逐行忽略行首缩进与行尾空白，
仅要求字段各行**按原顺序连续出现**；步骤标题提取会先剥离代码块，避免块内 `1. **xxx**` 形态的
枚举行与真实标题混淆。

未经确认不会更新生成元数据；Agent 不得写入 `manifest.json`、`e2e_schema.json`、`test.spec.ts`
或 Skill 目录外的文件。

### Playwright 脚本生成与页面元素核对（v7）

生成 Playwright 脚本时，客户端只表达业务意图（根据当前 `SKILL.md` 与 `e2e_schema.json`
创建或更新 Playwright 脚本）并内联传入结构化 `test_case`、当前有效 `SKILL.md` 正文与候选脚本写入路径；
由 Agent 依据系统提示词中的技能列表自行匹配并加载 `playwright_script_generation`——
应用层不点名 Skill 名称，也不点名任何 Agent 工具（分层职责见下）。该 Skill 规定：
必须先核对目标页面真实元素，再按启用步骤顺序生成脚本，禁止仅凭文本推断选择器。

页面核对依赖八个浏览器工具（`src/tools/browser/`）：

| 工具                       | 作用                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `browser_navigate`         | 在用例 `baseUrl` 同源范围内打开目标页面                        |
| `browser_snapshot`         | 采集有界可访问性树与候选定位器                                 |
| `browser_query`            | 按 selector 查询元素的标签、角色、文本和属性                   |
| `browser_click`            | 点击元素，用于核对「点击后才出现」的元素（弹框、展开项）       |
| `browser_select`           | 在下拉框中选中选项，用于核对「切换后才更新」的区域             |
| `browser_fill`             | 在输入框中填入文本；敏感数据以 `${ENV:KEY}` 引用填入（v20）    |
| `browser_waitFor`          | 按条件等待页面状态（元素状态 / 加载状态 / URL / 固定等待兜底） |
| `browser_screenshot`       | 截取页面或元素截图并作为图片回传模型                           |
| `browser_capture_baseline` | 把元素截图保存为「新旧 DOM 对比」的**视觉基线**（v12）         |

`browser_click` 起的四个工具是 v12-pre 新增的交互与视觉能力：只读快照看不到交互后才出现的元素，
也看不出「被遮挡 / 布局错乱」这类纯视觉问题。

**`browser_fill`（v20 凭据代理）**：多步骤用例的第一步常常是登录，而密码存放在
Skill 的 `env.json` 中、Agent 不得读取。本工具让 Agent 填入 **`${ENV:KEY}` 引用**
而非真值，由宿主注入的凭据解析端口在填入前换取真值——**模型与其上下文全程只见到引用**。
解析出的真值会立即登记进会话脱敏器，且密码输入框的值在快照与元素查询中恒被屏蔽，
因此填入后无法被回读。未注入解析端口时引用形态直接报错，不会静默填入占位符文本。

`browser_capture_baseline`（v12）一次完成「看清页面」与「存下基线」：截取元素的**完整内容**
（含内部滚动区域）后落盘到 `<skillRoot>/baselines/<分组>/`，并把图片同时回传模型确认。
它与 `browser_screenshot` 的关键差异是**失败语义**——截图归档是旁路能力（失败可降级为
「界面不展示」），而基线是**正式产物**，落盘失败必须明确报错，否则执行期会因基线缺失
而整体失败且用户看不到根因。

**用户可见性（v12-pre 追加）**：Agent 的行为在 Web 端可见，两者各有一条独立通道：

| 能力          | 通道                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 动作图标      | `tool` 块携带 **`action`（细粒度动作身份）** 与 `category`（粗粒度分组）两轴：`action` 供客户端选图标、`category` 供选配色。两者由 `tool-presenter.ts` 的规则表产出，**浏览器动作的 action 与 title 同源于一张 `BROWSER_ACTIONS` 表**——避免新增浏览器工具时只改了标题、图标却全部塌缩成同一个。新增工具只需在 `PRESENTER_RULES` 登记一行，前端零改动 |
| 截图缩略图    | 字节**不走事件通道**（会经脱敏器替换 `data` 字段、并常驻断线续传缓冲）。CLI 把截图写入 Agent 临时工作区之下的 `<skillRoot>/temp/exploration/<sessionId>/`，事件只带 `image: { url, width, height }` 引用，客户端按 URL 懒加载。图片随 `temp/` 在任务终态删除，故该引用只在生成过程中有效（历史会话显示占位）                                         |
| 任务清单      | `todo_write` 工具 + `todo` 工作块（与 `bash` → `command` 同构的特殊翻译）：清单在工具 start 时整体下发，时间线渲染为进度条清单，生成阶段卡片头部显示「任务清单 N/M」                                                                                                                                                                                 |
| 等待/交互耗时 | 工具卡片展示 `durationMs`（来自 `tool_execution_end`），无需额外接线                                                                                                                                                                                                                                                                                 |

**归档端口 `IScreenshotArchive`**：宿主（CLI generation-runtime）注入；未注入或归档失败时截图照常回传模型，只是界面不展示缩略图——界面问题不升级为工具失败。

**归档端口 `IVisualBaselineArchive`（v12）**：与上者的**失败语义相反**——基线是正式产物，
未注入端口或落盘失败时工具直接报错，不静默降级。

**`todo_write` 的守卫约束**：生成守卫对未白名单工具是**阻断并终止本轮**的，因此该工具必须在 `generation-tool-guards.ts` 中显式放行，否则一次清单更新会直接杀掉整个生成任务。`browser_capture_baseline` 走 `browser_` 前缀自动放行，同样有回归测试保护。

使用策略（已写入生成提示词，`skills/playwright_script_generation/`）：

- **定位优先用快照**：`browser_snapshot` / `browser_query` 返回结构化数据、信息密度高、
  体积小，效率明显高于截图；仅当快照**无法满足定位需求**（Canvas、自绘组件）或
  **定位不够精准**（需确认遮挡、布局、实际位置）时才用 `browser_screenshot`；
- **多步骤用例先列 todo 清单再逐步推进**：后续步骤的页面必须在完成前序交互后才存在，
  因此要一步一核对、边做边记录定位方式，不能在初始页面上推断后续步骤的元素；
- **视觉回归核对（v12）**：步骤要求「截图对比 / 新旧 DOM 对比」时，先用
  `browser_capture_baseline` 捕获基线，再在脚本中内联给定的模板做比对。
  模板与九条硬约束写在 `skills/playwright_script_generation/visual-regression.md`，
  其中三条违反即阻断生成（参数须显式 `any` 标注、`expect` 只接受 1 参、
  比对循环必须在 `test.step` 内）。
- **类型标注（v13）**：自己声明的函数与回调，参数一律显式标注 `: any`。
  引擎的语义 shim 已声明 `Page` / `Locator` 的常用方法，故 `page.on(...)`、
  `page.getByRole(...)` 等**已声明方法**的回调有了上下文类型；
  但自定义函数的参数、以及挂在自定义 `any` 参数上的调用仍无从推断，漏标即报隐式 any 并阻断生成。
  详见 `skills/playwright_script_generation/generation-rules.md` 第 11 条。

### 技能文件组织（v12）

`playwright_script_generation` 的内容较长，已由单文件**重构为目录**：

```text
src/skills/
├── index.ts                        # 注册表：读主文件 + 子文件，注册期组装
├── compose-skill.ts                # 静态包含（{{> 子文件名 }}）的组装工具
└── playwright_script_generation/
    ├── index.md                    # 主文件：用途 / 章节索引 / 输入数据 / 组成声明
    ├── page-verification.md        # 页面核对流程
    ├── multi-step-flow.md          # 多步骤清单推进
    ├── visual-regression.md        # 视觉回归核对（模板 + 硬约束）
    ├── output-format.md            # 输出格式
    ├── generation-rules.md         # 生成规则（含平台静态校验的硬约束）
    └── delivery.md                 # 交付要求
```

**组装发生在注册期**：技能正文在构建期经 `?raw` 内联进内存注册表，运行期没有按路径读子文件
的能力（`load_skill` 只按名取整段内容），因此主文件写 `{{> 子文件名 }}` 占位符，
由 `compose-skill.ts` 在注册时展开。对模型而言仍是一份**完整连续**的 Skill 文本，没有额外读取步骤。

> 静态包含用 `{{> name }}`，运行期变量替换用 `{{ name }}`，两者语法刻意区分
> （见 `resources/template.ts`），避免运行期替换误伤静态包含。

### 任务清单工具（v12-pre）

| 工具         | 作用                                                           |
| ------------ | -------------------------------------------------------------- |
| `todo_write` | 维护多步骤核对清单（整体替换语义），驱动时间线进度条与阶段摘要 |

对所有场景开放（包括普通 Chat 与 SKILL.md 生成）：它不读写文件、不访问页面，
对生成任务的边界没有任何影响；放行的理由是多步骤任务的可见性——用户据此判断
Agent 是否按用例推进。清单条目上限 50、单条内容截断 200 字符、同一时刻最多一项
`in_progress`。

**vision 依赖**：`browser_screenshot` 的图片要真正到达模型，`model.ts` 必须声明
`input: ["text", "image"]`（当前默认开启）。pi-ai 只在 `model.input` 含 `image` 时
把工具结果中的图片附给模型，否则会**静默丢弃**并只发 `"(see attached image)"` 占位文本。
注意：对接不支持 vision 的兼容端点会在图片请求上报错，且影响范围是全部 Agent 功能。

**授权模型（依赖倒转）**：agent 包不创建浏览器进程。CLI 的 generation-runtime 在生成任务
开始前启动浏览器会话并登记到 `browserSessionRegistry`（以 `sessionId` 为接缝），
Agent 配置工厂据此为该会话注入浏览器工具。未登记的会话（普通 Chat、SKILL.md 生成）
不会获得浏览器工具，因此 Agent 只能在显式授权的生成任务中访问目标页面。

候选脚本只写入当前 Skill 的 `temp/` 临时工作区（该目录同时承载探查截图等
Agent 工作期间的中间内容，任务终态整体删除）；工具守卫只放行 `load_skill`、
`browser_*`、工作区内的 `read` 与指定目标 `write`（`read` 限工作区内，
且 v10 起拒绝读取保存敏感数据真实值的 `env.json`——生成任务只需用例数据中的
`${ENV:KEY}` 引用，值由执行运行时注入，这是结构性安全保证而非提示词约束；
SKILL.md 生成路径不获得浏览器工具）。

**分层职责**：CLI 应用层只表达业务意图与必要参数，不指名 Skill、也不指名 Agent 工具；
生成规则（加载哪个 Skill、如何核对页面、产物写到哪）全部由 Skill 文档承载。
守卫的阻断文案同样不点名工具——它会作为工具结果进入模型上下文，
工具清单属于 agent 包的实现细节。

### 测试执行发起（预留）与 bash 管控（v11）

测试执行的发起入口当前为**文件树按钮**（不经模型）；Chat 发起链路已按依赖倒转
模式预留、本期**未接线**（SKILL 页暂无 Chat 面板入口），恢复时按以下预留件接线：

| 项                                                                                  | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute_test` 工具（`src/tools/execute_test.ts`，已实现未注入）                    | 发起当前 Skill 的测试执行。**非阻塞返回**：就绪失败返回结构化问题列表；发起成功立即返回执行 ID。参数预留可选 `skillId` 供未来全局 Chat 指定 Skill，本期传入即拒绝。恢复方式：CLI 组合根创建宿主工厂 → Skill Chat 路由传 `runnerHost` → `createSkillChatRuntime` 内经 `extraTools` 注入                                                                                                                                                                                                                                                                                                                                                                         |
| `ITestRunnerHost` 宿主接口                                                          | 与浏览器工具同构的依赖倒转：agent 包只定义端口并消费结果；就绪校验（J1–J8）与 env.json 值拼装由 CLI 侧适配器完成，值不经过 Agent（结构性隔离）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test_script_execution` 技能（`src/skills/test_script_execution.md`，已实现未注册） | Agent 判定「执行测试」任务时先 `load_skill` 加载再按指引调用 `execute_test`。恢复时在 `src/skills/index.ts` 的 skillMap 与 authineE2E-agent 的 skillsBlock 重新登记                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Chat 工具范围（A1 分级，已生效）                                                    | Skill Chat 的文件工具绑定**当前 Skill 目录**（而非平台工作区）；会话数据库仍落在平台工作区 `.e2e-agent/`，Skill 目录内不产生任何非产物文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bash-guard`（`src/guards/bash-guard.ts`，已生效）                                  | bash 放开可用，但命中危险命令清单（递归强删/磁盘系统/注册表权限/远程执行/计划任务/引用 env.json）时**拒绝执行但不终止会话**；清单与判定单点维护，生成守卫与 Chat 工具同源复用。目录约定：`src/tools/` 只放 Agent 可直接调用的工具对象，守卫类纯函数放 `src/guards/`                                                                                                                                                                                                                                                                                                                                                                                            |
| bash 可执行文件路径（`shellPath`，已生效）                                          | `createWorkspaceExecutionTools` / `createAuthineE2EAgentConfig` / `AgentFactory` / `AgentService` 均接受可选 `shellPath`，显式指定 bash.exe 绝对路径并传给 `NodeExecutionEnv`；缺省时 pi-agent-core 按平台默认规则探测（Windows 仅查 Program Files 下 Git Bash 与 PATH，探测不到 bash 工具即不可用）。CLI 在服务启动阶段探测一次并逐层注入（Skill Chat 运行时与 agent-work 运行时两条链路），探测失败仅警告不阻断启动。工具工厂同时从 `shellPath` 推导 bash 伴随工具目录（usr\bin、mingw64\bin、cmd 等）前置进子进程 PATH——非交互 bash（`-c`）不加载 profile，PATH 继承服务进程，父进程缺少 Unix 工具目录时 `ls`/`grep` 等会报 command not found（退出码 127） |

---

## 本地调试（VSCode Run and Debug）

agent 包源码通过 `?raw` 导入 markdown（如 `src/prompt/index.ts` 里的 `.md?raw`），
只有打包器认识该语法，直接 `node` / `tsx` 运行源码会报
`ERR_UNKNOWN_FILE_EXTENSION: ".md"`。仓库已配置好通用调试方案：

- `scripts/md-raw-loader.mjs`：自定义 ESM loader，把 `.md?raw` 解析为文本模块；
- `.vscode/launch.json`：三个通用调试配置（`tsx` 负责 TS 转译 + 扩展名解析）。

### 调试任意文件

1. 打开要调试的 TS 文件（如 `src/agents/authineE2E-agent.ts`）；
2. 在目标行打断点；
3. 运行和调试侧边栏选择 **「agent: 调试当前打开的 TS 文件」**，按 F5。

### 调试任意函数

参考 `scratch/debug-example.ts`：在 scratch 脚本里 import 目标函数并调用，
按 **「agent: 调试 scratch 脚本」** 运行，命中断点后单步进入函数内部。

### 命令行快速运行

```bash
cd packages/agent
node --import tsx --import ./scripts/md-raw-loader.mjs <目标.ts>
```

> tsx 已加入 agent 包 devDependencies，`.md?raw` 由 md-raw-loader 处理，
> 二者配合即可直接运行/调试任意源码文件。

---

## 会话生命周期与错误边界

- 生成目标路径由 CLI 后端解析，不能由浏览器提交；
- `AgentService.chat` 产生的 `sessionId` 用于追踪本次生成和工具审计；
- 工具守卫只允许 `load_skill` 与后端指定目标 `write`；
- Agent 取消或运行失败时，CLI 负责释放任务、会话存储和 Skill lock；
- 文档校验失败不提交 `manifest.generatedSkill`，并在确认前保留可诊断的错误状态。

## 版本说明

Version 6 的核心边界是：Chat Agent 负责根据系统 Skill 生成并写入 `SKILL.md`，Skill Manager
负责固定文件安全和元数据确认；Playwright 脚本生成与执行属于后续阶段。

未把模型写盘权限扩展到任意工作区文件，也不恢复 `AgentService.createSkill` / `updateSkill` 入口。
