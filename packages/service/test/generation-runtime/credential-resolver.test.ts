/**
 * 生成期凭据解析器的单元测试（v20 凭据代理）。
 *
 * 该模块是**唯一接触 env.json 真实值的新位置**，因此测试的重点不是「能读到值」，
 * 而是它的边界语义：失败一律归类为稳定原因码（不携带值）、
 * 每次调用重新读盘（用户补值后立即可见）、以及文件非法时统一降级。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSkill } from '@fynn90-e2e_assistant/skill-manager'
import { SKILL_ENV_FILE_NAME } from '@fynn90-e2e_assistant/skill-manager'
import { createSkillCredentialResolver } from '../../src/generation-runtime/credential-resolver'

describe('createSkillCredentialResolver', () => {
  let rootDir: string
  let skillId: string
  let skillRoot: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'credential-resolver-'))
    const created = await createSkill({
      rootDir,
      title: '凭据解析测试',
      description: '测试用 Skill',
    })
    skillId = created.skillManifest.id
    skillRoot = created.skillDirectoryPath
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  /**
   * 写入 env.json 内容。
   *
   * @param content - 待写入的 JSON 文本。
   * @returns 写入完成。
   * @throws 文件系统错误时抛出。
   */
  async function writeEnv (content: string): Promise<void> {
    await writeFile(join(skillRoot, SKILL_ENV_FILE_NAME), content, 'utf8')
  }

  it('解析已存在的 key 并返回值', async () => {
    await writeEnv(JSON.stringify({ E2E_PASSWORD: 'S3cr3t' }))
    const resolver = createSkillCredentialResolver({ rootDir, skillId })

    expect(await resolver.resolve('E2E_PASSWORD')).toEqual({
      ok: true,
      value: 'S3cr3t',
    })
  })

  it('key 不存在时返回 not-found，且不回带任何值', async () => {
    await writeEnv(JSON.stringify({ OTHER: 'x' }))
    const resolver = createSkillCredentialResolver({ rootDir, skillId })

    const result = await resolver.resolve('MISSING')

    expect(result).toEqual({ ok: false, reason: 'not-found' })
    // 失败结果里不得出现任何 env 值——它会被原样送回模型。
    expect(JSON.stringify(result)).not.toContain('x')
  })

  it('值为空串时返回 empty', async () => {
    await writeEnv(JSON.stringify({ E2E_PASSWORD: '' }))
    const resolver = createSkillCredentialResolver({ rootDir, skillId })

    expect(await resolver.resolve('E2E_PASSWORD')).toEqual({
      ok: false,
      reason: 'empty',
    })
  })

  it('env.json 格式非法时返回 unavailable', async () => {
    await writeEnv('{ 这不是合法 JSON')
    const resolver = createSkillCredentialResolver({ rootDir, skillId })

    expect(await resolver.resolve('E2E_PASSWORD')).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('env.json 缺失时返回 unavailable', async () => {
    await rm(join(skillRoot, SKILL_ENV_FILE_NAME), { force: true })
    const resolver = createSkillCredentialResolver({ rootDir, skillId })

    expect(await resolver.resolve('E2E_PASSWORD')).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('每次调用重新读盘：补写值后立即可解析', async () => {
    await writeEnv('{}')
    const resolver = createSkillCredentialResolver({ rootDir, skillId })

    // 首次：key 不存在。
    expect(await resolver.resolve('LATE')).toEqual({
      ok: false,
      reason: 'not-found',
    })

    // 用户在生成任务进行中补上了值——缓存会让这里仍报 not-found，
    // 那对用户是难以解释的现象（「我明明填了」）。
    await writeEnv(JSON.stringify({ LATE: 'now-present' }))

    expect(await resolver.resolve('LATE')).toEqual({
      ok: true,
      value: 'now-present',
    })
  })

  it('Skill 不存在时不抛异常，按不可用处理', async () => {
    const resolver = createSkillCredentialResolver({
      rootDir,
      skillId: 'zzzzzzzzz',
    })

    expect(await resolver.resolve('ANY')).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
})
