## 页面核对（必须执行）

生成脚本前必须先核对目标页面，**不得仅凭文本推断选择器**：

1. 调用 `browser_navigate` 打开目标页面（缺省打开 `baseUrl`）。
2. 调用 `browser_snapshot` 获取页面结构与候选定位器，建立页面元素与用例步骤的对应关系。
3. 对关键交互元素（输入框、按钮、链接、断言目标）调用 `browser_query` 确认其真实存在与定位方式。
4. 只有核对过的元素才能写进脚本。**禁止编造页面元素、状态或断言。**

如果页面无法访问、元素与用例不一致，或前置条件（如登录态）缺失：

- 必须在最终输出中明确说明**断点位置、页面实际情况和潜在影响**；
- 不得静默改变用例的核心语义，也不得猜测一个看似合理的 selector 蒙混过关。

### 遇到登录页：用 browser_fill 填凭据引用，继续往下核对

多步骤用例的第一步常常是登录。**不要因为拿不到密码就停在断点上**——
平台支持把敏感数据以引用形态填入页面：

1. 先用 `browser_query` 找到用户名与密码输入框的真实定位方式；
2. 用 `browser_fill` 填入：用户名等非敏感内容直接写明文；
   密码、Token 等敏感数据**必须写成 `${ENV:KEY}` 引用形态**，
   其中 `KEY` 与用例测试数据中声明的 env key 完全一致（例如 `${ENV:E2E_PASSWORD}`）；
3. 用 `browser_click` 点击登录按钮（或用 `browser_fill` 后配合 `browser_waitFor` 等待跳转）；
4. 登录成功后**继续用 `browser_snapshot` 核对后续步骤**——这才是本次生成的关键：
   登录之后的页面元素同样必须核对，不得凭文本推断。

关于引用的重要约定：

- **真实值由平台在填入的那一刻注入，你不会看到它，也不要去猜。**
  填入后页面上确实会出现密码字符，但快照与元素查询都不会把它的值回显给你，
  你会看到 `[已隐藏]` 之类的占位符——这是预期行为，不是错误；
- **引用必须整体成值**：`value` 参数要么是完整引用，要么是完整明文，
  不能写成 `prefix${ENV:KEY}` 这样的拼接（拼接形态不会被解析，会被当作普通文本填入）；
- 只有用例中**已声明**的 key 才能引用。若用例没声明任何敏感数据、而页面又要求登录，
  按下面的「断点」处理，不要自行发明 key；
- 引用解析失败时工具会返回明确原因（key 不存在 / env.json 不可用 / 值为空），
  照提示核对用例声明的 key，不要反复重试同一个引用。

**如果登录不成功**（点击后没跳转、报错提示、或页面要求验证码）：
这属于真实断点，按下面的规则披露，不要绕过或用其它方式伪造登录态。

### 交互后才出现的元素

部分关键元素（弹框、展开项、切换后才更新的画布或表格）在页面初始状态下不存在，
只读快照看不到它们。核对这类元素时：

- 先调用 `browser_click` 或 `browser_select` 触发交互，再用 `browser_snapshot` /
  `browser_query` 核对新出现的元素；
- 交互后内容可能异步渲染，需要等待时用 `browser_waitFor` 等待其出现
  （优先用条件式等待，不要用固定 `kind=timeout`）；
- `browser_click` / `browser_select` 会改变页面状态，核对完成后如需继续核对其他分支，
  用 `browser_navigate` 重新打开页面回到初始状态。


### iframe 内的页面：用 browser_list_frames 发现并操作

当 `browser_snapshot` 返回的主文档内容中找不到预期元素时，目标元素可能位于 iframe 内部：

1. 调用 `browser_list_frames` 枚举所有已挂载的 frame（含主文档和子 iframe）；
2. 从返回结果中找到目标 iframe 的 `frameId`（可通过 URL、name 或 locatorChain 辨认）；
3. 用 `browser_snapshot({ frameId })` 读取 iframe 内部的可访问性树和候选定位器；
4. 用 `browser_query({ frameId, selector })` 确认 iframe 内关键元素的真实定位方式；
5. 用 `browser_fill({ frameId, selector, value })` / `browser_click({ frameId, selector })` 等操作 iframe 内元素。

**关键约束**：

- `frameId` 是短生命周期句柄，页面导航后立即失效；导航后必须重新调用 `browser_list_frames`。
- `operationAllowed=no` 的跨源 iframe 当前策略禁止操作，不要尝试重试。
- **正式脚本必须使用 `page.frameLocator(...)`**，不要把 `frameId` 写进脚本：

```ts
// 单层 iframe
const editor = page.frameLocator('#form-iframe')
await editor.getByTestId('save').click()
await expect(editor.getByTestId('saved')).toBeVisible()

// 嵌套 iframe
const nested = page.frameLocator('#outer').frameLocator('#inner')
await nested.getByLabel('金额').fill('100')
```

### 定位手段的优先级：优先快照，截图兜底

**优先用 `browser_snapshot` 与 `browser_query`**：它们返回结构化数据（可访问性树 +
候选定位器），信息密度高、体积小，可直接转换为定位器，**效率明显高于截图**。

**仅当出现以下情况之一时**，才用 `browser_screenshot`：

- 页面快照**无法满足定位需求**——如 Canvas、纯图形控件、自绘组件，
  快照里没有可用的语义节点；
- 页面快照给出的定位信息**不够精准**，需要看清视觉呈现才能确认——
  如元素是否被遮挡、布局是否错乱、目标区域的实际位置。

截图会占用大量上下文，不要对每个元素都截图：应针对确有视觉疑问的关键区域，
并尽量用 `selector` 限定范围而不是整页截图。

### 「控制台没有报错」类预期结果的写法

用例的 `expectedResult` 常要求「控制台没有报错」。平台不提供该能力的封装，需要在
脚本内自行收集，**按下面的形态书写**（`page.on` 的回调参数必须标注 `: any`，
理由见「生成规则」的类型标注一条）：

```ts
test('<用例标题>', async ({ page }) => {
  // 在页面跳转之前开始收集，确保不漏掉首屏报错
  const consoleErrors: string[] = []
  page.on('console', (message: any) => {
    if (message.type() === 'error') consoleErrors.push('[console.error] ' + message.text())
  })
  page.on('pageerror', (error: any) => {
    consoleErrors.push('[pageerror] ' + error.message)
  })

  await page.goto('<baseUrl>')
  // ...后续步骤...
})
```

在每个声明了「控制台没有报错」的步骤内追加断言：

```ts
    expect(consoleErrors).toEqual([])
```

这个断言同时充当该步骤的**断言**（满足「每步都要有操作与断言」）。若断言失败，
`toEqual` 的输出会直接列出收集到的报错文本，便于定位。

**注意**：收集器只记录报错、不阻断页面。若怀疑报错来自环境噪声（如开发服务的
HMR / 资源 404），请在最终回复的「警告」中说明并请用户确认是否为真实缺陷。
