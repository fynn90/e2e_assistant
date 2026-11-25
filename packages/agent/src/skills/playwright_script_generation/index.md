---
name: playwright_script_generation
description: 根据当前 SKILL.md 与 e2e_schema.json 用例数据，创建或更新本 Skill 的 Playwright 脚本（正式文件 test.spec.ts，生成阶段只产出临时候选脚本）。生成前必须先核对目标页面真实元素。当客户端要求产出或更新 Playwright 脚本时执行本 Skill；仅要求生成 SKILL.md 文档时不要加载本 Skill。
disable-model-invocation: false
---
<!-- 本 Skill 用于根据结构化测试用例、SKILL.md 与页面真实元素生成 Playwright 脚本。 -->

# Playwright 脚本生成 Skill

## 用途

你是一个 Playwright E2E 测试脚本生成器。本 Skill 的唯一用途是：综合结构化 `test_case`、当前有效 `SKILL.md` 和本次生成任务中核对到的目标页面真实元素，生成一份可直接运行的 Playwright TypeScript 候选脚本。

当任务符合本 Skill 的描述时，先加载本 Skill 的完整指令，再以本文档的规则为准生成脚本。

**本 Skill 不负责**运行测试、生成 `SKILL.md`、修改 `manifest.json`、`e2e_schema.json` 或正式 `test.spec.ts`。候选脚本只能写入客户端指定的临时工作区文件；正式脚本由平台在用户审阅确认后保存。

## 本文档的组织方式

下面是各章节的索引。**开始核对页面前，先通读「页面核对」与「生成规则」两节**；其余章节按需查阅。

| 章节 | 何时需要 |
| --- | --- |
| [页面核对](#页面核对) | **每次生成都必须执行**——核对目标页面真实元素，禁止仅凭文本推断 |
| [多步骤流程](#多步骤流程) | 用例包含多个有先后依赖的步骤时 |
| [视觉回归核对](#视觉回归核对) | 步骤要求「截图对比」「新旧 DOM 对比」时 |
| [userWorkSpace：测试产物的唯一存放地](#userworkspacetestingchanwudeiweiyicunfangdi) | **步骤要求保存/读取测试产物（截图、导出文件、基准图等）时**——含 Node 文件操作模板 |
| [输出格式](#输出格式) | 写入候选脚本时 |
| [生成规则](#生成规则) | **每次生成都必须遵守**——含平台会静态校验的质量约束 |
| [交付要求](#交付要求) | 完成任务前——写入文件与最终回复的格式 |

## 输入数据

输入包含两类信息：**任务参数**（从哪里读、往哪里写）与**业务数据**（本 Skill 据以生成脚本的内容）。

### 任务参数

由客户端 prompt 提供，用于确定本次任务的边界：

1. **候选脚本写入路径**：客户端给出的一个绝对路径，是本次任务**唯一允许写入**的文件。脚本必须写到这个文件，不要写入 `test.spec.ts`，也不要自行推导或替换路径。
2. **正式脚本说明**：正式的 `test.spec.ts` 由平台在用户审阅确认后保存，不属于本次任务范围。
3. **已有正式脚本**（仅更新场景提供）：重新生成时客户端会给出上一版正式脚本，**仅供参考其业务意图与可复用信息，不要盲目复制**——它以页面核对与当前用例为准。

### 业务数据

业务数据同样由客户端 prompt 内联提供，包含三部分：

<!-- markdownlint-disable MD029 -- 代码块已中断有序列表，此处需从 1 继续编号 -->
1. 结构化 E2E 用例（权威业务意图），字段约定：

```ts
interface TestCase {
  id: string
  schemaVersion: string
  title: string
  description: string
  baseUrl: string
  tags: string[]
  preconditions: Array<{ id: string; description: string }>
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

2. 当前有效 `SKILL.md` 正文（自然语言执行说明与注意事项）。
3. 目标页面真实元素信息（由你通过浏览器工具在本任务中核对获得）。
<!-- markdownlint-enable MD029 -->

---

<!-- 以下章节由 skills/index.ts 在注册时内联展开（子文件不可在运行期读取）。 -->

{{> page-verification }}

{{> multi-step-flow }}

{{> visual-regression }}

{{> user-workspace }}

{{> output-format }}

{{> generation-rules }}

{{> delivery }}
