/**
 * 工作台显示主体编排的单元测试（v13 PRD §4.2 C 组、技术方案 §3.7）。
 *
 * 覆盖 `beginSubject` 的四条分支与两条文案：
 *   1. 无主体 → 直接发起（C-3）；
 *   2. 有主体但已终态 → 直接发起（C-2/C-6）；
 *   3. 有主体、运行中、旧主体是**执行** → 先确认（C-5 第 ① 条）；
 *   4. 有主体、运行中、旧主体是**生成** → 拒绝（C-5 第 ② 条）。
 *
 * 第 3 与第 4 条的分野是本版最重要的产品判断（技术方案 §3.5）：
 * 执行由服务端独立承载，前端不再观察仍会跑完；而生成的前端流就是它的
 * 生命周期，切换会中止它。因此两者不能用同一条规则。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  beginSubject,
  describeGenerationRejection,
  describeSwitchConfirm,
  fileNameForStage,
} from '../../src/modules/agent-work/workbench-subject'
import type { IWorkbenchSubject } from '../../src/stores/global-chat'

/** 造一个显示主体。 */
function subject(
  kind: IWorkbenchSubject['kind'],
  overrides: Partial<IWorkbenchSubject> = {},
): IWorkbenchSubject {
  return { kind, skillId: 'skill-001', ...overrides }
}

describe('beginSubject', () => {
  it('无显示主体：直接发起，不调用确认（C-3）', async () => {
    const confirm = vi.fn()

    const outcome = await beginSubject({
      kind: 'execution',
      skillId: 'skill-001',
      current: null,
      currentRunning: false,
      confirm,
    })

    expect(outcome).toBe('started')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('有主体但已终态：直接发起，不调用确认（C-2/C-6）', async () => {
    const confirm = vi.fn()

    const outcome = await beginSubject({
      kind: 'execution',
      skillId: 'skill-002',
      current: subject('generation'),
      currentRunning: false,
      confirm,
    })

    expect(outcome).toBe('started')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('执行运行中：先确认；用户同意则发起（C-5 第 ① 条）', async () => {
    const confirm = vi.fn().mockResolvedValue(true)

    const outcome = await beginSubject({
      kind: 'execution',
      skillId: 'skill-002',
      current: subject('execution', { executionId: 'exec-1' }),
      currentRunning: true,
      confirm,
    })

    expect(outcome).toBe('started')
    expect(confirm).toHaveBeenCalledTimes(1)
    // 确认文案必须同时说清「不再显示」与「仍会继续运行」，否则用户会以为任务被中止。
    const message = confirm.mock.calls[0]![0] as string
    expect(message).toContain('不再在工作台显示')
    expect(message).toContain('仍会继续运行')
  })

  it('执行运行中：用户取消则不发起（C-5 第 ① 条）', async () => {
    const confirm = vi.fn().mockResolvedValue(false)

    const outcome = await beginSubject({
      kind: 'execution',
      skillId: 'skill-002',
      current: subject('execution', { executionId: 'exec-1' }),
      currentRunning: true,
      confirm,
    })

    expect(outcome).toBe('cancelled')
  })

  it('生成运行中：**直接拒绝**且不弹确认（C-5 第 ② 条）', async () => {
    const confirm = vi.fn()

    const outcome = await beginSubject({
      kind: 'execution',
      skillId: 'skill-002',
      current: subject('generation'),
      currentRunning: true,
      confirm,
    })

    // 不是 'cancelled'：用户没有拒绝，是平台不允许——两者对调用方的后续动作不同。
    expect(outcome).toBe('rejected-running-generation')
    // 不弹确认：生成被中止是破坏性后果，不提供「确认后放弃」的入口。
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('文案', () => {
  it('describeSwitchConfirm：带标题时点名该 Skill', () => {
    const message = describeSwitchConfirm(
      subject('execution', { skillTitle: '登录流程' }),
    )

    expect(message).toContain('「登录流程」')
  })

  it('describeSwitchConfirm：无标题时退化为泛指，不出现空引号', () => {
    const message = describeSwitchConfirm(subject('execution'))

    expect(message).toContain('该 Skill')
    expect(message).not.toContain('「」')
  })

  it('describeGenerationRejection：说明正在生成什么、可以怎么做', () => {
    const message = describeGenerationRejection('SKILL.md')

    expect(message).toContain('SKILL.md')
    expect(message).toContain('停止生成')
  })

  it('fileNameForStage：按阶段种类给出产物名', () => {
    expect(fileNameForStage('skill')).toBe('SKILL.md')
    expect(fileNameForStage('script')).toBe('test.spec.ts')
  })
})
