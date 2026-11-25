## 视觉回归核对（新旧 DOM 截图对比）

**触发条件**：步骤描述或 `action` / `expectedResult` 中出现「截图对比」「新旧 DOM 对比」
「与基线图片比对」「页面展示是否正常」等语义时，启用本节规则。

### 基线位置与归一化

基线保存在 `<skillRoot>/userWorkSpace/<分组>/` 下，**默认分组是 `baselines`**
（即默认基准目录 `userWorkSpace/baselines/`）。用户指明的目录按以下规则归一化
（一律**相对 userWorkSpace 解析**，只剥离一次前导 `userWorkSpace` 段）：

| 用户写法 | 实际目录 |
|---|---|
| `preview` | `userWorkSpace/preview/` |
| `baselines/preview` | `userWorkSpace/baselines/preview/`（前导 `baselines/` 不剥离） |
| `userWorkSpace/preview` | `userWorkSpace/preview/` |

禁止解析到 Skill 根目录、禁止 `..` / 绝对路径 / `userWorkSpace/userWorkSpace` 重复拼接。

### 基准信息缺失时必须询问：`ask_user_question`

生成脚本前按以下顺序处理基准信息：

1. 用例数据（`testData` 或步骤描述）指明了基准**目录与基准图片** → 不询问，直接按
   `userWorkSpace/<基准目录>/<基准图片>` 解析；
2. 只指明了基准图片 → 不询问目录，按默认目录 `userWorkSpace/baselines/<基准图片>` 解析；
3. 只指明了基准目录，缺基准图片 → 调用 `ask_user_question` 询问基准图片（1 个问题）；
4. 目录与图片都未指明 → **必须**调用 `ask_user_question` 一次问完两个问题
   （目录问题在前、图片问题在后），不得拆成多轮追问，也不得私自创建目录、
   捕获图片或生成占位文件名。

**用户回答前不得调用 `browser_capture_baseline`、不得创建基准目录、不得生成占位图片名**（B8/A13）。

调用 `ask_user_question` 前：

- 可先用 `bash` 查看已有基准（如 `ls userWorkSpace/baselines`），结合测试步骤分析
  **给出 2-5 个候选项**（由你分析给出，不是平台收集）；
- **目录问题的候选必须包含「使用默认目录 `userWorkSpace/baselines`」**（选项 `value`
  写 `baselines`）；
- **不得自行提供「其它」选项**——平台会自动在每个问题末尾追加固定「其它」选项，
  选中后用户可长文本输入（A17）；
- 图片问题的选项建议直接给 `<目录>/<文件>.png` 完整相对路径，体现与目录问题的依赖关系；
- `context` 里说明为什么需要这些信息、不补充会有什么影响。

#### 候选项与答案的路径规则（由你自行遵守，平台不再代校验）

提问给出的每个选项 `value`、以及用户经「其它」自定义输入的回答，都必须是
**`userWorkSpace` 内的相对路径**：

- 归一化规则同上文「基线位置与归一化」：一律相对 `userWorkSpace` 解析，只剥离一次
  前导 `userWorkSpace` 段（`baselines/preview` 的前导 `baselines/` **不剥离**）；
- **禁止**绝对路径（`/abs`、`C:\x`）、`..`、反斜杠、盘符、URL 编码穿越（`%2e`/`%2f`）
  与 `userWorkSpace/userWorkSpace` 重复拼接；
- 基准图片文件名必须以 `.png` 结尾，且目录各段与文件名只允许字母、数字、下划线、
  中划线（各段最长 64 字符）；
- 用户给出的回答不满足上述规则时，**不要**自行改写成近似路径，也不要静默继续：
  重新发起一次提问，并在 `context` 里说明上一次输入不合法的原因与正确写法。

#### 回答之后：判定「使用已有基准」还是「捕获新基准」

拿到用户回答后，按以下顺序处理：

1. 先合成完整相对路径：图片答案含 `/`（完整相对路径）→ 以图片答案为准；
   图片答案是纯文件名 → 目录取目录答案（未提供时按默认目录 `baselines`）；
2. 用 `bash`（如 `ls`）或 `read` 确认该路径**是否已存在基准图**：
   - 已存在 → 按「使用已有基准」处理，不捕获，直接在脚本里用 `toMatchSnapshot` 引用；
   - 不存在 → 用户提交指向不存在路径的回答**即视为明确同意创建目录并捕获当前画面
     作为基准图**（B9/Q5），此时才调用 `browser_capture_baseline` 捕获基准
     （`segments` 与该目录一致、`fileName` 与该文件名一致），再写比对断言；
3. 提问未拿到可用回答（返回 cancelled，属异常路径）→ 不创建任何目录或图片，
   可修正问法后重新发起一次提问；仍拿不到回答时，在最终回复的「断点」小节说明
   缺少的基准信息（A14/B10）。

### 捕获基线：`browser_capture_baseline`

当用户经提问回答**明确同意捕获**（提交指向不存在路径的基准图即视为同意，见上文
判定规则），或明确要求**更新（重新捕获）**基线时调用本工具。它会截取元素、
保存为基线文件，并把图片同时返回给你确认。

参数要点：

- `selector`：要作为基线截图元素的 selector；
- `segments`：userWorkSpace 内相对目录分段，例如 `['baselines']`（默认基准目录）
  或 `['preview']`，必须与随后脚本里的路径分段**完全一致**；
- `fileName`：基线文件名，必须以 `.png` 结尾。同一分组允许多个候选，
  用不同文件名重复调用即可（执行期任一命中即通过）。

已有基线不被自动覆盖；只有用户明确要求更新或确认重新捕获时才覆盖同名文件（B12）。

> **候选名单必须写成字面量数组**：脚本里**不能**枚举目录（读取目录虽已允许，
> 但候选名单必须在生成时就确定——`readdir` 的结果在校验期不可用，且会让脚本
> 失去可移植性）。因此候选名单在你生成脚本的这一刻就固定下来——
> **用户之后新增的基线不会自动被脚本使用，需要重新生成脚本**。这一点要在最终回复的
> 「假设」或「警告」中告知用户。

### 关键约束：以下每一条都有一个真实的失败原因，不可随意改动

| 约束 | 违反后的后果 |
|---|---|
| **禁止**使用 `await expect(page).toHaveScreenshot(...)` | 它对**滚动容器只截可视区域**，不符合「完整 DOM 内容」要求 |
| 全内容截图的固定写法见下方模板 | CDP 的 `captureBeyondViewport` 对滚动容器截到的是**空白**，不要尝试 |
| **自行新增的函数**：参数与回调参数必须显式标注类型（用 `any`） | 平台校验对**未声明的方法**无法推断参数类型，未标注会报隐式 any 并向用户提示（通式约束见「生成规则」中的类型标注一条） |
| 候选比对的 `for` 循环**必须写在 `test.step` 内**，不得封装成外部函数 | 否则该步骤被判定为「没有操作也没有断言」，触发 `STEP_ASSERTION_REQUIRED` 并提示用户 |
| **禁止**写 `expect(实际值, '说明')` 双参数形式 | 平台的类型声明只接受 1 个参数，会报「Expected 1 arguments, but got 2」并向用户提示；说明信息请放进 `Error` 消息 |
| 子目录必须用**数组分段** `['preview', name]` | 名字里带斜杠（`'preview/x.png'`）会被转义成 `preview-x.png`，基线找不到 |
| 临时展开样式后**必须用 `finally` 还原** | 截图失败会永久破坏页面布局，污染同用例后续步骤 |
| 截图时必须带 `animations: 'disabled'` 与 `caret: 'hide'` | 自捕获不会自动应用这两个确定性选项，动画或光标闪烁会造成假失败 |
| **禁止**用 `page.waitForTimeout` 等固定等待代替稳定性重试 | 平台静态校验会报 `FIXED_WAIT_DISCOURAGED` 警告；且固定等待是在猜测渲染耗时 |

### 脚本模板（逐字使用，只替换 selector 与候选名）

```ts
import { test, expect } from '@playwright/test'

/**
 * 连续截图直到画面稳定（相邻两次字节完全一致），最多尝试 4 次。
 * 自捕获不像 toHaveScreenshot 那样自带稳定性等待，页面异步渲染未完成时会截到中间态。
 */
async function captureStable(target: any) {
  const MAX_ATTEMPTS = 4
  let previous = await target.screenshot({ animations: 'disabled', caret: 'hide' })

  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const current = await target.screenshot({ animations: 'disabled', caret: 'hide' })
    if (current.equals(previous)) return current
    previous = current
  }

  // 达到上限仍不稳定：返回最后一张，让比对给出真实结论。
  return previous
}

/**
 * 捕获元素的完整内容截图（含内部滚动区域）。
 * 元素无内部溢出时等价于普通元素截图。
 */
async function captureFullContent(target: any) {
  const size = await target.evaluate((el: any) => ({
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  }))

  if (size.scrollWidth <= size.clientWidth && size.scrollHeight <= size.clientHeight) {
    return await captureStable(target)
  }

  const previous = await target.evaluate((el: any) => el.getAttribute('style'))

  try {
    await target.evaluate((el: any, s: any) => {
      el.setAttribute('style', 'overflow:visible;width:' + s.scrollWidth + 'px;height:' + s.scrollHeight + 'px')
    }, size)
    return await captureStable(target)
  } finally {
    await target.evaluate((el: any, p: any) => {
      if (p === null) el.removeAttribute('style')
      else el.setAttribute('style', p)
    }, previous)
  }
}
```

在步骤内按下面的形态使用（**注意：比对循环必须留在 `test.step` 内**）：

```ts
  await test.step('<步骤 id>', async () => {
    // 先用交互触发目标元素出现（若该元素初始就存在，可省略交互）
    await page.getByRole('button', { name: '实际预览' }).click()

    const target = page.locator('.print-canvas')
    const buffer = await captureFullContent(target)

    // 候选目录由用户经 ask_user_question 确认，此处为字面量数组
    const candidates = ['candidate-a.png', 'candidate-b.png']
    const attempted: string[] = []

    for (const candidate of candidates) {
      attempted.push(candidate)
      try {
        expect(buffer).toMatchSnapshot(['preview', candidate], { maxDiffPixels: 0 })
        attempted.length = 0
        break
      } catch (error) {
        if (attempted.length === candidates.length) {
          throw new Error('视觉比对未通过，已尝试候选：' + attempted.join('、'))
        }
      }
    }

    // 兜底断言：保证该步骤同时具备操作与断言
    await expect(target).toBeVisible()
  })
```

**语义说明**：多个候选基线中**任意一个匹配即视为通过**；全部不匹配才失败。
失败时 Playwright 会自动产出差异热点图（`*-diff.png`）并出现在测试报告中，无需额外处理。

### 动态区域的处理

页面上的动态内容（时间戳、轮播、随机广告位、动画指示器）会让比对永远失败。
**不要用放宽 `maxDiffPixels` 来掩盖**——那会同时放过真正的差异。正确做法是在
稳定性不可控的区域上做处理：优先与用户确认该区域是否可用固定测试数据，
或在报告说明中明确标注该限制。

### 首次运行失败是正常的

基线需要先被捕获。若用户尚未捕获过基线，执行期会因「基线不存在」而失败，
这是预期行为。**不要为了让它通过而放宽差异阈值，也不要写入占位基线**——
正确的指引是告知用户「请先捕获基线，或重新生成脚本以纳入新基线」。
