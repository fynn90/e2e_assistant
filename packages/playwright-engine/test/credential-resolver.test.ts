/**
 * 凭据引用解析的单元测试（v20 凭据代理）。
 *
 * 本文件不启动浏览器，只覆盖「值解析」这一层的判定与失败分类。
 * 真实填入行为与不可回读性由 browser-session.test.ts 用真实 Chromium 覆盖。
 *
 * 特别地，文件内锁定了一条**跨包一致性约束**：引擎侧的引用正则必须与
 * `packages/types` 的 `isSensitiveTestDataEntry` 对同一批样本给出一致结论——
 * 两侧漂移会导致「用例里认得、引擎里不认」的静默不匹配。
 */

import { describe, expect, it, vi } from 'vitest'
import { isSensitiveTestDataEntry } from '@fynn90-e2e_assistant/types'
import { resolveFillValue } from '../src/browser-session/credential-resolver'

describe('resolveFillValue', () => {
  it('字面量原样返回并标记为非凭据', async () => {
    const result = await resolveFillValue('alice@example.test', undefined)

    expect(result).toEqual({
      ok: true,
      value: 'alice@example.test',
      isCredential: false,
    })
  })

  it('引用形态经解析端口换取真值并标记为凭据', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, value: 's3cret' }))

    const result = await resolveFillValue('${ENV:E2E_PASSWORD}', { resolve })

    expect(resolve).toHaveBeenCalledWith('E2E_PASSWORD')
    expect(result).toEqual({
      ok: true,
      value: 's3cret',
      isCredential: true,
      key: 'E2E_PASSWORD',
    })
  })

  it('未注入解析端口时引用报错，不回退为字面量', async () => {
    const result = await resolveFillValue('${ENV:E2E_PASSWORD}', undefined)

    // 关键：绝不能返回 ok=true 把引用文本填进页面——那会让错误推迟到断言阶段。
    expect(result).toEqual({
      ok: false,
      reason: 'resolver-unavailable',
      key: 'E2E_PASSWORD',
    })
  })

  it('透传解析端口的失败原因', async () => {
    const resolve = vi.fn(async () => ({
      ok: false as const,
      reason: 'not-found' as const,
    }))

    expect(await resolveFillValue('${ENV:MISSING}', { resolve })).toEqual({
      ok: false,
      reason: 'not-found',
      key: 'MISSING',
    })
  })

  it('解析端口抛错时归类为 unavailable，不泄露异常消息', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('磁盘上写着 s3cret-value')
    })

    const result = await resolveFillValue('${ENV:ANY}', { resolve })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unavailable')
      // 异常消息不得透传：它可能意外携带被解析的值。
      expect(JSON.stringify(result)).not.toContain('s3cret-value')
    }
  })

  it('解析结果为空串时归类为 empty', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, value: '' }))

    expect(await resolveFillValue('${ENV:BLANK}', { resolve })).toEqual({
      ok: false,
      reason: 'empty',
      key: 'BLANK',
    })
  })

  it('拼接形态不被识别为引用，按字面量处理', async () => {
    // 与 types 包的契约一致：只有「整个值恰为一个引用」才算凭据引用。
    const resolve = vi.fn(async () => ({ ok: true as const, value: 'x' }))

    const result = await resolveFillValue('前缀${ENV:KEY}', { resolve })

    expect(resolve).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: true,
      value: '前缀${ENV:KEY}',
      isCredential: false,
    })
  })

  it('小写 key 不被识别为引用', async () => {
    const result = await resolveFillValue('${ENV:lower_case}', undefined)

    expect(result).toEqual({
      ok: true,
      value: '${ENV:lower_case}',
      isCredential: false,
    })
  })

  it('与 types 包的敏感数据行判定对同一批样本结论一致（跨包契约）', async () => {
    const samples = [
      '${ENV:E2E_PASSWORD}',
      '${ENV:A}',
      '${ENV:_LEADING}',
      '${ENV:lower}',
      '${ENV:}',
      '前缀${ENV:KEY}',
      '${ENV:KEY}后缀',
      '普通文本',
      '',
    ]

    // 注入一个必然成功的解析端口：此时 isCredential=true 等价于「引擎认得这是引用」。
    const resolver = { resolve: async () => ({ ok: true as const, value: 'v' }) }

    for (const sample of samples) {
      const resolution = await resolveFillValue(sample, resolver)
      // 收窄联合类型：只有成功分支才带 isCredential（解析端口必然成功，
      // 失败即代表引擎未把该样本识别为引用）。
      const engineRecognized = resolution.ok && resolution.isCredential

      expect(
        engineRecognized,
        `样本「${sample}」在引擎与 types 两处的引用判定不一致`,
      ).toBe(isSensitiveTestDataEntry(sample))
    }
  })
})
