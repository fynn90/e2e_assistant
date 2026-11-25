/**
 * Skill 文件树（v14 悬停操作按钮矩阵）的组件测试。
 *
 * 覆盖 PRD W40-W48 / D6：
 *   - userWorkSpace 根目录：新建目录 + 新建文件，**无删除按钮**（W41/W21）；
 *   - userWorkSpace 子目录：新建目录 + 新建文件 + 删除（W42）；
 *   - userWorkSpace 内文件：仅删除（W43）；
 *   - userWorkSpace 之外的节点不出现新建按钮（W44）；受保护根文件无删除按钮；
 *   - 新建入口直接进入名称输入（W45）；非法名称即时提示且不提交（W47）；
 *   - 删除确认框展示完整相对路径（W16）与执行中风险提示（场景 15）。
 */

import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import type { ISkillFileTreeNode } from '@charlie_deng/e2e-assistant-types'
import SkillExplorer from '../../src/modules/skill-development/SkillExplorer.vue'

// 新建 API 打桩：只验证调用与失败保留输入，不触网。
const createUserWorkspaceDirectoryMock = vi.fn().mockResolvedValue({
  success: true,
  data: { relativePath: 'userWorkSpace/exports' },
})
const createUserWorkspaceFileMock = vi.fn().mockResolvedValue({
  success: true,
  data: { relativePath: 'userWorkSpace/exports/a.csv', version: 'v', size: 0 },
})

vi.mock('../../src/services/skill-api', () => ({
  createUserWorkspaceDirectory: (...args: unknown[]) =>
    createUserWorkspaceDirectoryMock(...args),
  createUserWorkspaceFile: (...args: unknown[]) =>
    createUserWorkspaceFileMock(...args),
}))

/** 构造测试文件树（含 userWorkSpace 各类节点与保护文件）。 */
function buildNodes (): ISkillFileTreeNode[] {
  return [
    {
      kind: 'file',
      name: 'manifest.json',
      relativePath: 'manifest.json',
      size: 10,
      openability: 'known_text',
      readOnly: true,
    },
    {
      kind: 'file',
      name: 'SKILL.md',
      relativePath: 'SKILL.md',
      size: 10,
      openability: 'known_text',
      readOnly: false,
    },
    {
      kind: 'directory',
      name: 'userWorkSpace',
      relativePath: 'userWorkSpace',
      protection: 'user-workspace-root',
      children: [
        {
          kind: 'directory',
          name: 'exports',
          relativePath: 'userWorkSpace/exports',
          children: [
            {
              kind: 'file',
              name: 'a.csv',
              relativePath: 'userWorkSpace/exports/a.csv',
              size: 4,
              openability: 'known_text',
              readOnly: false,
            },
          ],
        },
      ],
    },
  ]
}

/**
 * 测试宿主：把 SkillExplorer 包在 NMessageProvider 内。
 *
 * SkillExplorer 内部使用 naive-ui 的 useMessage（新建成功提示），
 * 必须处于 provider 子树中，否则 setup 阶段直接抛错。
 */
const ExplorerHost = defineComponent({
  components: { NMessageProvider, SkillExplorer },
  props: {
    explorerProps: { type: Object, required: true },
  },
  emits: [
    'open',
    'refresh',
    'created',
    'execute',
    'delete-report',
    'delete-entry',
  ],
  template: `
    <n-message-provider>
      <SkillExplorer v-bind="explorerProps"
        @open="$emit('open', $event)"
        @refresh="$emit('refresh')"
        @created="$emit('created')"
        @execute="$emit('execute')"
        @delete-report="$emit('delete-report', $event)"
        @delete-entry="$emit('delete-entry', $event)" />
    </n-message-provider>
  `,
})

/** 挂载组件（actionsEnabled 默认开启；userWorkSpace 层级默认展开以便断言子行）。 */
function mountExplorer (props: Record<string, unknown> = {}) {
  return mount(ExplorerHost, {
    props: {
      explorerProps: {
        nodes: buildNodes(),
        skillId: 'abc123def',
        actionsEnabled: true,
        reportDeleteEnabled: true,
        expandedKeys: ['userWorkSpace', 'userWorkSpace/exports'],
        ...props,
      },
    },
    attachTo: document.body,
  })
}

/** 按节点名找到对应树行。 */
function findRow (label: string) {
  return Array.from(document.querySelectorAll('.n-tree-node')).find((row) =>
    row.textContent?.includes(label),
  )
}

/** 统计某树行内的悬停操作按钮数。 */
function rowButtonCount (label: string): number {
  return findRow(label)?.querySelectorAll('.tree-action-button').length ?? -1
}

let wrapper: ReturnType<typeof mountExplorer> | null = null

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('悬停操作按钮矩阵（W40-W44/D6）', () => {
  it('userWorkSpace 根目录：新建目录 + 新建文件，无删除按钮（W41/W21）', () => {
    wrapper = mountExplorer()

    expect(rowButtonCount('userWorkSpace')).toBe(2)
    // 根行不含删除图标按钮（图标渲染在按钮内，删除按钮也计入 tree-action-button）。
    const row = findRow('userWorkSpace')
    expect(row?.querySelectorAll('.tree-action-button').length).toBe(2)
  })

  it('userWorkSpace 子目录：新建目录 + 新建文件 + 删除（W42）', () => {
    wrapper = mountExplorer()

    expect(rowButtonCount('exports')).toBe(3)
  })

  it('userWorkSpace 内文件：仅删除（W43）', () => {
    wrapper = mountExplorer()

    expect(rowButtonCount('a.csv')).toBe(1)
  })

  it('userWorkSpace 之外的节点不出现新建按钮（W44）；受保护根文件无删除按钮', () => {
    wrapper = mountExplorer()

    // SKILL.md 非保护文件（v13 可删）：有删除但无新建（1 个按钮）。
    expect(rowButtonCount('SKILL.md')).toBe(1)
    // manifest.json 是创建期保护文件：无任何按钮。
    expect(rowButtonCount('manifest.json')).toBe(0)
  })

  it('只读 Skill（actionsEnabled=false）不显示新建与删除按钮', () => {
    wrapper = mountExplorer({
      actionsEnabled: false,
      reportDeleteEnabled: false,
    })

    expect(rowButtonCount('userWorkSpace')).toBe(0)
    expect(rowButtonCount('exports')).toBe(0)
    expect(rowButtonCount('a.csv')).toBe(0)
    expect(rowButtonCount('SKILL.md')).toBe(0)
  })
})

describe('受保护根的文件节点形态（缺陷 B 回归，W10/W21）', () => {
  /**
   * 构造 userWorkSpace 路径被同名普通文件占用的边缘节点树：
   * 服务端此时标注的是 **文件节点**（kind:'file'）但仍带 protection 标记。
   */
  function buildOccupiedNodes (): ISkillFileTreeNode[] {
    return [
      {
        kind: 'file',
        name: 'userWorkSpace',
        relativePath: 'userWorkSpace',
        size: 8,
        openability: 'known_text',
        readOnly: false,
        protection: 'user-workspace-root',
        notice:
          'userWorkSpace 已被同名文件占用，请手动备份并删除或改名该文件后重试。',
      },
    ]
  }

  it('受保护文件节点不渲染删除按钮（protection 与 kind 无关）', () => {
    wrapper = mountExplorer({ nodes: buildOccupiedNodes() })

    // 文件节点若是普通文件本应有删除按钮；带 protection 后必须为零。
    expect(rowButtonCount('userWorkSpace')).toBe(0)
  })

  it('受保护文件节点渲染常驻锁定图标（W21）', () => {
    wrapper = mountExplorer({ nodes: buildOccupiedNodes() })

    const row = findRow('userWorkSpace')
    expect(row?.querySelector('.tree-lock-icon')).not.toBeNull()
  })
})

describe('新建弹窗（W45/W47/W48）', () => {
  it('点击「新建目录」直接进入名称输入（不先选类型，W45）', async () => {
    wrapper = mountExplorer()

    const row = findRow('userWorkSpace')
    const buttons = row?.querySelectorAll('.tree-action-button') ?? []
      ; (buttons[0] as HTMLElement).click()
    await flushPromises()

    // 弹窗出现且含名称输入框。
    const modalText = document.body.textContent ?? ''
    expect(modalText).toContain('新建目录')
    expect(document.querySelector('.n-modal input')).not.toBeNull()
  })

  it('非法名称即时提示且不提交（W47）', async () => {
    wrapper = mountExplorer()

    const row = findRow('userWorkSpace')
    const buttons = row?.querySelectorAll('.tree-action-button') ?? []
      ; (buttons[0] as HTMLElement).click()
    await flushPromises()

    const input = document.querySelector('.n-modal input') as HTMLInputElement
    input.value = '../escape'
    input.dispatchEvent(new Event('input'))
    await flushPromises()

    // 确认按钮点击后出现错误提示，且未调用 API。
    const confirmButton = Array.from(
      document.querySelectorAll('.n-modal button'),
    ).find((button) => button.textContent?.includes('新建'))
      ; (confirmButton as HTMLElement).click()
    await flushPromises()

    expect(document.body.textContent).toContain('名称不合法')
    expect(createUserWorkspaceDirectoryMock).not.toHaveBeenCalled()
  })

  it('合法名称提交调用创建 API 并触发刷新（W48）', async () => {
    wrapper = mountExplorer()
    // 局部捕获：wrapper 是模块级 `| null`（afterEach 置空），
    // vi.waitFor 的异步回调内 TS 无法收窄，用 const 引用断言 emitted。
    const mounted = wrapper

    const row = findRow('exports')
    const buttons = row?.querySelectorAll('.tree-action-button') ?? []
      ; (buttons[0] as HTMLElement).click()
    await flushPromises()

    const input = document.querySelector('.n-modal input') as HTMLInputElement
    input.value = 'q1'
    input.dispatchEvent(new Event('input'))
    await flushPromises()

    const confirmButton = Array.from(
      document.querySelectorAll('.n-modal button'),
    ).find((button) => button.textContent?.includes('新建'))
      ; (confirmButton as HTMLElement).click()
    await vi.waitFor(() => {
      expect(createUserWorkspaceDirectoryMock).toHaveBeenCalledWith(
        'abc123def',
        'exports/q1',
      )
    })

    // 创建成功发 `created`（非节流刷新），而非 `refresh`（手动按钮的节流刷新）：
    // 连续创建时后者会被 3 秒节流吞掉，新节点不显示（W48 回归锁定）。
    await vi.waitFor(() => {
      expect(mounted.emitted('created')).toHaveLength(1)
    })
    expect(mounted.emitted('refresh')).toBeUndefined()
  })
})

describe('删除确认框（W16/场景 15）', () => {
  it('正文展示完整相对路径与不可恢复提示（W16）', async () => {
    wrapper = mountExplorer()

    const row = findRow('a.csv')
    const deleteButton = row?.querySelector(
      '.tree-action-button',
    ) as HTMLElement
    deleteButton.click()
    await flushPromises()

    const text = document.body.textContent ?? ''
    expect(text).toContain('userWorkSpace/exports/a.csv')
    expect(text).toContain('删除后不可恢复')
  })

  it('执行中删除 userWorkSpace 子内容出现风险提示（场景 15/R4）', async () => {
    wrapper = mountExplorer({ executionRunning: true })

    const row = findRow('a.csv')
    const deleteButton = row?.querySelector(
      '.tree-action-button',
    ) as HTMLElement
    deleteButton.click()
    await flushPromises()

    expect(document.body.textContent).toContain('当前有测试正在执行')
  })

  it('执行中删除非 userWorkSpace 内容不出现该风险提示', async () => {
    wrapper = mountExplorer({ executionRunning: true })

    const row = findRow('SKILL.md')
    const deleteButton = row?.querySelector(
      '.tree-action-button',
    ) as HTMLElement
    deleteButton.click()
    await flushPromises()

    expect(document.body.textContent).not.toContain('当前有测试正在执行')
  })
})
