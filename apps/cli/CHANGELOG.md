# @authine-e2e-agent/cli

## 0.3.1

### Patch Changes

- 优化架构
- Updated dependencies
  - @authine-e2e-agent/config@0.0.6
  - @authine-e2e-agent/service@0.2.3
  - @authine-e2e-agent/types@0.1.3
  - @authine-e2e-agent/web-host@0.0.6

## 0.3.0

### Minor Changes

- 启动面板与状态面板新增 CLI 版本行，`start` 面板的「协议」行退役。

  - 新增 `src/infrastructure/cli-package-version.ts`：经**包自我引用**从自身
    package.json 运行时读取版本号。不采用构建期注入，是因为版本号由 changesets
    唯一维护在 package.json 里，注入会引入第二处需要同步的定义，漏改即出现
    「面板报的版本与实际安装的版本对不上」。为此 `@authine-e2e-agent/cli` 的
    `exports` 增加 `./package.json` 白名单项（缺它只会拿到
    `ERR_PACKAGE_PATH_NOT_EXPORTED`）。源码（tsx）与构建产物（dist）两种运行
    形态均可解析，且与当前工作目录无关。
  - `e2e_assistant start` 面板：原 `🧩 协议 v6` 行替换为 `📦 cli v<版本>`。
    协议版本是服务间比对用的内部标识，对用户没有意义；用户真正需要的
    是「我装的是哪个版本的 CLI」，出问题时报出版本号即可。
  - `e2e_assistant status` 面板：新增 `📦 cli v<版本>` 行，与既有的
    `🧩 协议 v<n>` 行**并存**——后者是服务**自报**的协议版本，能发现
    「跑着的是一个旧版服务」，二者不一致正是需要排查的信号，故不合并成一行。
  - 版本不可得（包环境不完整导致解析失败）时不渲染该行，不补占位——与 PID、
    启动时间「不可得即不渲染」的既有约定一致，避免给用户看到 `vundefined`。

### Patch Changes

- 更新 CLI
- Updated dependencies [9466e14]
- Updated dependencies
  - @authine-e2e-agent/service@0.2.2
  - @authine-e2e-agent/config@0.0.5
  - @authine-e2e-agent/types@0.1.2
  - @authine-e2e-agent/web-host@0.0.5

## 0.2.1

### Patch Changes

- 优化 playwright engine
- Updated dependencies
  - @authine-e2e-agent/config@0.0.4
  - @authine-e2e-agent/service@0.2.1
  - @authine-e2e-agent/types@0.1.1
  - @authine-e2e-agent/web-host@0.0.4

## 0.2.0

### Minor Changes

- 8137fe6: `start` / `stop` / `log` 三条命令的终端输出改为圆角卡片面板，并按终端能力分级渲染。

  - 新增 `src/presentation/console/` 展示层：宽度计算（CJK / emoji / ANSI 感知）、
    配色、面板渲染器与三个命令的内容装配，各自单一职责。
  - 输出分三级：宽终端出完整圆角卡片（含配色与吉祥物）、窄终端出无边框彩色行、
    管道与 CI 出纯文本。非 TTY 下 `util.styleText` 自动降级，故测试与脚本拿到的
    仍是可解析的纯文本。
  - 面板新增进程 PID、启动时刻、协议版本与可读状态行；日志路径按可见宽度截断，
    不再顶破边框。
  - 结论文案（`已优雅停止` 等）、启动播报（`started in the background`、
    `already running`）逐字保留，既有 e2e 用例零改动通过。
  - 渲染结果的数据依赖随之补齐：`ILaunchBackgroundServiceResult` 与
    `IStartPlatformServiceResult` 新增 `pid` / `startedAt` / `mode`，
    `IStopPlatformServiceResult` 新增可选的 `pid` / `startedAt` / `port`。

- 6ba9079: 新增 `e2e_assistant status` 命令：只读查看本地服务状态。

  - 服务运行中：给出状态、地址、端口、PID、启动时间、已运行时长、协议版本与日志路径，
    并提示可直接在浏览器打开该地址进入工作台；命令提示为 `log -f` 与 `stop`
    （不提示 `status` 自身——用户刚刚才敲过）。
  - 服务未运行：按成因区分「从未启动 / 服务已停止（残留记录）/ 记录损坏」，
    并给出 `e2e_assistant start` 启动命令。
  - 无法确认（端口被占用但不回应健康探测）：单独呈现，**不给任何动作建议**——
    此时启动会抢占端口并覆盖记录、停止则可能误杀无关进程。
  - **只读硬性质**：不启动、不结束进程、不清理运行态记录。即使判定为无法确认
    也只如实报告。该性质由单测以「源码不引用任何写盘函数」的静态断言锁定。
  - 退出码区分三态，可直接写进脚本：`0` 运行中、`1` 未运行、`2` 无法确认。
    探测异常也收敛为 `2` 而非抛出——抛出会让命令包装器置退出码 1，
    与「服务未运行」撞车，导致脚本误判后去启动服务。
  - 协议版本取服务**自报**的版本（来自健康探测）而非本地常量，
    因此能发现「跑着的是一个旧版服务」。

  顺带修掉两处输出缺陷：

  - **bash 探测提示不再自己打印**（原为 `🚀【cli】检测到 bash 可执行文件：...`）。
    该提示改为结构化结果，由启动面板以 `🐚 bash 已就绪 / 未找到` 一行呈现；
    未找到时把修复指引放进面板的说明行。修掉的是两个问题：一是 application 层
    直接拼终端文案造成新旧排版混杂，二是后台模式下子进程的 stdout 被重定向到
    日志文件，那行提示既不在用户眼前、又混进了服务日志。
  - **后台子进程不再把自己的启动面板写进日志文件**。子进程走的 `--foreground`
    路径原先会照常打印面板，而其 stdout 指向日志文件——日志里因此混着一份面向
    用户的「怎么看日志、怎么停服务」。现按 `mode` 判定：仅当本进程不是后台子进程
    时才打印面板（用户手敲 `--foreground` 照常看到面板）。
  - 另外修正了 `wrapTextToWidth` 的中文折行：原先只按空格断词，中文整句会被当成
    一个词而任意硬切，出现半句被甩到下一行的排版。现改为拉丁文按空格断词、
    中文逐字断行（中文排版惯例），拼接时只为原本有空白处补空格。

  ### 顺带：清掉最后几处旧风格输出

  `🚀【cli】` / `⚠️【cli】` 前缀至此全部淘汰，CLI 的单行提示统一由
  `presentation/console/message-line.ts` 渲染（`ℹ️` / `⚠️` / `❌` + 与面板同一套配色）：

  - **bash 探测**（`bash-shell-check.ts`）不再 `console.log`，改为返回三态结果。
  - **日志轮转**（`log-file.ts`）不再 `console.warn`，改为在结果里返回失败原因，
    经启动器带到启动面板的说明行——「日志可能不连续」这件事必须在用户眼前说，
    而不是写进那个正在被讨论的日志文件。
  - **Node 版本校验**（`environment-check.ts`）不再 `console.error`，改为返回
    `{ satisfied, message }`，由命令层输出到 stderr。
  - **错误出口**（`run-command-with-environment-check.ts`）统一图标与配色；
    `Authine CLI 执行失败：<原因>` 的措辞与堆栈保留（PRD v18 有此约定），
    并去掉堆栈首行与正文重复的 `Error: <message>`。
  - **浏览器打开失败**（`open-browser-quietly.ts`）提示降为 `⚠️` 级别——
    这是功能降级而非操作失败，用 `❌` 会让人以为服务没起来。

  分层上，上述 application / infrastructure 模块一律只返回结果，终端格式由
  presentation 层负责；错误与警告全部走 stderr。

  ### 命令提示改为「每条命令一行 + 一句话作用」

  原先命令提示并排在一行（`👀 log -f    🛑 stop`），两个问题：并排时窄卡片放不下，
  渲染器只能**整条让位**（命令不可截断），于是窄终端上会「少一条命令」；且没有位置
  写作用说明。现改为每条命令独占一行、尾部跟一句说明，并把说明按最长命令左对齐成一列。

  同时新增 `presentation/console/panel-actions.ts` 收敛命令与说明的定义：`stop` 曾
  在三个面板里各拼一份，`log -f` 的说明已漂移出「跟随查看日志」与「实时查看服务日志」
  两种说法。现在同一命令只有一处定义。启动面板的提示顺序为
  `log -f`（仅后台）→ `status` → `stop`。

### Patch Changes

- 支持 iframe
- Updated dependencies
- Updated dependencies [30cce7f]
  - @authine-e2e-agent/config@0.0.3
  - @authine-e2e-agent/service@0.2.0
  - @authine-e2e-agent/types@0.1.0
  - @authine-e2e-agent/web-host@0.0.3

## 0.1.0

### Minor Changes

- 052303f: 后台服务化（v19）：`start` / `web` 默认后台运行（新增 `--foreground` 保留前台形态），新增 `log`（别名 `logs`）查看与跟随后台服务日志；`stop` 改为经服务层 `POST /api/shutdown` 端点优雅关闭（先在跑任务后关浏览器并释放资源），端点不可用时回退信号并说明；`closeServer` 升级为优雅序列（含强制关闭连接），修复 Ctrl+C 有 SSE 连接时挂起与子进程残留；`/assets/*` 成功请求不再打印日志。

  Windows / macOS / Linux 三端一致：配置与日志目录分别走 `%APPDATA%` / `XDG_CONFIG_HOME`；日志文件在 POSIX 上收敛为 0600（目录 0700）；`stop` 的回退文案按平台区分（POSIX 上 `SIGTERM` 可捕获，服务仍会执行收尾流程）；无图形环境下打不开浏览器不再把成功启动报成失败；优雅关闭路径的退出等待上限提高到 10 秒（覆盖服务侧「中止在跑任务 → 关浏览器 → 释放资源」完整序列）。

### Patch Changes

- 优化 cli运行
- Updated dependencies [052303f]
- Updated dependencies
  - @authine-e2e-agent/service@0.1.0
  - @authine-e2e-agent/config@0.0.2
  - @authine-e2e-agent/types@0.0.2
  - @authine-e2e-agent/web-host@0.0.2
