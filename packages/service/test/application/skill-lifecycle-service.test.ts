/**
 * 用例生命周期服务（v17 §6.6）的单元测试。
 *
 * 核心是 L2c：删除用例前必须查任务注册表——此前三层都没有这道检查，
 * 删掉正在执行的用例会 `rm -rf` 掉浏览器仍在使用的目录（F28）。
 *
 * 同一条检查也修好了 **Skill 管理页** 的同一缺陷（R13）：那个行为变化是
 * 有意的，因此这里也锁定「路由与服务共用同一实现」。
 */
import { describe, expect, it } from 'vitest'
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkill } from '@fynn90-e2e_assistant/skill-manager'
import { createSkillLifecycleService } from '../../src/application/agent-workbench/skill-lifecycle-service'
import type { IGenerationTaskRegistry } from '../../src/generation-runtime/generation-task-registry'

/** 任务注册表替身。 */
function createRegistry (running: Record<string, string> = {}): IGenerationTaskRegistry {
  const map = new Map(Object.entries(running))
  return {
    currentSessionId: (skillId: string) => map.get(skillId),
  } as unknown as IGenerationTaskRegistry
}

/** 造一个用例目录。 */
async function createCase (rootDir: string, title: string): Promise<string> {
  const created = await createSkill({ rootDir, title, description: '描述' })
  return created.skillManifest.id
}

describe('deleteCase（L2c）', () => {
  it('无任务时正常删除（文件层 + 索引）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    const skillId = await createCase(rootDir, '待删用例')
    const service = createSkillLifecycleService()

    await service.deleteCase({
      rootDir,
      skillId,
      taskRegistry: createRegistry(),
    })

    // 索引里已找不到 → resolveSkill 失败即「已删除」。
    const { resolveSkill } = await import('@fynn90-e2e_assistant/skill-manager')
    await expect(resolveSkill({ rootDir }, skillId)).rejects.toThrow()
  })

  it('★ 有执行任务在跑 → 拒绝，且**不删任何东西**（L2c）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    const skillId = await createCase(rootDir, '执行中的用例')
    const service = createSkillLifecycleService()

    await expect(
      service.deleteCase({
        rootDir,
        skillId,
        // 任务注册表说这个用例正有任务在跑（执行侧与生成侧共用同一映射）。
        taskRegistry: createRegistry({ [skillId]: 'exec-1' }),
      }),
    ).rejects.toThrow(/正在执行/)

    // 用例仍在（拒绝发生在任何写操作之前）。
    const { resolveSkill } = await import('@fynn90-e2e_assistant/skill-manager')
    await expect(resolveSkill({ rootDir }, skillId)).resolves.toBeTruthy()
  })

  it('★ 有生成任务在跑同样拒绝（两侧共用同一 runningTasks 映射）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    const skillId = await createCase(rootDir, '生成中的用例')
    const service = createSkillLifecycleService()

    await expect(
      service.deleteCase({
        rootDir,
        skillId,
        taskRegistry: createRegistry({ [skillId]: 'gen-session-1' }),
      }),
    ).rejects.toThrow(/正在执行或有生成任务在跑/)
  })

  it('拒绝时给出「先停止任务」的方向（不是一句干巴巴的失败）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    const skillId = await createCase(rootDir, '缺方向')
    const service = createSkillLifecycleService()

    await expect(
      service.deleteCase({
        rootDir,
        skillId,
        taskRegistry: createRegistry({ [skillId]: 'x' }),
      }),
    ).rejects.toThrow(/停止任务/)
  })

  it('目标不存在 → 抛错（由路由映射为 HTTP）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    const service = createSkillLifecycleService()

    await expect(
      service.deleteCase({
        rootDir,
        skillId: 'zzzzzzzzz',
        taskRegistry: createRegistry(),
      }),
    ).rejects.toThrow()
  })

  it('删除会连带清理该用例的 test_report 目录（整目录随 Skill 根一起删）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    const created = await createSkill({
      rootDir,
      title: '带报告的用例',
      description: '描述',
    })
    const skillId = created.skillManifest.id
    const skillRoot = join(rootDir, created.skillManifest.directoryName!)
    await mkdir(join(skillRoot, 'test_report', '20261009-120000'), {
      recursive: true,
    })
    await writeFile(
      join(skillRoot, 'test_report', '20261009-120000', 'report.html'),
      '<html></html>',
      'utf8',
    )

    const service = createSkillLifecycleService()
    await service.deleteCase({
      rootDir,
      skillId,
      taskRegistry: createRegistry(),
    })

    // 整个 Skill 目录（含报告）都没了。
    await expect(access(skillRoot)).rejects.toThrow()
  })
})
