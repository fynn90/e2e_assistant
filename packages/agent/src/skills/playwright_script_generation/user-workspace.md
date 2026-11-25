## userWorkSpace：测试产物的唯一存放地

**当前 Skill 根目录下存在固定目录 `userWorkSpace`。该目录用于存放测试流程执行过程中产生的目录和文件，例如截图、基准图片、差异图、导出文件和其他测试资源。**

用户可以在 userWorkSpace 内新建子目录或文件，也可以删除其中的子目录或文件。生成的 Playwright 脚本可以包含文件和目录操作，也可以引用 Node 原生文件和目录 API（例如 `node:fs`、`node:fs/promises`、`node:path`）。这些操作必须全部限定在当前 Skill 的 userWorkSpace 内，不能超过该目录。

userWorkSpace 根目录本身不可删除、不可重命名。脚本不得写入 Skill 根目录或其他受保护文件。

视觉基准默认目录是 `userWorkSpace/baselines`。如果用户在测试步骤中指定了基准目录，必须解析为 `userWorkSpace` 内的相对目录。如果用户既未指定基准目录也未指定基准图片，你不能私自创建基准目录或捕获基准图片，必须先通过 `ask_user_question` 询问用户（提问卡片不提供跳过入口，用户必须给出回答）；万一没拿到可用回答，保留断点。

### 路径解释规则

- 用户步骤写「保存到当前 Skill 目录」时，把其中的**测试产物路径**解释为 `userWorkSpace/` 下的对应路径（除非该步骤明确指的是平台报告）；
- 步骤要求**读取历史测试产物**（上次导出的文件、既有基准图等）时，默认从 `userWorkSpace/` 对应子目录读取；
- 用户写 `preview`、`baselines/preview`、`userWorkSpace/preview` 时分别解析为 `userWorkSpace/preview`、`userWorkSpace/baselines/preview`、`userWorkSpace/preview`——一律**相对 userWorkSpace 解析**，只剥离一次前导 `userWorkSpace` 段，禁止 `..`、绝对路径与 `userWorkSpace/userWorkSpace` 重复拼接；
- 如果测试步骤要求的能力无法通过受控 userWorkSpace 机制安全实现，必须在「断点」中说明，不得静默使用语义不同的近似实现。

### Node 文件操作规则（平台静态校验硬性约束）

1. **只允许三个模块**：`node:fs`、`node:fs/promises`、`node:path`。不得改写为 Shell 命令，不得使用 `child_process`、动态代码执行（`eval`/`new Function`）或跨 Skill 路径访问；
2. **成员白名单**：`mkdir`、`writeFile`、`appendFile`、`readFile`、`copyFile`、`rename`、`readdir`、`stat`、`access`、`unlink`、`rm`、`rmdir`（`node:fs` 额外允许各成员的 `Sync` 变体；`node:fs/promises` 只允许 Promise 形态）。其他成员一律被拦截；
3. **导入形态**：`node:fs` / `node:fs/promises` 只允许**按名导入**白名单成员（禁止 `import * as fs`）；`node:path` 允许默认导入或按名导入；
4. **执行期注入**：平台向脚本注入环境变量 `SKILL_USER_WORKSPACE`（当前 Skill 的 userWorkSpace 绝对路径）。脚本中**不得出现任何绝对路径**，产物路径必须由该变量派生；
5. **不得删除 userWorkSpace 根目录**：`rm`/`rmdir` 的目标不能是根本身，只能是其内的子目录或文件；
6. **不得读取或写入** Skill 根目录、`SKILL.md`、`e2e_schema.json`、`manifest.json`、`env.json`、`test.spec.ts`、`temp/`、`test_report/`；
7. **不得在用户没有明确指令时清理 userWorkSpace 内已有文件**；覆盖已有产物只在测试步骤明确要求更新时进行。

### 文件操作脚本模板（逐字使用，只替换业务段）

以下模板的每处写法都对应一条平台校验，不可随意改动（`workspaceRoot` 只能来自
`process.env.SKILL_USER_WORKSPACE` 且带空值守卫；`target` 由
`path.resolve(workspaceRoot, '<业务相对路径>')` 派生且业务段为字面量；
`path.relative` 三条件自检逐字保留；fs 调用的路径参数只用 `target` /
`path.dirname(target)`）：

```ts
import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

test('<用例标题>', async ({ page }) => {
  await page.goto('<baseUrl>')

  await test.step('<步骤 id>', async () => {
    // —— 页面交互（保证该步骤的操作覆盖）——
    await page.getByRole('button', { name: '导出' }).click()

    // 平台注入的当前 Skill userWorkSpace 绝对路径（执行期存在，生成期只是占位语义）。
    const workspaceRoot = process.env.SKILL_USER_WORKSPACE
    if (!workspaceRoot) {
      throw new Error('缺少 SKILL_USER_WORKSPACE 环境变量，无法保存测试产物。')
    }

    // 业务相对路径必须先与根合并，再校验未逃逸 userWorkSpace（W39）。
    const target = path.resolve(workspaceRoot, 'exports/result.csv')
    const relative = path.relative(workspaceRoot, target)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('文件路径超出 userWorkSpace 边界：exports/result.csv')
    }

    // 目录由写入动作隐式创建；文件操作与断言都留在 step 体内。
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, '导出内容', 'utf-8')

    await expect(page.getByRole('status')).toBeVisible()
  })
})
```

模板要点：

| 要点 | 原因 |
|---|---|
| `workspaceRoot` 只能来自 `process.env.SKILL_USER_WORKSPACE`，且空值守卫 | 平台污点校验只认这一来源 |
| `target` 由 `path.resolve(workspaceRoot, '<业务相对路径>')` 派生，业务段为字符串字面量且不含 `..` | 静态可判的越界检测 |
| `path.relative` 三条件守卫（`''` / `..` / 绝对路径）逐字保留 | 运行期自检，静态校验的纵深防御 |
| fs 调用的路径参数只用 `target` / `path.dirname(target)` | 其他任何形态都会被判定 `FS_PATH_OUTSIDE_WORKSPACE` |
| 文件操作步骤同时含页面操作与断言 | step-coverage 的既有硬性要求 |
| 读取产物（`readFile` 等）使用同一派生方式 | 读与写共用同一边界判定 |
