/**
 * Agent 工作模块的图标映射表：工具动作 / 工具类别 / 提示级别 / 各空态 / 阶段折叠箭头 → 图标字形名。
 *
 * 全部为纯数据与纯函数：不依赖 Vue、不引用任何组件，供组件与单元测试直接复用。
 * 「哪个动作/类别配哪个图标」的判定集中在此处，组件只做绑定不做判定——与
 * `modules/generation-flow/card-model.ts` 同构的分层约定。
 *
 * 图标轴的分工：**动作（action）选图标，类别（category）选配色**。二者不可混用——
 * 曾因只按 category 选图标，导致「查询元素 / 点击元素 / 页面截图 / 选择下拉项」
 * 同属 browser 而全部塌缩成同一个地球图标。
 *
 * 本表此前使用 emoji（🌐 📄 🔍 🧩 …）。emoji 由系统 emoji 字体以**彩色**字形绘制，
 * CSS 的 color 对其完全无效，导致各图标自带颜色、无法纳入设计令牌体系。字体图标
 * 用 currentColor 绘制，颜色交由 CSS 统一控制，故改用本图标库（font-family: aufontAll）。
 *
 * 表内只存**字形名 slug**（如 'earth-o'），不存完整类名：`aufontAll` + `h-icon-all-`
 * 的拼接由 `common/icon/IconFont.vue` 独家负责，杜绝「复制半个类名」。
 */
import type {
  TAgentToolAction,
  TAgentToolCategory,
} from '@authine-e2e-agent/types'

/**
 * 图标字形名（不含 `h-icon-all-` 前缀）。
 *
 * 用字面量联合而非 string：该图标库的字形名写错时**不会报错**，只会渲染成
 * 空白方块，因此把拼写错误拦在编译期。
 */
export type TAgentWorkIconName =
  | 'earth-o'
  | 'file-text'
  | 'search-o'
  | 'module-o'
  | 'database-o'
  | 'wrench'
  | 'bulb-o'
  | 'ai-robot-o'
  | 'question-circle-o'
  | 'message-o'
  | 'warning-o'
  | 'close-circle-o'
  | 'caret-down'
  | 'caret-right'
  | 'user-o'
  | 'check'
  // —— 工具动作用字形（v13 图标粒度细化）——
  | 'scan-o'
  | 'hand-click-o'
  | 'single-selection-o'
  | 'clock-circle-o'
  | 'camera-o'
  | 'save-o'
  | 'field-input-stroke'
  | 'file-o'
  | 'add-file-o'
  | 'edit-o'
  | 'file-searching-o'
  | 'start-o'
  | 'list-work-o'

/**
 * 工具类别 → 图标字形名。
 *
 * **已不用于选图标**：图标选择依据改为 `TOOL_ACTION_ICONS`（见下）。
 * 保留此表是因为 category 仍是样式/配色轴的键——但若有人再拿它选图标，
 * 就会重现「查询/点击/截图/下拉全是同一个地球」的塌缩。
 *
 * 用 Record 保证工具类别新增时**编译期报错**，避免漏配。其中 `file-text` 与
 * `wrench` 在该库中无 outline 变体，是全套 outline 字形里仅有的两个偏实心字形，
 * 属客观限制而非疏漏。
 */
export const TOOL_CATEGORY_ICONS: Record<
  TAgentToolCategory,
  TAgentWorkIconName
> = {
  browser: 'earth-o',
  file: 'file-text',
  search: 'search-o',
  skill: 'module-o',
  data: 'database-o',
  other: 'wrench',
}

/**
 * 工具动作 → 图标字形名。
 *
 * 这是时间线工具卡片的**图标选择唯一依据**。用 Record 保证动作新增时编译期报错，
 * 避免漏配后静默退化成兜底扳手。
 *
 * 字形均在本机逐个渲染目视核对（非按名字猜测），且全部为 outline 变体，
 * 与时间线既有图标（earth-o / bulb-o / warning-o …）属同一套视觉体系。
 * 同一大类内的动作字形**互不相同**——这一点由 icons.test.ts 的专项断言锁定。
 */
export const TOOL_ACTION_ICONS: Record<TAgentToolAction, TAgentWorkIconName> = {
  // 浏览器动作
  navigate: 'earth-o',
  snapshot: 'file-text',
  query: 'scan-o',
  click: 'hand-click-o',
  select: 'single-selection-o',
  fill: 'field-input-stroke',
  wait: 'clock-circle-o',
  screenshot: 'camera-o',
  baseline: 'save-o',
  // 文件动作
  read: 'file-o',
  write: 'add-file-o',
  edit: 'edit-o',
  // 检索动作
  grep: 'search-o',
  find: 'file-searching-o',
  // 其他
  skill: 'module-o',
  test: 'start-o',
  other: 'wrench',
}

/**
 * 提示级别 → 图标字形名。
 *
 * 取 outline 字形的 `close-circle-o`（而非实心的 `close-circle`），与同为 outline 的
 * `warning-o` 成一套；提示图标继承提示条文字色，小字号下实心圆块观感过重。
 */
export const NOTICE_LEVEL_ICONS: Record<
  'warning' | 'error',
  TAgentWorkIconName
> = {
  warning: 'warning-o',
  error: 'close-circle-o',
}

/** 思考块图标（原 emoji 为 💭）。 */
export const THINKING_ICON: TAgentWorkIconName = 'bulb-o'

/**
 * 待办清单块图标（v12-pre 引入该块时漏配，本次补齐）。
 *
 * 取清单形态的字形，与 `.todo-title` 的中性墨色搭配；此前该卡片头部无任何图标，
 * 与时间线其余块（思考/提示/交互/工具）不一致。
 */
export const TODO_BLOCK_ICON: TAgentWorkIconName = 'list-work-o'

/** 时间线空态图标（原 emoji 为 🤖）。 */
export const EMPTY_TIMELINE_ICON: TAgentWorkIconName = 'ai-robot-o'

/** 交互卡片图标（原 emoji 为 ❓）。 */
export const INTERACTION_ICON: TAgentWorkIconName = 'question-circle-o'

/**
 * 提问卡片中「该题已作答」的勾选标记。
 *
 * 用字体图标而非 ✓ 字符：字符由系统字体绘制，与卡片其余图标的笔画粗细不一致。
 */
export const INTERACTION_ANSWERED_ICON: TAgentWorkIconName = 'check'

/** 会话列表空态图标（原 emoji 为 💬）。 */
export const EMPTY_SESSION_ICON: TAgentWorkIconName = 'message-o'

/**
 * 轮次头像（轮次分隔左侧，标记「这一轮由用户发起」）。
 *
 * 原先是手写内联 SVG 的带眼头部轮廓，16px 下既不像人也不像 AI，且与已统一到
 * 字体图标的其余时间线图标不属同一套视觉体系。改用 outline 人形，与 earth-o /
 * bulb-o 等同属线性一套。
 */
export const TURN_AVATAR_ICON: TAgentWorkIconName = 'user-o'

/**
 * 阶段区块**展开态**的折叠箭头（朝下）。
 *
 * 原先用文本字符 `▾`，字号被 CSS 锁死在 11px 无法放大，且与时间线其余图标
 * （已全部迁移到字体图标）不是同一套视觉体系。改用字体图标后字号走
 * `IconFont` 的 `size` prop，可自由调大。
 */
export const STAGE_EXPANDED_ICON: TAgentWorkIconName = 'caret-down'

/** 阶段区块**折叠态**的折叠箭头（朝右），与展开态成对。 */
export const STAGE_COLLAPSED_ICON: TAgentWorkIconName = 'caret-right'

/**
 * 取工具类别对应的图标字形名。
 *
 * 注意：时间线工具卡片已改用 `toolActionIcon`，本函数当前无生产调用方，
 * 保留供配色/样式轴后续使用。
 *
 * 必须保留运行时兜底：`Record` 只保证编译期穷尽，而 `timeline/item-factory.ts`
 * 对 SSE 事件里的 category 做了 `as TAgentToolCategory` 无校验断言，`??` 只挡
 * null/undefined——线上收到非法字符串会得到 `h-icon-all-undefined`，渲染为空白方块。
 *
 * @param category - 工具类别。
 * @returns 图标字形名；未登记的类别回退为 `other` 的字形。
 * @throws 不抛出异常。
 */
export function toolCategoryIcon(
  category: TAgentToolCategory,
): TAgentWorkIconName {
  return TOOL_CATEGORY_ICONS[category] ?? TOOL_CATEGORY_ICONS.other
}

/**
 * 取工具动作对应的图标字形名（工具卡片图标的唯一入口）。
 *
 * 运行时兜底的理由与 `toolCategoryIcon` 相同：`item-factory.ts` 对 SSE 事件里的
 * action 做了 `as TAgentToolAction` 无校验断言，`??` 只挡 null/undefined，
 * 线上收到非法字符串（或旧会话物化的无 action 块）会渲染成空白方块。
 *
 * @param action - 工具动作。
 * @returns 图标字形名；未登记的动作回退为 `other` 的扳手。
 * @throws 不抛出异常。
 */
export function toolActionIcon(action: TAgentToolAction): TAgentWorkIconName {
  return TOOL_ACTION_ICONS[action] ?? TOOL_ACTION_ICONS.other
}

/**
 * 取提示级别对应的图标字形名。
 *
 * 与 `toolCategoryIcon` 同理：`item-factory.ts` 对 level 也是无校验断言，
 * 需在此处兜底。
 *
 * @param level - 提示级别（warning / error）。
 * @returns 图标字形名；越界级别回退为 `warning` 的字形。
 * @throws 不抛出异常。
 */
export function noticeLevelIcon(
  level: 'warning' | 'error',
): TAgentWorkIconName {
  return NOTICE_LEVEL_ICONS[level] ?? NOTICE_LEVEL_ICONS.warning
}
