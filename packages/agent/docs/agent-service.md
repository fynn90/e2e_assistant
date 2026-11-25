# AgentService 使用指南（多轮对话）

`AgentService` 是 `@authine-e2e-agent/agent` 对外暴露的会话级多轮对话服务。核心模型：

> **一个会话（sessionId）= 一个复用的 AgentLoop + 一份持久化历史。**

AgentService 对外只提供 `chat` 任务入口。客户端可以通过 prompt 要求 Agent 使用 `load_skill` 加载具体 Skill（例如生成测试用例文档时加载 `test_case_Skill_document`），也可以只描述业务意图，由 Agent 依据系统提示词中的技能列表自行匹配。会话在显式 `dispose()` / `removeTask()` 前保持打开，天然支持一个会话多轮对话。

---

## 快速开始

```ts
import { AgentService } from '@authine-e2e-agent/agent'

const service = new AgentService('/path/to/workspace', {
  name: 'gpt-4o',
  url: 'https://llm.example.com/v1',
  key: 'sk-...',
  supportsThinking: true,
  thinkingLevel: 'high',
})

// 通过 prompt 触发指定 Skill；首轮会在后台自动启动
const handle = service.chat(
  '请调用 load_skill 加载 test_case_Skill_document，并根据以下 test_case 生成完整的 SKILL.md：……',
  { sessionId: 'skill-001' },
)

// 等待首轮完成，再在同一会话中继续对话
await handle.result
await handle.send('请检查每个启用步骤是否都已完整映射')

// 会话完成后释放资源
await service.removeTask('skill-001')
```

### 不指定 sessionId

`sessionId` 缺省时自动生成，通过句柄暴露，调用方可在下一轮把它带回：

```ts
const handle = service.chat('第一轮')
const sessionId = handle.sessionId
await handle.result
await handle.send('第二轮')
```

---

## 任务句柄 API

`chat(prompt, options?)` 返回 `IAgentTaskHandle`：

| 成员                  | 说明                                                         |
| --------------------- | ------------------------------------------------------------ |
| `sessionId`           | 会话 ID（任务与对话的唯一标识，也是会话持久化主键）。        |
| `operateType`         | 固定为 `"chat"`。                                            |
| `loop`                | 底层 `AgentLoop`，需要深入控制时使用。                       |
| `status`              | `idle / running / completed / aborted / error`。             |
| `result`              | 最近一次启动的轮次结果（首轮由 `chat` 自动启动并写入）。     |
| `send(input)`         | 同一会话内启动/续接一轮；`input` 为文本或 `AgentMessage[]`。 |
| `continue()`          | 从当前上下文续跑（重试/继续工具循环），不追加新用户消息。    |
| `subscribe(listener)` | 订阅任务运行期间的事件流。                                   |
| `abort()`             | 中止当前轮次。                                               |
| `waitForIdle()`       | 等待当前轮次与所有订阅者结束。                               |
| `snapshot()`          | 当前会话完整消息快照。                                       |
| `dispose()`           | 释放任务并从运行器移除。                                     |

### 并发安全

同一会话的多个 `send()` 会自动串行排队，后一轮能看到前一轮的完整历史；不同会话之间互不影响，可并行运行。

---

## 通过 Skill 生成测试用例 SKILL.md

客户端只需把结构化 `test_case` 数据放入 `chat` 的 prompt，并明确要求：

1. 调用 `load_skill` 加载 `test_case_Skill_document`；
2. 按 Skill 中定义的 frontmatter、章节和步骤映射规则生成完整 Markdown；
3. 将 Agent 返回的候选交给业务层校验，用户确认后再保存 `SKILL.md`。

客户端不需要复制 Skill 的格式规则，也不需要为该任务覆盖 Agent 的 `systemPrompt`。

---

## 会话管理

```ts
service.getTask('skill-001')
service.listTasks()
await service.removeTask('skill-001')
await service.dispose()
```

---

## 会话持久化与断点续跑

`AgentService` 默认使用 **SQLite** 会话存储（`<workspace>/.e2e-agent/sessions.db`）。服务重启后使用同一 `sessionId` 调用 `chat`，会自动从断点加载历史继续对话：

```ts
const service1 = new AgentService(workspace, modelInfo)
await service1.chat('第一轮', { sessionId: 'session-1' }).result
await service1.dispose()

const service2 = new AgentService(workspace, modelInfo)
const handle = service2.chat('第二轮', { sessionId: 'session-1' })
await handle.result
```

### 自定义存储

```ts
import { createMemorySessionStore } from '@authine-e2e-agent/agent'

const service = new AgentService(workspace, modelInfo, {
  sessionStore: createMemorySessionStore(),
  // 或使用 sessionDbPath 指定 SQLite 路径
})
```

---

## Skill Chat 运行时（SSE 桥接）

CLI / Web 的 `/chat` 接口基于 `createSkillChatRuntime` 实现：每个请求内建一个 `AgentService`，把客户端携带的完整对话历史作为一轮任务运行，并把事件流翻译为 `TSkillChatEvent`（`delta` / `complete` / `error`）供 SSE 输出。

```ts
import { createSkillChatRuntime } from '@authine-e2e-agent/agent'

const runtime = createSkillChatRuntime({
  workspace: config.projectDirectory,
  apiKey: config.llmApiKey,
  apiBaseUrl: config.llmApiBaseUrl,
  model: config.llmModelName,
  signal: abortController.signal,
})

const stream = await runtime.open({
  skill,
  fileTreeSummary: JSON.stringify(fileTree),
  currentFile: { relativePath, version, content },
  messages: [{ role: 'user', content: '帮我改一下这个断言' }],
})

for await (const event of stream.events) {
  // event: { type: "delta", text } | { type: "complete", usage } | { type: "error", ... }
}
await runtime.close()
```
