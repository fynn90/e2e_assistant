/**
 * 文件树节点转换规则的单元测试（含 v13 图片放行）。
 *
 * 覆盖三类节点的可点击性：
 *   - 文本文件：可点击（进代码面板）；
 *   - 图片（v13 放行）：可点击（进图片预览面板）——此前是灰掉的死节点；
 *   - 其他二进制：仍禁用，避免用户点开一个必然失败的文本编辑器。
 *   - `test_report/` 下的附件：保持 v11 的「可点击以给出提示」行为不被回归。
 */
import { describe, expect, it } from 'vitest'
import {
  isPreviewableImageNode,
  resolveMissingOpenFileAction,
  resolveSkillFileOpenTarget,
  toTreeOptions,
} from '../../src/modules/skill-development/skill-file'
import type { ISkillFileTreeNode } from '@charlie_deng/e2e-assistant-types'

/**
 * 构造一个文件树节点。
 *
 * @param name - 文件名。
 * @param relativePath - Skill 内相对路径。
 * @param options - 可覆盖 openability 与 kind。
 * @returns 文件树节点。
 * @throws 不抛出异常。
 */
function createFileNode (
  name: string,
  relativePath: string,
  options: {
    openability?: 'known_text' | 'known_unsupported' | 'unchecked'
  } = {},
): ISkillFileTreeNode {
  return {
    kind: 'file',
    name,
    relativePath,
    size: 128,
    openability: options.openability ?? 'known_unsupported',
    readOnly: false,
  }
}

describe('isPreviewableImageNode', () => {
  it.each(['a.png', 'a.PNG', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp'])(
    '把 %s 识别为可预览图片',
    (name) => {
      expect(isPreviewableImageNode(createFileNode(name, name))).toBe(true)
    },
  )

  it.each(['a.pdf', 'b.zip', 'c.svg', 'd.ico', 'e.tiff'])(
    '不把 %s 识别为可预览图片',
    (name) => {
      // svg 是可执行脚本载体（可含 <script>），不作为图片直接内联渲染
      expect(isPreviewableImageNode(createFileNode(name, name))).toBe(false)
    },
  )

  it('对无扩展名的文件返回 false', () => {
    expect(isPreviewableImageNode(createFileNode('README', 'README'))).toBe(
      false,
    )
  })

  it('对点开头的隐藏文件返回 false（点号不构成扩展名）', () => {
    expect(
      isPreviewableImageNode(createFileNode('.gitignore', '.gitignore')),
    ).toBe(false)
  })

  it('对目录节点返回 false', () => {
    const directory: ISkillFileTreeNode = {
      kind: 'directory',
      name: 'baselines',
      relativePath: 'baselines',
      children: [],
    }
    expect(isPreviewableImageNode(directory)).toBe(false)
  })
})

describe('toTreeOptions', () => {
  it('图片节点不再被禁用（v13 放行的核心断言）', () => {
    const options = toTreeOptions([
      createFileNode(
        'online_workflow_log_20260623.png',
        'baselines/img/online_workflow_log_20260623.png',
      ),
    ])

    expect(options[0]!.disabled).toBe(false)
  })

  it('非图片二进制节点仍被禁用', () => {
    const options = toTreeOptions([
      createFileNode('report.pdf', 'artifact/report.pdf'),
    ])

    expect(options[0]!.disabled).toBe(true)
  })

  it('文本文件不禁用', () => {
    const options = toTreeOptions([
      createFileNode('test.spec.ts', 'test.spec.ts', {
        openability: 'known_text',
      }),
    ])

    expect(options[0]!.disabled).toBe(false)
  })

  it('test_report 下的二进制附件保持可点击（v11 行为不被回归）', () => {
    const options = toTreeOptions([
      createFileNode(
        'attachment-1.png',
        'test_report/20260922-132412/attachment-1.png',
      ),
    ])

    // 可点击是为了让 openFile 能给出「附件请在报告中查看」的提示
    expect(options[0]!.disabled).toBe(false)
  })

  it('递归转换子节点并保留层级', () => {
    const options = toTreeOptions([
      {
        kind: 'directory',
        name: 'baselines',
        relativePath: 'baselines',
        children: [createFileNode('a.png', 'baselines/a.png')],
      },
    ])

    expect(options[0]!.children![0]!.key).toBe('baselines/a.png')
    expect(options[0]!.children![0]!.disabled).toBe(false)
  })
})

describe('resolveSkillFileOpenTarget 的分流优先级', () => {
  it('baselines 下的图片 → 图片预览', () => {
    const target = resolveSkillFileOpenTarget(
      createFileNode('a.png', 'baselines/img/a.png'),
    )

    expect(target).toEqual({
      type: 'image',
      relativePath: 'baselines/img/a.png',
    })
  })

  it('报告目录下的图片附件 → 图片预览（而非「请在报告中查看」）', () => {
    // 回归保护：图片分流曾被放在 test_report/ 分支**之后**，报告附件因此
    // 被拦成提示而永远打不开。图片必须最先判定，不受目录限制。
    const target = resolveSkillFileOpenTarget(
      createFileNode(
        'attachment-4.png',
        'test_report/20260922-153654/attachment-4.png',
      ),
    )

    expect(target).toEqual({
      type: 'image',
      relativePath: 'test_report/20260922-153654/attachment-4.png',
    })
  })

  it('报告入口 report.html 仍进入报告视图（不被图片规则截走）', () => {
    const target = resolveSkillFileOpenTarget(
      createFileNode('report.html', 'test_report/20260922-153654/report.html'),
    )

    expect(target).toEqual({ type: 'report', runId: '20260922-153654' })
  })

  it('报告目录下的非图片附件 → 提示去报告中查看', () => {
    const target = resolveSkillFileOpenTarget(
      createFileNode('trace.zip', 'test_report/20260922-153654/trace.zip'),
    )

    expect(target).toEqual({ type: 'notice', message: '附件请在报告中查看' })
  })

  it('runId 格式非法时不进入报告视图', () => {
    const target = resolveSkillFileOpenTarget(
      createFileNode('report.html', 'test_report/not-a-run/report.html'),
    )

    expect(target).toBeUndefined()
  })

  it('e2e_schema.json → 结构化用例面板', () => {
    const target = resolveSkillFileOpenTarget(
      createFileNode('e2e_schema.json', 'e2e_schema.json', {
        openability: 'known_text',
      }),
    )

    expect(target).toEqual({ type: 'e2e-test-case' })
  })

  it('普通文本文件 → 代码面板', () => {
    const target = resolveSkillFileOpenTarget(
      createFileNode('test.spec.ts', 'test.spec.ts', {
        openability: 'known_text',
      }),
    )

    expect(target).toEqual({ type: 'code', relativePath: 'test.spec.ts' })
  })

  it('目录节点不产生打开目标', () => {
    const target = resolveSkillFileOpenTarget({
      kind: 'directory',
      name: 'baselines',
      relativePath: 'baselines',
      children: [],
    })

    expect(target).toBeUndefined()
  })
})

describe('resolveMissingOpenFileAction（当前文件消失时的处理决策）', () => {
  it('用户主动删除且无未保存修改 → 静默清空（不提示「文件已不存在」）', () => {
    // 回归保护：用户刚点完删除、已收到「删除成功」，再弹「文件已不存在」是误报。
    const action = resolveMissingOpenFileAction({
      hasUnsavedChanges: false,
      userInitiated: true,
    })

    expect(action).toEqual({ type: 'clear-silently' })
  })

  it('外部删除且无未保存修改 → 清空并提示（保持 PRD v4 §8.2 的原行为）', () => {
    const action = resolveMissingOpenFileAction({
      hasUnsavedChanges: false,
      userInitiated: false,
    })

    expect(action).toEqual({ type: 'clear-and-notice' })
  })

  it('有未保存修改 → 保留为只读缓冲区（不论是否用户主动删除）', () => {
    // 内容优先：即使用户主动删除，也不能静默丢弃他已输入的内容。
    expect(
      resolveMissingOpenFileAction({
        hasUnsavedChanges: true,
        userInitiated: true,
      }),
    ).toEqual({ type: 'preserve-orphan' })

    expect(
      resolveMissingOpenFileAction({
        hasUnsavedChanges: true,
        userInitiated: false,
      }),
    ).toEqual({ type: 'preserve-orphan' })
  })
})
