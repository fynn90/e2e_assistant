/**
 * 终端渲染层级判定：决定面板用「带边框的卡片」还是「无边框的朴素文本」呈现。
 *
 * 存在的理由：输出目标有两类截然不同的读者。
 *   - 人在终端里看 → 希望好看，边框让信息成为一个整体；
 *   - 管道 / CI / 测试在看 → 只关心文本内容，边框与空白是噪声，
 *     且 e2e 用例断言的是可读子串，绝不能被装饰字符隔断。
 *
 * 因此把「用什么装潢」收敛为一个纯判定，命令层不必到处写 `isTTY` 分支。
 */

/**
 * 卡片所需的最小终端列数（含两侧边框与内边距）。
 *
 * 取值由**最长的概述行**倒推：概述行是 e2e 断言与用户主视线的载体，一旦折行
 * 就会把 `started in the background` 这类短语切成两行。最长的一条是
 * 「🚀 Authine E2E Agent Platform started in the background」（可见宽度 55），
 * 加上两侧边框与内边距共需 61 列，故取 64 留出余量。
 *
 * `start-panel.test.ts` 有一条用例锁定这个推导——若今后概述行变长，
 * 该用例会失败并提示同步抬高本值，而不是让折行在窄终端上悄悄发生。
 */
export const CARD_MIN_COLUMNS = 64

/**
 * 输出层级。
 *
 * - `card`：终端足够宽，输出完整圆角卡片；
 * - `colored`：是终端但太窄，去掉边框改用缩进 + 配色，避免边框挤成一团；
 * - `plain`：输出被重定向（管道 / CI），只输出纯文本，`styleText` 亦自动降级。
 */
export type TTerminalOutputMode = 'card' | 'colored' | 'plain'

/**
 * 判定当前应采用的输出层级。
 *
 * @param isTerminal - 是否连接到交互式终端；缺省读 `process.stdout.isTTY`。
 * @param columns - 终端列数；缺省读 `process.stdout.columns`（重定向时为 undefined）。
 * @returns 渲染层级。
 * @throws 不抛出异常。
 */
export function resolveTerminalOutputMode(
  isTerminal: boolean = process.stdout.isTTY === true,
  columns: number | undefined = process.stdout.columns,
): TTerminalOutputMode {
  if (!isTerminal) {
    return 'plain'
  }

  // 列数不可得（部分终端不报）时按宽终端处理：宁可画边框也不误降级。
  if (typeof columns !== 'number' || !Number.isFinite(columns)) {
    return 'card'
  }

  return columns >= CARD_MIN_COLUMNS ? 'card' : 'colored'
}
