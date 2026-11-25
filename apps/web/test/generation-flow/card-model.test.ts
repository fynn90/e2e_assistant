/**
 * 生成流程卡片派生的单元测试（PRD 5.4 / 6.6 / 6.7 / AC-04、AC-06、AC-07）。
 *
 * 覆盖：阶段「完成」才产出卡片、「失败/取消」产出终止卡片、
 * `latestCardKey` 唯一、运行中无关闭按钮、主按钮置灰与时间戳标记。
 */
import { describe, expect, it } from 'vitest'
import {
  createCardKey,
  createFailureCardKey,
  deriveLatestCardKey,
  derivePrimaryAction,
  summarizeStage,
  toSidebarItems,
} from '../../src/modules/generation-flow/card-model'
import type { TWorkTimelineItem } from '../../src/modules/agent-work/timeline'
import type {
  IProductCard,
  IStageRecord,
} from '../../src/modules/generation-flow/types'

/** 构造一个最小阶段记录（不关心时间线内容）。 */
function createStage(overrides: Partial<IStageRecord> = {}): IStageRecord {
  return {
    kind: 'skill',
    title: 'SKILL 阶段',
    status: 'idle',
    timeline: { items: { value: [] } } as unknown as IStageRecord['timeline'],
    card: null,
    failureCard: null,
    stageText: '',
    cancelable: false,
    startedAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  }
}

/** 构造一个最小产物卡片。 */
function createCard(overrides: Partial<IProductCard> = {}): IProductCard {
  return {
    key: createCardKey('skill-document', 'v1'),
    kind: 'skill-document',
    fileName: 'SKILL.md',
    content: '# doc',
    viewMode: 'preview',
    completionHint: 'done',
    warnings: [],
    assumptions: [],
    environmentVariables: [],
    stepCoverage: [],
    meta: { version: 'v1' },
    saveState: 'saved',
    diagnostics: [],
    ...overrides,
  }
}

describe('toSidebarItems（PRD 5.4 出现规则）', () => {
  it('阶段区块一开始就出现，运行中不产出产物卡片', () => {
    const items = toSidebarItems([createStage({ status: 'writing-skill' })])

    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('stage')
  })

  it('完成后阶段区块与产物卡片平级排列', () => {
    const card = createCard()
    const items = toSidebarItems([createStage({ status: 'completed', card })])

    expect(items.map((item) => item.kind)).toEqual(['stage', 'card'])
  })

  it('失败时产出终止卡片且不出现产物卡片（AC-07）', () => {
    const failureCard = {
      key: createFailureCardKey('skill', 'failed'),
      kind: 'skill' as const,
      fileName: 'SKILL.md',
      status: 'failed' as const,
      errorMessage: '生成失败。',
      nextStepHint: '可关闭后重新生成。',
    }
    const items = toSidebarItems([
      createStage({ status: 'failed', card: null, failureCard }),
    ])

    expect(items.map((item) => item.kind)).toEqual(['stage', 'failure'])
  })

  it('两个阶段按发生顺序平铺', () => {
    const skillCard = createCard()
    const scriptCard = createCard({
      key: createCardKey('playwright-script', 't1'),
      kind: 'playwright-script',
      fileName: 'test.spec.ts',
    })
    const items = toSidebarItems([
      createStage({ status: 'completed', card: skillCard }),
      createStage({
        kind: 'script',
        title: 'Playwright 脚本阶段',
        status: 'completed',
        card: scriptCard,
      }),
    ])

    expect(items.map((item) => item.kind)).toEqual([
      'stage',
      'card',
      'stage',
      'card',
    ])
  })
})

describe('deriveLatestCardKey（PRD 6.6 关闭按钮唯一规则）', () => {
  it('存在运行中阶段时返回 null，使所有卡片都不渲染关闭按钮（AC-06）', () => {
    const stages = [
      createStage({ status: 'completed', card: createCard() }),
      createStage({ kind: 'script', status: 'generating-script' }),
    ]

    expect(deriveLatestCardKey(stages)).toBeNull()
  })

  it('SKILL.md 完成、脚本未开始时仅 SKILL.md 卡片为最新', () => {
    const card = createCard()
    const stages = [createStage({ status: 'completed', card })]

    expect(deriveLatestCardKey(stages)).toBe(card.key)
  })

  it('脚本完成后最新卡片移交脚本卡片（AC-06）', () => {
    const skillCard = createCard()
    const scriptCard = createCard({
      key: createCardKey('playwright-script', 't1'),
      kind: 'playwright-script',
    })
    const stages = [
      createStage({ status: 'completed', card: skillCard }),
      createStage({ kind: 'script', status: 'completed', card: scriptCard }),
    ]

    expect(deriveLatestCardKey(stages)).toBe(scriptCard.key)
  })

  it('终止卡片优先于历史产物卡片成为最新卡片', () => {
    const skillCard = createCard()
    const failureCard = {
      key: createFailureCardKey('script', 'failed'),
      kind: 'script' as const,
      fileName: 'test.spec.ts',
      status: 'failed' as const,
      errorMessage: '失败',
      nextStepHint: '重试',
    }
    const stages = [
      createStage({ status: 'completed', card: skillCard }),
      createStage({ kind: 'script', status: 'failed', failureCard }),
    ]

    expect(deriveLatestCardKey(stages)).toBe(failureCard.key)
  })

  it('无任何卡片时返回 null', () => {
    expect(
      deriveLatestCardKey([createStage({ status: 'writing-skill' })]),
    ).toBeNull()
  })
})

/**
 * 构造一个思考块时间线项。
 * @param overrides 需要覆盖的字段。
 * @returns 思考项。
 * @throws 不抛出异常。
 */
function thinkingItem(
  overrides: Partial<Extract<TWorkTimelineItem, { kind: 'thinking' }>> = {},
): TWorkTimelineItem {
  return {
    kind: 'thinking',
    blockId: 'think-1',
    seq: 1,
    status: 'done',
    text: '...',
    ...overrides,
  }
}

/** 构造一个工具调用项（只关心 kind 计数）。 */
function toolItem(blockId = 'tool-1'): TWorkTimelineItem {
  return {
    kind: 'tool',
    blockId,
    seq: 2,
    status: 'done',
    category: 'file',
    action: 'read',
    title: '读取文件',
    toolName: 'read',
    text: '',
  }
}

/** 构造一个命令执行项（只关心 kind 计数）。 */
function commandItem(blockId = 'cmd-1'): TWorkTimelineItem {
  return {
    kind: 'command',
    blockId,
    seq: 3,
    status: 'done',
    command: 'ls',
    stdout: '',
    stderr: '',
  }
}

describe('summarizeStage（阶段头部统计，PRD 5.3）', () => {
  it('省略 options 时只统计已定型耗时（与前向兼容）', () => {
    // 实时化改造前唯一支持的用法：调用方不传时钟，行为必须逐字不变。
    const summary = summarizeStage([
      thinkingItem({ durationMs: 12000 }),
      toolItem(),
    ])

    expect(summary).toBe('已思考 12 秒 · 1 次工具调用')
  })

  it('保留「N 次命令执行」（口径与既有折叠摘要一致）', () => {
    const summary = summarizeStage([
      thinkingItem({ durationMs: 5000 }),
      toolItem(),
      commandItem(),
    ])

    expect(summary).toBe('已思考 5 秒 · 1 次工具调用 · 1 次命令执行')
  })

  it('运行中的思考块按 now - startedAt 实时计时', () => {
    // 10 秒前开始思考、尚未收到 end 事件。
    const summary = summarizeStage(
      [thinkingItem({ status: 'streaming', startedAt: 0 })],
      {
        now: 10_000,
        running: true,
      },
    )

    expect(summary).toBe('已思考 10 秒')
  })

  it('已定型块与运行中块并存时两者相加、不重复累加', () => {
    // 第一段思考已定型 4 秒；第二段仍在跑，距 now 还有 6 秒。
    const summary = summarizeStage(
      [
        thinkingItem({ blockId: 'a', durationMs: 4000 }),
        thinkingItem({ blockId: 'b', status: 'streaming', startedAt: 4000 }),
      ],
      { now: 10_000, running: true },
    )

    expect(summary).toBe('已思考 10 秒')
  })

  it('now 推进时秒数单调递增（防止重复累加导致跳变）', () => {
    const items = [thinkingItem({ status: 'streaming', startedAt: 0 })]

    const readings = [1000, 2000, 3000, 4000].map((now) =>
      summarizeStage(items, { now, running: true }),
    )

    expect(readings).toEqual([
      '已思考 1 秒',
      '已思考 2 秒',
      '已思考 3 秒',
      '已思考 4 秒',
    ])
  })

  it('缺少 startedAt 的运行中块计 0，但仍按「已思考 1 秒」展示（思考块确实存在）', () => {
    // 无从推算耗时时不能谎报 0 秒，也不能因为算不出就假装没在思考。
    const summary = summarizeStage([thinkingItem({ status: 'streaming' })], {
      now: 10_000,
    })

    expect(summary).toBe('已思考 1 秒')
    expect(summary).not.toContain('NaN')
  })

  it('now 早于 startedAt 时计 0，不出现负数（服务端与本地时钟存在偏移）', () => {
    const summary = summarizeStage(
      [thinkingItem({ status: 'streaming', startedAt: 10_000 })],
      { now: 3000 },
    )

    expect(summary).toBe('已思考 1 秒')
    expect(summary).not.toContain('-')
    expect(summary).not.toContain('NaN')
  })

  it('startedAt 为 NaN 时不污染文案', () => {
    const summary = summarizeStage(
      [thinkingItem({ status: 'streaming', startedAt: Number.NaN })],
      { now: 10_000 },
    )

    expect(summary).toBe('已思考 1 秒')
    expect(summary).not.toContain('NaN')
  })

  it('运行中且尚无任何统计时显示「准备中…」而非「已完成」', () => {
    // 阶段已启动但第一个思考块还没到；显示「已完成」会与同行的「进行中」徽标矛盾。
    expect(summarizeStage([], { now: 5000, running: true })).toBe('准备中…')
  })

  it('终态且无统计时仍显示「已完成」', () => {
    expect(summarizeStage([], { now: 5000, running: false })).toBe('已完成')
    expect(summarizeStage([])).toBe('已完成')
  })

  it('工具与命令计数不受 now 影响', () => {
    const items = [toolItem('t1'), toolItem('t2'), commandItem()]

    expect(summarizeStage(items)).toBe('2 次工具调用 · 1 次命令执行')
    expect(summarizeStage(items, { now: 999_999, running: true })).toBe(
      '2 次工具调用 · 1 次命令执行',
    )
  })

  it('不足 1 秒的实时计时按 1 秒展示（不显示「0 秒」）', () => {
    // 与既有 `Math.max(1, ...)` 行为一致：刚开始思考时显示 1 秒而非 0 秒。
    expect(
      summarizeStage([thinkingItem({ status: 'streaming', startedAt: 1000 })], {
        now: 1300,
        running: true,
      }),
    ).toBe('已思考 1 秒')
  })
})

describe('derivePrimaryAction（PRD 6.7 主按钮置灰）', () => {
  it('脚本阶段未开始时主按钮可用（无置灰信息）', () => {
    const card = createCard()
    const stages = [createStage({ status: 'completed', card })]

    expect(derivePrimaryAction(stages, card)).toBeNull()
  })

  it('脚本阶段开始后主按钮置灰并附执行时间戳（AC-05）', () => {
    const card = createCard()
    const stages = [
      createStage({ status: 'completed', card }),
      createStage({
        kind: 'script',
        status: 'generating-script',
        startedAt: '2026-09-16T10:24:00.000Z',
      }),
    ]

    const action = derivePrimaryAction(stages, card)

    expect(action).not.toBeNull()
    // 本地时区下 10:24 的具体展示随时区变化，只断言「含时间戳 + 已生成」语义。
    expect(action!.label).toContain('生成 Playwright 脚本')
    expect(action!.label).toContain('已于')
    expect(action!.executedAt).toBe('2026-09-16T10:24:00.000Z')
  })
})
