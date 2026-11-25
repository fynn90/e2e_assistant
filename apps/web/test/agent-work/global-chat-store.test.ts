/**
 * 工作台应用级界面状态 store 的单元测试（v13）。
 *
 * 覆盖：展开 / 收起 / 切换、**显示主体的设置与丢弃**。
 *
 * v9 曾从此处移除 `boundSessionId` 与 `openForSession`（抽屉不再绑定单个会话）；
 * v13 重新引入一项与路由无关的状态 `subject`，但它的语义不同——它记的是
 * **当前承载哪个工作项**（来源 Skill + 种类），而不是「显示哪个 Agent 会话」。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useGlobalChatStore } from '../../src/stores/global-chat'

describe('global-chat store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始状态：收起且无显示主体（空态）', () => {
    const store = useGlobalChatStore()

    expect(store.visible).toBe(false)
    expect(store.subject).toBeNull()
    expect(store.hasSubject).toBe(false)
  })

  it('expand：展开工作台', () => {
    const store = useGlobalChatStore()

    store.expand()

    expect(store.visible).toBe(true)
  })

  it('collapse：收起工作台，仅隐藏界面（不清空内容）', () => {
    const store = useGlobalChatStore()
    store.expand()
    store.setSubject({ kind: 'generation', skillId: 'skill-001' })

    store.collapse()

    expect(store.visible).toBe(false)
    // 收起不销毁内容——这正是 v13 与 v9「关闭」的关键差别（PRD B-4/M-1）。
    expect(store.subject).not.toBeNull()
  })

  it('toggle：在展开与收起之间切换', () => {
    const store = useGlobalChatStore()

    store.toggle()
    expect(store.visible).toBe(true)

    store.toggle()
    expect(store.visible).toBe(false)
  })

  it('setSubject：落地显示主体并可携带来源 Skill 标题与执行 ID（PRD E-3）', () => {
    const store = useGlobalChatStore()

    store.setSubject({
      kind: 'execution',
      skillId: 'skill-001',
      skillTitle: '登录流程',
      executionId: 'exec-1',
    })

    expect(store.hasSubject).toBe(true)
    expect(store.subject).toEqual({
      kind: 'execution',
      skillId: 'skill-001',
      skillTitle: '登录流程',
      executionId: 'exec-1',
    })
  })

  it('dropSubject：回到空态但**不影响**展开状态（PRD B-6：清空不收起）', () => {
    const store = useGlobalChatStore()
    store.expand()
    store.setSubject({ kind: 'generation', skillId: 'skill-001' })

    store.dropSubject()

    expect(store.subject).toBeNull()
    expect(store.visible).toBe(true)
  })

  it('已收窄为界面状态：不再暴露会话绑定字段', () => {
    const store = useGlobalChatStore()

    expect('boundSessionId' in store).toBe(false)
    expect('openForSession' in store).toBe(false)
  })
})
