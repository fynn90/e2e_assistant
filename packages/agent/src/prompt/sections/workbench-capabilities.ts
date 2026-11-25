/**
 * 工作台能力清单（v17 §5.3，PRD H3 的唯一事实来源）。
 *
 * 一份常量、两个出口：
 *   1. `renderCapabilityPromptSection` —— 注入系统提示词的规则文本（模型据此回答
 *      「你能做什么」）；
 *   2. `toCapabilityViewPayload` —— 能力卡的数据来源（`render_view({viewKind:
 *      'capability'})` 的宿主据此构建 payload）。
 *
 * 为什么要类型化而不是把清单直接写进提示词字符串：
 *   能力卡是**结构化渲染**的，而提示词是**自然语言**。同一份事实若各写一遍，
 *   加一个能力时必然漏掉一处——那时能力卡会对用户承诺平台做不到的事，或者
 *   对能做的事说「不支持」。类型化后两处共用同一份数据。
 *
 * 内容依据是 PRD `v17.md` 的 §1.4 能力对照表与 §4.9 U4 的能力边界清单，
 * 但**不是**在运行时读取 PRD 文件——改了 PRD 就要同步改这里（PRD R9 的纪律：
 * 清单是单一常量，列为 PR 检查项）。
 */

import type {
  ICapabilityViewPayload,
  IWorkbenchCapabilityManifest,
} from '@fynn90-e2e_assistant/types'

/**
 * 平台能力清单（唯一事实来源）。
 *
 * `domains` 与 PRD §4.0 的八个能力域一一对应；`notSupported` 与 §4.9 U4 同源。
 * 顺序即提示词与卡片里的展示顺序，按「用户最常问」到「最少问」排列。
 */
export const WORKBENCH_CAPABILITY_MANIFEST: IWorkbenchCapabilityManifest = {
  domains: [
    {
      key: 'query',
      label: '查看看什么（问询）',
      examples: [
        '我有哪些用例？',
        '哪些用例还没生成脚本？',
        '云7登录这个用例是怎么写的？',
        '这个用例最近跑得怎么样？',
        '为什么这次挂了？',
        '这次比上次好点吗？',
      ],
    },
    {
      key: 'execute',
      label: '跑起来（执行）',
      examples: [
        '跑一下云7登录',
        '再跑一次',
        '这个用例现在能跑吗？',
        '把冒烟的用例都跑一遍',
      ],
    },
    {
      key: 'generate-repair',
      label: '生成与修复',
      examples: [
        '帮我生成这个用例的脚本',
        '脚本挂了，帮我修一下',
        '用例里写的按钮页面上没有',
      ],
    },
    {
      key: 'case-change',
      label: '改用例（变更提案）',
      examples: [
        '把这个用例的地址改成测试环境',
        '标题改成「结算-回归」',
        '加一条「退出登录」的步骤',
      ],
    },
    {
      key: 'env',
      label: '准备环境（环境变量）',
      examples: ['这个用例还缺什么？', '补一下环境变量'],
    },
    {
      key: 'cleanup',
      label: '清理',
      examples: ['清掉 8 月之前的报告', '把「旧版结算」这个用例删了'],
    },
    {
      key: 'guide',
      label: '引导',
      examples: ['你能做什么？', '怎么开始？'],
    },
    {
      key: 'session',
      label: '会话管理',
      examples: ['把这个会话改名', '删掉这个会话'],
    },
  ],
  notSupported: [
    {
      key: 'import-export',
      label: '导入 / 导出 / 分享用例包',
      alternative: '用例在本机以目录形式保存，可手动拷贝该用例的整个目录。',
    },
    {
      key: 'rename-move-copy',
      label: '用例或文件的重命名 / 移动 / 复制',
      alternative: '新建用例后手动迁移内容；平台立约「不可重命名」。',
    },
    {
      key: 'schedule-ci',
      label: '定时 / 周期 / 无人值守执行、CI 集成',
      alternative: '由你人工发起连续执行（可一次跑多个用例）。',
    },
    {
      key: 'cross-workspace',
      label: '跨工作区 / 云端执行',
      alternative: '切换工作区后在本机执行。',
    },
    {
      key: 'single-test-in-script',
      label: '只跑脚本中的某一条测试',
      alternative: '整次重跑，或修改脚本后再跑。',
    },
    {
      key: 'trend-report',
      label: '执行结果趋势 / 统计报表',
      alternative: '查看执行历史与单次报告，或对比两次执行。',
    },
    {
      key: 'headless',
      label: '无头执行模式',
      alternative: '平台固定有头执行，便于旁观与排错。',
    },
    {
      key: 'external-integration',
      label: '连接外部系统（缺陷跟踪、通知、报表）',
      alternative: '查看报告与执行历史；导出用例目录后可手工对接。',
    },
  ],
}

/**
 * 派生一：注入提示词的规则文本（模型据此回答「你能做什么」）。
 *
 * 措辞刻意贴近「你能做什么」的回答口吻——模型可直接转述，也可以据此组织语言，
 * 但**事实必须来自这里**（H3：不得由模型临时生成或承诺未实现的能力）。
 *
 * @param manifest - 能力清单（缺省用内置常量，测试可注入替身）。
 * @returns 提示词区块的 markdown 文本。
 * @throws 不抛出异常。
 */
export function renderCapabilityPromptSection (
  manifest: IWorkbenchCapabilityManifest = WORKBENCH_CAPABILITY_MANIFEST,
): string {
  const domainLines = manifest.domains.flatMap((domain) => [
    `- **${domain.label}**：${domain.examples.join(' / ')}`,
  ])

  const unsupportedLines = manifest.notSupported.map(
    (item) => `- ${item.label} → 替代：${item.alternative}`,
  )

  return [
    '### 平台能做什么、不能做什么（唯一事实来源）',
    '',
    '用户问「你能做什么」「支持哪些操作」时，**必须依据本清单回答**，',
    '不得临时发挥、不得承诺清单之外的能力（也不要说「敬请期待」）。',
    "要展示结构化清单时调 `render_view({ viewKind: 'capability' })`，",
    '文本只补一句引导（不要复述卡片内容）。',
    '',
    '**能做的事**：',
    ...domainLines,
    '',
    '**当前版本不做的事**（如实说明 + 至少给一条替代路径，不承诺时间）：',
    ...unsupportedLines,
    '',
    '**永不接入的（安全边界，与「能力外」区分回应）**：读取环境变量的值、',
    '访问工作区之外的路径、绕过生成链路直接写产物。这类请求要说明原因',
    '（敏感数据 / 平台边界 / 防绕过）并给合规替代，且不得因用户坚持而放宽。',
  ].join('\n')
}

/**
 * 派生二：能力卡的数据来源。
 *
 * `render_view({viewKind:'capability'})` 的宿主调用本函数构建 payload——
 * 与提示词共用同一份常量，因此「模型说的」与「卡片显示的」必然一致。
 *
 * @param manifest - 能力清单（缺省用内置常量）。
 * @returns 能力卡的渲染载荷。
 * @throws 不抛出异常。
 */
export function toCapabilityViewPayload (
  manifest: IWorkbenchCapabilityManifest = WORKBENCH_CAPABILITY_MANIFEST,
): ICapabilityViewPayload {
  return {
    domains: manifest.domains.map((domain) => ({
      key: domain.key,
      label: domain.label,
      examples: [...domain.examples],
    })),
    notSupported: manifest.notSupported.map((item) => ({
      label: item.label,
      alternative: item.alternative,
    })),
  }
}
