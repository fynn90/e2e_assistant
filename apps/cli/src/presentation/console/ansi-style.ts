/**
 * 终端配色：`node:util` 的 `styleText` 薄封装。
 *
 * 为什么用它而不是 chalk / picocolors：本包 `engines` 已要求 Node ≥ 22.19.0，
 * `styleText` 是内置能力，零新依赖——而 v18 曾专门审计并移除了闲置的 `chalk`
 * （PRD v18 AC-07），重新引入颜色库与该决策相悖。
 *
 * `styleText` 自带两级降级：非 TTY（管道 / CI / 重定向）时返回原文本，
 * `NO_COLOR` 环境变量也被遵守。因此调用方无需自行判断是否该上色——
 * 直接调用即可，环境不合适时它自然输出纯文本。
 */
import { styleText } from 'node:util'

/**
 * 面板配色方案。
 *
 * 命名按**语义**而非颜色：调用方说「这是标题」，不关心它是青色还是绿色，
 * 将来换配色只需改这一个文件。
 */
export interface IPanelStyle {
  /** 卡片标题（粗体天蓝）。 */
  title: (text: string) => string
  /** 边框与分隔线（暗淡，不抢视线）。 */
  border: (text: string) => string
  /** 字段标签，如「地址」「端口」（暗淡）。 */
  label: (text: string) => string
  /** 字段值，如 URL、端口号（粗体白）。 */
  value: (text: string) => string
  /** 可执行的命令，如 e2e_assistant stop（粗体黄）。 */
  command: (text: string) => string
  /** 状态正常（绿）。 */
  ok: (text: string) => string
  /** 需要注意的状态（黄）。 */
  warn: (text: string) => string
  /** 次要说明与吉祥物台词（暗淡）。 */
  muted: (text: string) => string
}

/**
 * 构造生产配色方案。
 *
 * 每个成员都直接委托给 `styleText`：降级判定由 Node 完成，本函数不做判断，
 * 因此同一份代码在 TTY 与管道下都正确，无需分支。
 *
 * @returns 语义化的配色方案。
 * @throws 不抛出异常。
 */
export function createPanelStyle (): IPanelStyle {
  return {
    title: (text) => styleText(['bold', 'cyan'], text),
    border: (text) => styleText(['dim'], text),
    label: (text) => styleText(['dim'], text),
    value: (text) => styleText(['bold', 'white'], text),
    command: (text) => styleText(['bold', 'yellow'], text),
    ok: (text) => styleText(['green'], text),
    warn: (text) => styleText(['yellow'], text),
    muted: (text) => styleText(['dim'], text),
  }
}
