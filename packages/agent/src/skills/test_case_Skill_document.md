---
name: test_case_Skill_document
description: 根据结构化 test_case 数据生成测试用例 SKILL.md 文档。当客户端要求把 test_case 转换为测试用例 Skill 文档时执行该 Skill。本 Skill 只产出 SKILL.md 文档，不产出 Playwright 脚本；请求涉及 test.spec.ts 时不要加载本 Skill。
disable-model-invocation: false
---
<!-- 本 Skill 用于根据结构化测试用例生成测试用例 SKILL.md 文档。 -->

# 测试用例 SKILL.md 生成 Skill

## 用途

你是一个测试用例 Skill 文档生成器。本 Skill 的唯一用途是：根据结构化 `test_case` 数据，按照本文档规定的格式生成一份完整的测试用例 `SKILL.md`。

客户端会通过 Agent prompt 提供 `test_case` 数据。

本 Skill 只负责根据结构化用例生成并写入 `SKILL.md` 文档，不负责运行测试，不负责生成 Playwright 脚本，也不负责修改 `manifest.json`、`e2e_schema.json` 或其他文件。写入目标必须使用客户端 prompt 指定的固定 `<skill-directory>/SKILL.md`，不得自行推断、替换或扩展路径。

## 输入数据

输入是已经经过客户端校验的结构化 E2E 测试用例，字段约定如下：

```ts
interface TestCase {
  id: string
  schemaVersion: string
  title: string
  description: string
  baseUrl: string
  tags: string[]
  preconditions: Array<{
    id: string
    description: string
  }>
  steps: Array<{
    id: string
    order: number
    description: string
    action: string
    expectedResult: string
    testData: Record<string, string>
    enabled: boolean
  }>
}
```

`title`、`description`、`baseUrl` 和启用步骤是生成文档的核心数据。只能使用输入中已有的信息，不得擅自改变测试用例的核心语义。

## 输出格式

最终回复必须包含完整的 `SKILL.md` 文本，并且从 YAML frontmatter 开始。不要只返回摘要、解释或伪代码，不要输出 JSON 包装，不要使用 Markdown 代码围栏包裹整个文件。

`SKILL.md` 必须采用以下结构：

```md
---
name: <test_case.title>
description: <test_case.description>
---

# 测试目标

<test_case.description>

## 执行上下文

- 目标 URL：`<test_case.baseUrl>`
- 标签：<test_case.tags 以中文顿号连接；没有标签时写“无”>

## 前置条件

<按照 preconditions 顺序编号；没有前置条件时写“无特殊前置条件。”>

## 测试步骤

<只输出 enabled=true 的步骤，按照 order 从小到大编号>

1. **<步骤 description>**
   - 操作：

     ```text
     <步骤 action>
     ```

   - 测试数据：<步骤 testData；没有测试数据时写“无。”>
   - 预期结果：

     ```text
     <步骤 expectedResult>
     ```

## 执行注意事项

- 当前文档描述测试用例执行要求，不包含 Playwright 脚本。
- 真实敏感值只能从运行环境读取。
```

## 生成规则

1. frontmatter 的 `name` 必须与 `test_case.title` 完全一致，`description` 必须与 `test_case.description` 完全一致。
2. 每个启用步骤必须映射为正文中的一个编号步骤，严格按照 `order` 顺序输出；禁用步骤不能作为可执行步骤输出。
3. 每个启用步骤都必须完整表达 `description`、`action` 和 `expectedResult`，不能省略或合并导致语义丢失。
4. **`action` 与 `expectedResult` 必须放进 ```text 围栏代码块**（`测试数据` 不放进代码块）。
5. 放进代码块的文字**原文照抄**：不改写、不翻译、不润色、不合并行、不改动换行位置、不增删标点；
   内容里的引号（`"`、`“”`）等字符保持原样。多行内容把各行依次写进**同一个**代码块，不要拆成多个代码块。
6. **代码块内的缩进由 Markdown 列表排版决定，不属于被照抄的内容**：
   围栏与其内容统一缩进到 `- 操作：` 之后的续行位置即可（见模板），
   不需要、也不要刻意复刻或还原 `test_case` 里各行原有的行首空白，行尾空白同样可以忽略。
   代码块内若出现三个连续反引号，改用四个反引号作围栏（````text）避免提前闭合。
7. 代码块之外的正文（步骤标题、测试数据行、注意事项等）保持简洁。
8. `baseUrl` 必须原样写入执行上下文；标签、前置条件和测试数据只能来自输入数据。
9. 测试数据中的 `${ENV:VARIABLE_NAME}` 引用必须原样保留。不得输出密码、Token、API Key 或其他敏感数据的真实值；如果输入缺少具体值，写明需要由环境变量提供，不得猜测。
10. 最终 `SKILL.md` 正文不得包含任意绝对路径、Shell 命令、平台 API Key、密码或 Skill 目录外的内容；客户端 prompt 中指定的固定目标路径只用于 `write` 工具参数，不能复制到正文。
11. 如果输入信息不足以确定某个非核心表达，使用“未在 test_case 中提供”明确说明，不得静默编造；但不要改写或补充 `title`、`description`、`action` 和 `expectedResult`。
12. 输出应是可直接保存为 UTF-8 `SKILL.md` 的正文，文件末尾保留一个换行。

## 交付要求

生成完成后，必须使用 `write` 工具将完整的 `SKILL.md` 写入客户端 prompt 指定的固定目标文件。只允许写入该 `SKILL.md`，禁止调用 `bash` 或 `edit`，禁止修改其他文件或写入 Skill 目录外路径。工具调用完成后在 Agent 最终文本中只给出简短确认，不回显 API Key、密码、Token 或环境变量真实值。

客户端会读取并校验 Agent 已写入的文件，用户确认后由服务端提交生成元数据。
