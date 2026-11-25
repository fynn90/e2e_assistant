---
name: e2e_test_case
description: e2e test skill 的组成说明与方法论（SKILL.md + Playwright 脚本），将 e2e 测试用例转换成 e2e test skill 方式。当需要将测试用例转成 e2e test skill 时执行该 Skill。本 Skill 描述通用方法论，不参与平台的自动化生成流程；平台生成 SKILL.md 或 test.spec.ts 时请改加载对应的专用 Skill。
disable-model-invocation: false
---
# E2E Test Skill

当前Skill目的是将用户描述的测试用例转换成可以被 Agent执行 Skill，这个Skill有两个部分组成：`playwright 脚本` 和 `SKILL.md`。

- `SKILL.md` 描述测试具体步骤,说明执行 playwright脚本需要注意的事项

- `playwright 脚本` playwright E2E测试脚本，将测试用例中的测试步骤转换成可被playwright 执行的脚步

## 检查用户输入

当前Skill 执行依赖用户提供的测试用例对象。在进行编写SKILL.md和playwright 脚本之前需要做检查用户提供的测试用例对象。
用户提供测试用例对象类型如下：

```TS
interface e2eSkill {
  test_case_name: string, // '测试用例名称'
  test_case_description: string, //'测试用例描述'
  test_case_step:any[], // 测试用例步骤
  skill_pwd: string // 测试用例 SKILL.md 与 test.spec.ts 保存的目录
}
```

如果用户提供的信息不满足要求，则提醒用户缺失关键信息说明缺失的信息，并结束任务。

## SKILL.md

SKILL.md 是标准的可以被Agent 执行的SKILL。它的模版如下：

```md
---
name: ${test_case_name}
description: ${test_case_description}
---

# 测试用例这步骤
${test_case_step}

# 如何执行脚本
`playwright.test.js` 脚本位置当前SKILL.md同目录 `playwright.test.js`。执行 `playwright.test.js`
```

上面模版中有三个变量：

- test_case_name 测试用例名称
- test_case_description 测试用例描述
- test_case_step 测试用例步骤

上面三个参数用户会提供。

## test.spec.ts

### 编写脚本

用户测试用例会有很多步骤，按下面的方式编写脚本：

1. 提前识别测试用例步骤中页面操作关键元素。
2. 通过playwright获取页面DOM,确定页面操作关键元素对应的DOM元素。
3. 根据测试用例步骤和DOM元素，编写playwright脚本。
4. 根据测试步骤编写完对应的playwright 脚本之后执行脚本，检查是否错误。

针对用户提供的测试用例步骤，重复执行上面的步骤。测试用例脚本名为:test.spec.ts.

### 需要注意事项

#### 测试用例步骤存在断点

例如测试用例步骤写：`填写用户邮箱和密码，点击登录按钮登录`.并且在测试用例步骤中用户提供了填写数据: `email`,`password`。 但通过playwright 查看 DOM,页面上并没有`邮箱` 而是有`手机号`。将 用户提供的`email` 填入 `手机号` 页面提示错误。 则说明 用户描述的测试用例步骤存在断点和当前页面存在不一致。

当检查到测试用例步骤存在断点时，则提醒用户。通过文字说明和截图说明断点位置，并结束任务。

#### 异步操作

当页面操作中存在异步操作并且用户提供的测试用例中没有说明等待时间，默认用定时器检查页面是否变化，每隔1S做一次检查，持续120次。如果120次之后页面状态和测试用例预期不一致则提示用户出现异常测试用例执行失败，并结束任务。

#### 检查脚本

当完成test.spec.ts脚本之后请检查脚本，保证符合用户测试用例。如果发现和测试用例不一致的地方，按照 **编写脚本** 编写测试用例步骤修改脚本。
