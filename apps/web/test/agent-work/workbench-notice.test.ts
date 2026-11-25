/**
 * 完成提示发布器的单元测试（v13 PRD §4.7 N 组、技术方案 §7.7）。
 *
 * 覆盖三条发布前的判定与去重：
 *   - **工作台展开时不提示**（N-2）——双向断言，这是 N-1/N-2 的唯一判据；
 *   - **缺主体时不提示**（N-9，`/agent` 发起的任务不进入本路径）；
 *   - **同一终态只提示一次**（N-8），且不同终态互不干扰。
 *
 * 覆盖三态映射与通知参数（`duration` 必须显式传值——naive-ui 的 notification
 * 在缺省时**永不自动关闭**，漏传会让提示一直挂在屏幕上）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IGlobalNoticeInput } from '../../src/composables/useGlobalNotice'
import { createWorkbenchNoticePublisher } from '../../src/composables/useWorkbenchNotice'
import type { IWorkbenchSubject } from '../../src/stores/global-chat'

/** 记录每次发出的通知，供断言参数与内容。 */
const sent: Array<{ kind: string; input: IGlobalNoticeInput }> = []

// `useGlobalNotice` 内部调用 naive-ui 的 `useNotification()`（依赖注入），
// 单测环境没有 provider，因此整体替换为记录器。
vi.mock('../../src/composables/useGlobalNotice', () => ({
  useGlobalNotice: () => ({
    success: (input: IGlobalNoticeInput) =>
      sent.push({ kind: 'success', input }),
    warning: (input: IGlobalNoticeInput) =>
      sent.push({ kind: 'warning', input }),
    error: (input: IGlobalNoticeInput) => sent.push({ kind: 'error', input }),
    raw: {},
  }),
}))

const SUBJECT: IWorkbenchSubject = { kind: 'generation', skillId: 'skill-001' }

beforeEach(() => {
  sent.length = 0
})

describe('createWorkbenchNoticePublisher', () => {
  it('工作台**收起**时发出提示（N-1）', () => {
    const publisher = createWorkbenchNoticePublisher(() => false)

    const published = publisher.publish({
      subject: SUBJECT,
      kind: 'success',
      notice: { title: 'SKILL.md 生成完成' },
      dedupeKey: 'generation:skill:completed',
    })

    expect(published).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind).toBe('success')
    expect(sent[0]!.input.title).toBe('SKILL.md 生成完成')
  })

  it('工作台**展开**时不发提示（N-2）', () => {
    const publisher = createWorkbenchNoticePublisher(() => true)

    const published = publisher.publish({
      subject: SUBJECT,
      kind: 'success',
      notice: { title: 'SKILL.md 生成完成' },
      dedupeKey: 'generation:skill:completed',
    })

    expect(published).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('缺主体时不发提示（N-9：`/agent` 发起的任务不进入本路径）', () => {
    const publisher = createWorkbenchNoticePublisher(() => false)

    const published = publisher.publish({
      subject: null,
      kind: 'success',
      notice: { title: '执行完成' },
      dedupeKey: 'execution:exec-1',
    })

    expect(published).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('同一终态重复触发只发一条（N-8）', () => {
    const publisher = createWorkbenchNoticePublisher(() => false)
    const input = {
      subject: SUBJECT,
      kind: 'success' as const,
      notice: { title: 'SKILL.md 生成完成' },
      dedupeKey: 'generation:skill:completed',
    }

    expect(publisher.publish(input)).toBe(true)
    expect(publisher.publish(input)).toBe(false)

    expect(sent).toHaveLength(1)
  })

  it('不同终态互不干扰：失败后重试再失败应各提示一次', () => {
    const publisher = createWorkbenchNoticePublisher(() => false)

    publisher.publish({
      subject: SUBJECT,
      kind: 'error',
      notice: { title: 'SKILL.md 生成失败' },
      dedupeKey: 'generation:skill:failed',
    })
    // 换一轮生成（阶段被替换），相同终态但属于新的工作项。
    publisher.publish({
      subject: SUBJECT,
      kind: 'error',
      notice: { title: 'SKILL.md 生成失败' },
      dedupeKey: 'generation:skill:failed:2',
    })

    expect(sent).toHaveLength(2)
  })

  it('forgetAll：清空后相同终态可再次提示（对应工作台被清空）', () => {
    const publisher = createWorkbenchNoticePublisher(() => false)
    const input = {
      subject: SUBJECT,
      kind: 'success' as const,
      notice: { title: 'SKILL.md 生成完成' },
      dedupeKey: 'generation:skill:completed',
    }

    publisher.publish(input)
    publisher.forgetAll()

    expect(publisher.publish(input)).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('三态分别走 success / warning / error（N-5）', () => {
    const publisher = createWorkbenchNoticePublisher(() => false)

    publisher.publish({
      subject: SUBJECT,
      kind: 'success',
      notice: { title: 'A' },
      dedupeKey: 'k1',
    })
    publisher.publish({
      subject: SUBJECT,
      kind: 'warning',
      notice: { title: 'B' },
      dedupeKey: 'k2',
    })
    publisher.publish({
      subject: SUBJECT,
      kind: 'error',
      notice: { title: 'C' },
      dedupeKey: 'k3',
    })

    expect(sent.map((item) => item.kind)).toEqual([
      'success',
      'warning',
      'error',
    ])
  })
})
