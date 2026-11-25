/**
 * 标题栏副标题文案表的单元测试（PRD 5.2 九种状态逐项覆盖 / AC-03）。
 */
import { describe, expect, it } from 'vitest'
import { deriveSubtitle } from '../../src/modules/generation-flow/status-text'
import { deriveFlowPhaseFromStages } from '../../src/modules/generation-flow/card-model'
import type {
  IStageRecord,
  TFlowPhase,
} from '../../src/modules/generation-flow/types'

describe('deriveSubtitle（PRD 5.2 文案表）', () => {
  it.each<[TFlowPhase, string]>([
    ['idle', ''],
    ['skill-running', 'SKILL.md 生成中'],
    ['skill-completed', 'SKILL.md 完成'],
    ['skill-failed', 'SKILL.md 生成失败'],
    ['skill-cancelled', 'SKILL.md 生成已停止'],
    ['script-running', 'Playwright 脚本生成中'],
    ['script-completed', 'Playwright 脚本生成完成'],
    ['script-failed', 'Playwright 脚本生成失败'],
    ['script-cancelled', 'Playwright 脚本生成已停止'],
  ])('阶段 %s 的副标题为「%s」', (phase, expected) => {
    expect(deriveSubtitle(phase)).toBe(expected)
  })

  it('空态不展示副标题（PRD 5.5）', () => {
    expect(deriveSubtitle('idle')).toBe('')
  })
})

describe('deriveFlowPhaseFromStages', () => {
  /**
   * 构造最小阶段记录。
   * @param kind 阶段种类。
   * @param status 阶段状态。
   * @returns 阶段记录。
   * @throws 不抛出异常。
   */
  function stage(
    kind: 'skill' | 'script',
    status: IStageRecord['status'],
  ): IStageRecord {
    return {
      kind,
      title: '',
      status,
      timeline: {} as IStageRecord['timeline'],
      card: null,
      failureCard: null,
      stageText: '',
      cancelable: false,
      startedAt: '2026-09-16T10:00:00.000Z',
    }
  }

  it('空阶段列表对应空态', () => {
    expect(deriveFlowPhaseFromStages([])).toBe('idle')
  })

  it('以最后一个阶段的状态为准（流程已推进到脚本就显示脚本状态）', () => {
    expect(deriveFlowPhaseFromStages([stage('skill', 'completed')])).toBe(
      'skill-completed',
    )
    expect(
      deriveFlowPhaseFromStages([
        stage('skill', 'completed'),
        stage('script', 'preparing'),
      ]),
    ).toBe('script-running')
    expect(
      deriveFlowPhaseFromStages([
        stage('skill', 'completed'),
        stage('script', 'completed'),
      ]),
    ).toBe('script-completed')
  })

  it('保存冲突按失败处理（副标题反映阶段结果）', () => {
    expect(deriveFlowPhaseFromStages([stage('skill', 'conflict')])).toBe(
      'skill-failed',
    )
    expect(
      deriveFlowPhaseFromStages([
        stage('skill', 'completed'),
        stage('script', 'conflict'),
      ]),
    ).toBe('script-failed')
  })
})
