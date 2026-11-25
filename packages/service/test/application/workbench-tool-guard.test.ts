/**
 * 工作台工具守卫的单元测试（v16，v17 扩工具矩阵，PRD SEC-1 权限矩阵）。
 *
 * 逐类断言：env.json 禁读、平台维护文件禁写、工作区外读写拒绝、
 * 越权工具终止本轮、受保护文件写入**不**终止本轮、bash 的尽力而为边界。
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { assembleWorkbenchCapability } from '../../src/application/agent-workbench/workbench-assembly'
import { createAgentWorkbenchGuard } from '../../src/application/agent-workbench/workbench-tool-guard'
import type { IAgentWorkbenchService } from '../../src/application/agent-workbench/workbench-service'
import type { IAgentWorkRuntime } from '../../src/agent-runtime/agent-work-runtime'

const WORKSPACE = resolve('/tmp/authine-workbench')
const SKILL = resolve(WORKSPACE, '云7登录_abc123456')

/** 创建被测守卫。 */
function createGuard() {
  return createAgentWorkbenchGuard({
    id: 'test-workbench-guard',
    workspace: WORKSPACE,
    blockedToolReason: 'blocked tool',
  })
}

/** 最小工作台服务替身：装配只调用宿主工厂，不校验返回值。 */
function createServiceStub(): IAgentWorkbenchService {
  return {
    createCatalogHost: () => ({}) as never,
    createReadinessHost: () => ({}) as never,
    createViewHost: () => ({}) as never,
    createProposalHost: () => ({}) as never,
    createBatchHost: () => ({}) as never,
    createTestRunnerHost: () => ({}) as never,
    createActionHost: () => ({}) as never,
    runAction: async () => ({ ok: true, message: '' }),
  } as unknown as IAgentWorkbenchService
}

describe('工作台守卫：无副作用的工具放行', () => {
  it('加载技能、待办与提问工具放行', async () => {
    const guard = createGuard()

    for (const name of ['load_skill', 'todo_write', 'ask_user_question']) {
      expect(await guard.beforeCall?.({ name, args: {} })).toBeUndefined()
    }
  })

  /**
   * 回归锁：工作台工具矩阵扩容时，守卫白名单最容易漏登记。
   *
   * 这里不再手写一份工具名清单，而是直接取 `assembleWorkbenchCapability`
   * 的实际装配结果，逐项通过同一个装配出的守卫校验。这样新增工具而忘了
   * 放行时，本用例会立即失败，避免再次出现工具“能看见但一调用就被拦截”。
   */
  it('工作台装配注入的全部工具都必须放行（漏一个就断主链路）', async () => {
    const assembly = assembleWorkbenchCapability({
      sessionId: 's1',
      workspace: WORKSPACE,
      runtime: {} as IAgentWorkRuntime,
      service: createServiceStub(),
    })

    expect(assembly.tools.map((tool) => tool.name)).toContain('render_view')

    const { beforeCall } = assembly.toolGuard
    if (!beforeCall) {
      throw new Error('工作台装配未提供工具守卫 beforeCall')
    }

    for (const tool of assembly.tools) {
      const result = await beforeCall({
        name: tool.name,
        args: {},
      })
      expect(result, `工具 ${tool.name} 不应被工作台守卫拦截`).toBeUndefined()
    }
  })
})

describe('工作台守卫：read', () => {
  it('工作区内的普通文件放行', async () => {
    const guard = createGuard()

    for (const path of [
      resolve(SKILL, 'SKILL.md'),
      resolve(SKILL, 'test.spec.ts'),
      resolve(SKILL, 'userWorkSpace/notes.txt'),
      'e2e_schema.json',
    ]) {
      expect(
        await guard.beforeCall?.({ name: 'read', args: { path } }),
      ).toBeUndefined()
    }
  })

  it('读取 env.json 被拒绝且不终止本轮（含大小写与绝对路径变体）', async () => {
    const guard = createGuard()

    for (const path of [
      resolve(SKILL, 'env.json'),
      resolve(SKILL, 'ENV.JSON'),
      'env.json',
    ]) {
      const result = await guard.beforeCall?.({ name: 'read', args: { path } })
      expect(result).toMatchObject({ block: true })
      expect(
        result && 'terminate' in result ? result.terminate : undefined,
      ).toBeUndefined()
      expect(result?.reason).toContain('env.json')
    }
  })

  it('读取工作区之外的路径被拒绝且不终止本轮', async () => {
    const guard = createGuard()

    for (const path of [
      '/etc/passwd',
      '../../secret.txt',
      resolve(WORKSPACE, '..', 'other-workspace/file.txt'),
    ]) {
      const result = await guard.beforeCall?.({ name: 'read', args: { path } })
      expect(result).toMatchObject({ block: true })
      expect(result?.reason).toContain('工作区')
    }
  })

  it('缺少 path 参数被拒绝（无法判定即拒绝）', async () => {
    const guard = createGuard()
    const result = await guard.beforeCall?.({ name: 'read', args: {} })
    expect(result).toMatchObject({ block: true })
  })
})

describe('工作台守卫：write / edit', () => {
  it('写 userWorkSpace 与产物文件放行（PRD SEC-1④）', async () => {
    const guard = createGuard()

    for (const name of ['write', 'edit']) {
      for (const path of [
        resolve(SKILL, 'userWorkSpace/exports/report.csv'),
        resolve(SKILL, 'SKILL.md'),
        resolve(SKILL, 'test.spec.ts'),
      ]) {
        expect(
          await guard.beforeCall?.({ name, args: { path } }),
        ).toBeUndefined()
      }
    }
  })

  it('写平台维护文件被拒绝且不终止本轮', async () => {
    const guard = createGuard()

    for (const path of [
      resolve(SKILL, 'manifest.json'),
      resolve(SKILL, 'e2e_schema.json'),
      resolve(WORKSPACE, 'skill.list.json'),
      resolve(SKILL, 'env.json'),
    ]) {
      const result = await guard.beforeCall?.({ name: 'write', args: { path } })
      expect(result).toMatchObject({ block: true })
      expect(
        result && 'terminate' in result ? result.terminate : undefined,
      ).toBeUndefined()
      expect(result?.reason).toContain('平台维护')
    }
  })

  it('写入工作区之外被拒绝且不终止本轮', async () => {
    const guard = createGuard()
    const result = await guard.beforeCall?.({
      name: 'write',
      args: { path: '/tmp/elsewhere/evil.sh' },
    })

    expect(result).toMatchObject({ block: true })
    expect(result?.reason).toContain('工作区')
  })

  it('兼容 file_path 参数名（edit 工具的常见写法）', async () => {
    const guard = createGuard()

    const allowed = await guard.beforeCall?.({
      name: 'edit',
      args: { file_path: resolve(SKILL, 'SKILL.md') },
    })
    expect(allowed).toBeUndefined()

    const blocked = await guard.beforeCall?.({
      name: 'edit',
      args: { file_path: resolve(SKILL, 'manifest.json') },
    })
    expect(blocked).toMatchObject({ block: true })
  })
})

describe('工作台守卫：bash 与未知工具', () => {
  it('危险命令与受保护文件写入被拒绝且不终止本轮', async () => {
    const guard = createGuard()

    for (const command of [
      'rm -rf /',
      'cat env.json',
      'echo x > manifest.json',
      'sed -i s/a/b/ e2e_schema.json',
      'cat ~/secrets.txt',
    ]) {
      const result = await guard.beforeCall?.({
        name: 'bash',
        args: { command },
      })
      expect(result).toMatchObject({ block: true })
      expect(
        result && 'terminate' in result ? result.terminate : undefined,
      ).toBeUndefined()
    }
  })

  it('普通命令放行', async () => {
    const guard = createGuard()
    const result = await guard.beforeCall?.({
      name: 'bash',
      args: { command: 'ls -la' },
    })
    expect(result).toBeUndefined()
  })

  it('未授权工具阻断并终止本轮', async () => {
    const guard = createGuard()
    const result = await guard.beforeCall?.({
      name: 'browser_navigate',
      args: {},
    })

    expect(result).toMatchObject({ block: true, terminate: true })
  })
})
