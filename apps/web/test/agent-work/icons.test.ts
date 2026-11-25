/**
 * 图标映射表测试：工具动作 / 工具类别 / 提示级别 → 字形名。
 *
 * 覆盖四类风险：
 *   1. 工具动作或类别新增后漏配图标（编译期由 Record 拦截，此处补运行时确认）；
 *   2. SSE 事件携带非法 action / category / level 时的兜底（item-factory 对此做无校验断言）；
 *   3. 映射值回退成 emoji —— 直接锁死「emoji 颜色不受控」这一原始诉求；
 *   4. **动作图标塌缩**：同一大类下的不同动作共用字形（「查询/点击/截图/下拉全是同一个
 *      地球」就是这一形态）。这是仅断言「非空」挡不住的缺陷——塌缩时每一项都非空。
 */
import { describe, expect, it } from 'vitest'
import type {
  TAgentToolAction,
  TAgentToolCategory,
} from '@charlie_deng/e2e-assistant-types'
import {
  EMPTY_SESSION_ICON,
  EMPTY_TIMELINE_ICON,
  INTERACTION_ANSWERED_ICON,
  INTERACTION_ICON,
  NOTICE_LEVEL_ICONS,
  STAGE_COLLAPSED_ICON,
  STAGE_EXPANDED_ICON,
  THINKING_ICON,
  TODO_BLOCK_ICON,
  TOOL_ACTION_ICONS,
  TOOL_CATEGORY_ICONS,
  TURN_AVATAR_ICON,
  noticeLevelIcon,
  toolActionIcon,
  toolCategoryIcon,
} from '../../src/modules/agent-work/icons'

/** 全部工具类别字面量（与 TAgentToolCategory 保持一致）。 */
const ALL_CATEGORIES: TAgentToolCategory[] = [
  'browser',
  'file',
  'search',
  'skill',
  'data',
  'other',
]

/** 全部工具动作字面量（与 TAgentToolAction 保持一致）。 */
const ALL_ACTIONS: TAgentToolAction[] = [
  'navigate',
  'snapshot',
  'query',
  'click',
  'select',
  'fill',
  'wait',
  'screenshot',
  'baseline',
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'skill',
  'test',
  'other',
]

/**
 * 同一大类内部必须两两不同的动作分组。
 *
 * 这张表是本 bug 的回归防线：曾因只按 category 选图标，导致「查询页面元素 /
 * 点击页面元素 / 页面截图 / 选择下拉项」全部渲染成同一个地球图标——
 * 而当时若只断言「每个类别都有非空图标」，测试依然全绿。
 */
const ACTION_GROUPS_REQUIRING_DISTINCT_ICONS: TAgentToolAction[][] = [
  // 浏览器动作：用户报告的直接受害组
  [
    'navigate',
    'snapshot',
    'query',
    'click',
    'select',
    'fill',
    'wait',
    'screenshot',
    'baseline',
  ],
  // 文件动作：read / write / edit 曾同为 file-text
  ['read', 'write', 'edit'],
  // 检索动作：grep / find 曾同为 search-o
  ['grep', 'find'],
]

describe('工具动作图标映射', () => {
  it('每个工具动作都解析出非空字形名', () => {
    for (const action of ALL_ACTIONS) {
      const icon = toolActionIcon(action)
      expect(icon, `动作 ${action} 未解析出字形名`).toBeTruthy()
      expect(typeof icon).toBe('string')
    }
  })

  it('映射表覆盖全部工具动作', () => {
    expect(Object.keys(TOOL_ACTION_ICONS).sort()).toEqual(
      [...ALL_ACTIONS].sort(),
    )
  })

  it('未知动作回退为 other 的字形（保护 SSE 非法值与旧会话）', () => {
    // item-factory 对 SSE 的 action 做 `as TAgentToolAction` 无校验断言；
    // 且旧会话物化的块根本没有 action 字段，两条路径都靠这里兜底。
    // 无兜底会渲染出 h-icon-all-undefined 空白方块。
    expect(toolActionIcon('不存在的动作' as TAgentToolAction)).toBe(
      TOOL_ACTION_ICONS.other,
    )
  })

  it('同一大类内的不同动作映射到互不相同的字形（本 bug 的回归防线）', () => {
    // 缺陷形态：查询/点击/截图/下拉同属 browser，全部渲染成同一个地球图标。
    // 光断言「非空」挡不住它——塌缩时每一项都非空，测试照样全绿。
    for (const group of ACTION_GROUPS_REQUIRING_DISTINCT_ICONS) {
      const icons = group.map((action) => toolActionIcon(action))
      expect(
        new Set(icons).size,
        `同组动作出现图标塌缩：${group.map((a, i) => `${a}=${icons[i]}`).join(', ')}`,
      ).toBe(group.length)
    }
  })

  it('全部动作的字形两两互不相同', () => {
    // 比分组断言更强：跨组也不允许撞车，保证「每个动作一眼可辨」。
    const icons = ALL_ACTIONS.map((action) => toolActionIcon(action))
    const duplicated = icons.filter(
      (icon, index) => icons.indexOf(icon) !== index,
    )
    expect(
      duplicated,
      `以下字形被多个动作共用：${duplicated.join(', ')}`,
    ).toEqual([])
  })
})

describe('工具类别图标映射', () => {
  it('每个工具类别都解析出非空字形名', () => {
    for (const category of ALL_CATEGORIES) {
      const icon = toolCategoryIcon(category)
      expect(icon, `类别 ${category} 未解析出字形名`).toBeTruthy()
      expect(typeof icon).toBe('string')
    }
  })

  it('映射表覆盖全部工具类别', () => {
    // 注意：本表已不用于选图标（图标走 TOOL_ACTION_ICONS），它保留为类别轴的键，
    // 供配色/样式使用。这里仍锁住穷尽性，避免类别轴被悄悄剪掉条目。
    expect(Object.keys(TOOL_CATEGORY_ICONS).sort()).toEqual(
      [...ALL_CATEGORIES].sort(),
    )
  })

  it('未知类别回退为 other 的字形（保护 SSE 非法值）', () => {
    // item-factory 对 SSE 的 category 做 `as TAgentToolCategory` 无校验断言，
    // 线上可能流入任意字符串；无兜底会渲染出 h-icon-all-undefined 空白方块。
    expect(toolCategoryIcon('不存在的类别' as TAgentToolCategory)).toBe(
      TOOL_CATEGORY_ICONS.other,
    )
  })
})

describe('提示级别图标映射', () => {
  it('warning 与 error 映射到不同字形', () => {
    expect(noticeLevelIcon('warning')).not.toBe(noticeLevelIcon('error'))
  })

  it('两个级别都有非空字形名', () => {
    expect(noticeLevelIcon('warning')).toBeTruthy()
    expect(noticeLevelIcon('error')).toBeTruthy()
  })

  it('越界级别回退为 warning 的字形', () => {
    expect(noticeLevelIcon('未知级别' as 'warning' | 'error')).toBe(
      NOTICE_LEVEL_ICONS.warning,
    )
  })
})

describe('阶段区块折叠箭头', () => {
  it('展开态与折叠态是两个不同字形', () => {
    // 写成同一个字形会让箭头失效而无任何报错。
    expect(STAGE_EXPANDED_ICON).not.toBe(STAGE_COLLAPSED_ICON)
  })

  it('两个字形名均非空', () => {
    expect(STAGE_EXPANDED_ICON).toBeTruthy()
    expect(STAGE_COLLAPSED_ICON).toBeTruthy()
  })
})

describe('图标值不得为 emoji（原始诉求回归）', () => {
  it('所有映射值与单值常量均为纯 ASCII 字形名', () => {
    // emoji 由系统 emoji 字体以彩色字形绘制，CSS color 无法覆盖，会导致颜色不统一。
    // 本断言防止后续改动把 emoji 改回来。
    const allNames = [
      ...Object.values(TOOL_ACTION_ICONS),
      ...Object.values(TOOL_CATEGORY_ICONS),
      ...Object.values(NOTICE_LEVEL_ICONS),
      THINKING_ICON,
      EMPTY_TIMELINE_ICON,
      INTERACTION_ICON,
      INTERACTION_ANSWERED_ICON,
      EMPTY_SESSION_ICON,
      STAGE_EXPANDED_ICON,
      STAGE_COLLAPSED_ICON,
      TURN_AVATAR_ICON,
      TODO_BLOCK_ICON,
    ]

    for (const name of allNames) {
      // ASCII 可打印字符：字母、数字、连字符
      expect(name, `字形名 "${name}" 含非 ASCII 字符（疑似 emoji）`).toMatch(
        /^[a-zA-Z0-9-]+$/,
      )
    }
  })
})
