# @fynn90-e2e_assistant/service

## 0.2.3

### Patch Changes

- 优化架构
- Updated dependencies
  - @fynn90-e2e_assistant/agent@0.1.3
  - @fynn90-e2e_assistant/config@0.0.6
  - @fynn90-e2e_assistant/playwright-engine@0.1.3
  - @fynn90-e2e_assistant/skill-manager@0.0.6
  - @fynn90-e2e_assistant/types@0.1.3

## 0.2.2

### Patch Changes

- 9466e14: 修复工作台工具守卫漏放行 v17 工具的问题：`render_view`、`read_test_case`、`read_run_history`、`check_readiness`、全部提案工具与 `execute_batch` 不再被误拦截并终止对话。回归测试改为直接读取实际装配的工具清单，防止后续新增工具再次漏放行。
- 更新 CLI
- Updated dependencies
  - @fynn90-e2e_assistant/agent@0.1.2
  - @fynn90-e2e_assistant/config@0.0.5
  - @fynn90-e2e_assistant/playwright-engine@0.1.2
  - @fynn90-e2e_assistant/skill-manager@0.0.5
  - @fynn90-e2e_assistant/types@0.1.2

## 0.2.1

### Patch Changes

- 优化 playwright engine
- Updated dependencies
  - @fynn90-e2e_assistant/playwright-engine@0.1.1
  - @fynn90-e2e_assistant/agent@0.1.1
  - @fynn90-e2e_assistant/config@0.0.4
  - @fynn90-e2e_assistant/skill-manager@0.0.4
  - @fynn90-e2e_assistant/types@0.1.1

## 0.2.0

### Minor Changes

- 30cce7f: 新增凭据代理（v20）：Agent 可完成登录等需要敏感数据的页面核对步骤。

  ### 问题

  多步骤用例的第一步常是登录，而密码存放在 Skill 的 `env.json` 中、Agent 不得读取，
  导致核对阶段卡在登录页、后续步骤全部无法核对（只能凭文本推断选择器，而生成规则禁止编造元素）。

  排查中发现真正的卡点比「拿不到密码」更靠前：**引擎原先只有 `click` 与 `selectOption`，
  没有任何输入文本的能力**——即使把密码明文交给 Agent，它也无法走完登录表单。

  ### 能力

  `browser_fill`（agent）与 `IBrowserSession.fill()`（引擎）新增输入框填入能力。
  `value` 支持两种形态：普通明文，以及 `${ENV:KEY}` **引用** —— 后者由宿主注入的
  `ICredentialResolver` 端口在**填入前一刻**换取真值，模型与其上下文全程只见到引用本身。

  - 引擎无法定位 Skill 时（`rootDir` / `skillId` 缺省）不注入解析端口，
    此时引用形态**直接报错**，不会把 `${ENV:KEY}` 这串文本当密码填进页面——
    那会让错误推迟到断言阶段才暴露，排查成本极高。
  - 解析失败一律归类为稳定原因码（`not-found` / `unavailable` / `empty`），
    失败消息点名 env key 但不含任何值，可直接进入模型上下文供其自我修正。

  ### 安全不变式（三条，改动时必须同时满足）
  1. **先登记脱敏、再填入页面**——顺序不可调换。真值一旦进入页面就会被无障碍树
     与元素查询带出，必须保证脱敏器在那一刻已经认识它。
  2. **派生脱敏器必须继承运行期秘密**——快照按 `maxA11yLength` 派生新脱敏器时，
     若不把已登记的秘密传下去，运行期登记的值会在新实例上失效。这是回归测试
     实测捕获的真实缺陷：表现为「填入密码后第一次带自定义上限的快照把密码原样带出」。
     为此 `ISensitiveDataRedactor` 之外新增 `ISecretRegistrableRedactor`
     （`registerSecret` + `listSecrets`），并加 `isSecretRegistrable` 能力检测。
  3. **密码框按结构遮蔽，不依赖知道值**——实测确认 `ariaSnapshot()` 会把输入框当前值
     渲染成缩进子节点（`- textbox "密码":` + `- text: 明文`，中间还可能夹 `/placeholder` 行），
     元素查询的 `value` 字段同样会带出。现已按元素类型（`input[type=password]`）
     在快照与查询两处独立屏蔽，与脱敏器互为第二道防线——
     按结构遮蔽无需知道任何值即生效，可覆盖页面自身预填、真值未被登记等情形。

  ### 其他
  - 生成前置规则（`playwright_script_generation`）补入登录处理：明确「遇到登录页用
    `browser_fill` 填引用继续核对，不要停在断点上」，并说明引用必须整体成值、
    只可引用用例已声明的 key；验证码 / 二次验证仍属真实断点，照常披露。
  - 新增浏览器动作 `fill`，同步 `TAgentToolAction` 联合类型与前端图标表（`field-input-stroke`）。
  - 引用语法在两处同源：`types` 的 `ENV_REFERENCE_PATTERN`（全局扫描用例文本）与引擎
    `credential-resolver.ts` 的整串锚定版。跨包一致性由
    `packages/playwright-engine/test/credential-resolver.test.ts` 用同一批样本锁定，
    防止两侧漂移导致「用例里认得、引擎里不认」的静默不匹配。

### Patch Changes

- 支持 iframe
- Updated dependencies
- Updated dependencies [30cce7f]
- Updated dependencies [8c4aa8d]
  - @fynn90-e2e_assistant/agent@0.1.0
  - @fynn90-e2e_assistant/config@0.0.3
  - @fynn90-e2e_assistant/playwright-engine@0.1.0
  - @fynn90-e2e_assistant/skill-manager@0.0.3
  - @fynn90-e2e_assistant/types@0.1.0

## 0.1.0

### Minor Changes

- 052303f: 后台服务化（v19）：`start` / `web` 默认后台运行（新增 `--foreground` 保留前台形态），新增 `log`（别名 `logs`）查看与跟随后台服务日志；`stop` 改为经服务层 `POST /api/shutdown` 端点优雅关闭（先在跑任务后关浏览器并释放资源），端点不可用时回退信号并说明；`closeServer` 升级为优雅序列（含强制关闭连接），修复 Ctrl+C 有 SSE 连接时挂起与子进程残留；`/assets/*` 成功请求不再打印日志。

  Windows / macOS / Linux 三端一致：配置与日志目录分别走 `%APPDATA%` / `XDG_CONFIG_HOME`；日志文件在 POSIX 上收敛为 0600（目录 0700）；`stop` 的回退文案按平台区分（POSIX 上 `SIGTERM` 可捕获，服务仍会执行收尾流程）；无图形环境下打不开浏览器不再把成功启动报成失败；优雅关闭路径的退出等待上限提高到 10 秒（覆盖服务侧「中止在跑任务 → 关浏览器 → 释放资源」完整序列）。

### Patch Changes

- 优化 cli运行
- Updated dependencies
  - @fynn90-e2e_assistant/agent@0.0.2
  - @fynn90-e2e_assistant/config@0.0.2
  - @fynn90-e2e_assistant/playwright-engine@0.0.2
  - @fynn90-e2e_assistant/skill-manager@0.0.2
  - @fynn90-e2e_assistant/types@0.0.2
