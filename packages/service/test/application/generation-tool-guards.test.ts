/**
 * 生成任务工具守卫的单元测试：read 白名单、env.json 读取阻断（v10 PRD 4.3）
 * 与 write 目标约束。
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createGenerationWriteGuard } from '../../src/application/e2e-test-case/generation-tool-guards'
import type { IToolGuard } from '@charlie_deng/e2e-assistant-agent'

const WORKSPACE = '/tmp/authine-workspace'
const TARGET = '/tmp/authine-workspace/skill-1/temp/candidate.spec.ts'

/** 创建一条 SKILL.md 生成路径风格的守卫（无浏览器工具）。 */
function createDocumentGuard (): IToolGuard {
  return createGenerationWriteGuard({
    id: 'test-document-guard',
    workspace: WORKSPACE,
    targetFile: '/tmp/authine-workspace/skill-1/SKILL.md',
    extraAllowedPrefixes: [],
    blockedToolReason: 'blocked tool',
  })
}

/** 创建一条 Playwright 脚本生成路径风格的守卫（放行 browser_ 前缀）。 */
function createScriptGuard (): IToolGuard {
  return createGenerationWriteGuard({
    id: 'test-script-guard',
    workspace: WORKSPACE,
    targetFile: TARGET,
    extraAllowedPrefixes: ['browser_'],
    blockedToolReason: 'blocked tool',
  })
}

describe('createGenerationWriteGuard read 守卫', () => {
  it('工作区内的普通文件放行', async () => {
    const guard = createDocumentGuard()

    for (const path of [
      'skill-1/e2e_schema.json',
      '/tmp/authine-workspace/skill-1/SKILL.md',
    ]) {
      const result = await guard.beforeCall?.({ name: 'read', args: { path } })
      expect(result).toBeUndefined()
    }
  })

  it('读取 env.json 被阻断且不终止本轮（相对路径）', async () => {
    const guard = createDocumentGuard()
    const result = await guard.beforeCall?.({
      name: 'read',
      args: { path: 'skill-1/env.json' },
    })

    expect(result).toMatchObject({ block: true })
    expect(
      result && 'terminate' in result ? result.terminate : undefined,
    ).toBeUndefined()
    expect(result?.reason).toContain('env.json')
  })

  it('读取 env.json 被阻断（绝对路径与大小写变体）', async () => {
    const guard = createDocumentGuard()

    for (const path of [
      '/tmp/authine-workspace/skill-1/env.json',
      'skill-1/ENV.JSON',
      'skill-1/Env.Json',
    ]) {
      const result = await guard.beforeCall?.({ name: 'read', args: { path } })
      expect(result).toMatchObject({ block: true })
    }
  })

  it('env.json 阻断在 SKILL.md 与脚本两条守卫上同时生效', async () => {
    for (const guard of [createDocumentGuard(), createScriptGuard()]) {
      const result = await guard.beforeCall?.({
        name: 'read',
        args: { path: 'skill-1/env.json' },
      })
      expect(result).toMatchObject({ block: true })
    }
  })

  it('工作区之外的文件仍被越界守卫阻断', async () => {
    const guard = createDocumentGuard()
    const result = await guard.beforeCall?.({
      name: 'read',
      args: { path: '/etc/passwd' },
    })

    expect(result).toMatchObject({ block: true })
    expect(result?.reason).toContain('工作区')
  })
})

describe('createGenerationWriteGuard write 与白名单', () => {
  it('browser_ 前缀工具仅在脚本生成守卫放行', async () => {
    const documentGuard = createDocumentGuard()
    const scriptGuard = createScriptGuard()

    expect(
      await scriptGuard.beforeCall?.({
        name: 'browser_navigate',
        args: { url: 'https://example.test' },
      }),
    ).toBeUndefined()
    expect(
      await documentGuard.beforeCall?.({ name: 'browser_navigate', args: {} }),
    ).toMatchObject({ block: true })
  })

  it('v12 新增的视觉基线工具同样走 browser_ 前缀自动放行', async () => {
    // 回归保护：若该工具未被放行，兜底判定会以 terminate 终止整轮生成
    // （v12-pre 已有同类教训：未白名单的工具会直接杀掉生成任务）。
    const scriptGuard = createScriptGuard()

    expect(
      await scriptGuard.beforeCall?.({
        name: 'browser_capture_baseline',
        args: {
          selector: '.print-canvas',
          segments: ['preview'],
          fileName: 'a.png',
        },
      }),
    ).toBeUndefined()
  })

  it('todo_write 在两条生成路径都放行（不读写文件、不访问页面）', async () => {
    // 若未放行，兜底判定会以 terminate 终止整轮生成——代价远大于维护清单的风险。
    for (const guard of [createDocumentGuard(), createScriptGuard()]) {
      const result = await guard.beforeCall?.({
        name: 'todo_write',
        args: { items: [{ id: 's1', content: '登录', status: 'pending' }] },
      })
      expect(result).toBeUndefined()
    }
  })

  it('ask_user_question 在两条生成路径都放行（阻塞式提问，不读写文件、不访问页面）', async () => {
    // 与 todo_write 同类：Agent 缺少关键信息时向用户发问。
    // 若未放行，兜底判定会以 terminate 终止整轮生成，Agent 将无法提问而被迫静默决策。
    for (const guard of [createDocumentGuard(), createScriptGuard()]) {
      const result = await guard.beforeCall?.({
        name: 'ask_user_question',
        args: {
          questions: [
            {
              label: '基准目录',
              options: [{ label: '默认', value: 'baselines' }],
            },
            {
              label: '基准图片',
              options: [{ label: 'a', value: 'baselines/a.png' }],
            },
          ],
          context: '缺少基准信息',
        },
      })
      expect(result).toBeUndefined()
    }
  })

  it('写入目标之外的路径被拒绝但不终止本轮（v15）', async () => {
    const guard = createScriptGuard()
    const result = await guard.beforeCall?.({
      name: 'write',
      args: { path: '/elsewhere/skill-1/SKILL.md', content: 'x' },
    })

    // 拒绝写入（v14 写入边界不变），但保留本轮：Agent 拿到正确路径后可自行重写。
    expect(result).toMatchObject({ block: true })
    expect(result?.terminate).toBeUndefined()
    // 越界与写错位置给不同的修复指令，且都必须带上正确的绝对路径。
    expect(result?.reason).toContain('工作区之外')
    expect(result?.reason).toContain(resolve(TARGET))
  })

  it('写错文件名同样不终止本轮（v15）', async () => {
    const guard = createScriptGuard()
    const result = await guard.beforeCall?.({
      name: 'write',
      args: {
        path: `${WORKSPACE}/skill-1/temp/candidate-wrong.spec.ts`,
        content: 'x',
      },
    })

    expect(result).toMatchObject({ block: true })
    expect(result?.terminate).toBeUndefined()
    // 位置在工作区内但文件不对：措辞应与越界区分，同样给出正确路径。
    expect(result?.reason).not.toContain('工作区之外')
    expect(result?.reason).toContain(resolve(TARGET))
  })

  it('写入指定目标放行', async () => {
    const guard = createScriptGuard()
    const result = await guard.beforeCall?.({
      name: 'write',
      args: { path: TARGET, content: 'x' },
    })

    expect(result).toBeUndefined()
  })

  it('白名单之外的工具被阻断并终止', async () => {
    const guard = createDocumentGuard()
    const result = await guard.beforeCall?.({ name: 'grep', args: {} })

    expect(result).toMatchObject({ block: true, terminate: true })
  })

  // v11（技术方案 D11）：bash 放开白名单，但命中危险清单的命令拒绝执行且不终止本轮。
  it('危险 bash 命令被阻断但不终止本轮', async () => {
    const guard = createDocumentGuard()
    const result = await guard.beforeCall?.({
      name: 'bash',
      args: { command: 'cat env.json' },
    })

    expect(result).toMatchObject({ block: true })
    expect(result).not.toMatchObject({ terminate: true })
  })

  it('正常 bash 命令放行', async () => {
    const guard = createDocumentGuard()
    const result = await guard.beforeCall?.({
      name: 'bash',
      args: { command: 'node --version' },
    })

    expect(result).toBeUndefined()
  })
})
