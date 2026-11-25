/**
 * page-snapshot 的单元测试：用替身 Page 精确控制脱敏前后的长度关系。
 *
 * 为什么需要替身而非真实浏览器：`truncated` 的判据缺陷只在「脱敏改变了长度」
 * 时才会显现——脱敏器会把秘密值替换为 `[REDACTED]`、把绝对路径替换为 `[PATH]`，
 * 两者都会让脱敏后的文本**变短**。真实页面上很难稳定构造出「脱敏前超限、
 * 脱敏后不超限」的场景，而替身可以直接给定输入。
 */

import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { createPageSnapshot } from '../src/browser-session/page-snapshot'
import type { ISensitiveDataRedactor } from '../src/contracts/observability'

/**
 * 构造一个只提供快照所需能力的 Page 替身。
 *
 * @param a11yText - `body` 元素的 ariaSnapshot 返回值。
 * @returns 满足 createPageSnapshot 调用面的最小 Page 替身。
 * @throws 不抛出异常。
 */
function createStubPage(a11yText: string): Page {
  const bodyLocator = {
    ariaSnapshot: async () => a11yText,
  }
  const candidateLocator = {
    count: async () => 0,
    evaluateAll: async () => [],
  }

  return {
    locator: (selector: string) =>
      selector === 'body' ? bodyLocator : candidateLocator,
    url: () => 'http://127.0.0.1:1/fixture',
    title: async () => 'Fixture',
  } as unknown as Page
}

/**
 * 构造一个把超长秘密替换为固定短文本的脱敏器替身。
 *
 * 用它替代 createDefaultRedactor，是为了让「脱敏后长度」可以精确推导，
 * 不依赖脱敏器内部的正则细节。
 *
 * @param secret - 待替换的长文本。
 * @param replacement - 替换后的短文本。
 * @returns 只做单向替换、不做长度截断的脱敏器。
 * @throws 不抛出异常。
 */
function createShrinkingRedactor(
  secret: string,
  replacement: string,
): ISensitiveDataRedactor {
  return {
    redact: (value: string) => value.split(secret).join(replacement),
  }
}

describe('createPageSnapshot truncated 判据', () => {
  it('脱敏后长度未超限时不标记截断，且不追加截断尾巴', async () => {
    // 构造：脱敏前 5_000 字符 > 上限 1_000；脱敏后仅 ~100 字符 < 上限。
    // 这正是判据不一致会出错的场景：按脱敏前长度判定会误报 truncated=true，
    // 但实际输出既没被切片、也没有截断标记。
    const secret = 'S'.repeat(5_000)
    const page = createStubPage(`- main:\n  - text: ${secret}`)

    const snapshot = await createPageSnapshot(page, {
      maxA11yLength: 1_000,
      maxLocators: 20,
      redactor: createShrinkingRedactor(secret, '[REDACTED]'),
    })

    expect(snapshot.a11yTree.length).toBeLessThanOrEqual(1_000)
    // 关键断言：判据与实际切片同源，不虚报截断。
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.a11yTree).not.toContain('[内容已截断]')
  })

  it('脱敏后长度仍超限时标记截断，且以截断尾巴结尾', async () => {
    // 构造：脱敏后 5_000 字符仍 > 上限 1_000，两个判据此时应一致为 true。
    const page = createStubPage(`- main:\n  - text: ${'x'.repeat(5_000)}`)

    const snapshot = await createPageSnapshot(page, {
      maxA11yLength: 1_000,
      maxLocators: 20,
      redactor: createShrinkingRedactor('不存在的秘密', '[REDACTED]'),
    })

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.a11yTree.endsWith('[内容已截断]')).toBe(true)
    // 截断后长度 = 上限 + 尾巴，不会是整段原文。
    expect(snapshot.a11yTree.length).toBeLessThan(5_000)
  })

  it('默认快照上限远高于脱敏器的默认上限', async () => {
    // 回归护栏：默认快照上限一旦被调回 24_000 以下或脱敏器默认值（8_192）重新生效，
    // Agent 拿到的快照就会被静默截断到 8KB。
    const page = createStubPage(`- main:\n  - text: ${'y'.repeat(30_000)}`)

    const snapshot = await createPageSnapshot(page, { maxLocators: 20 })

    expect(snapshot.truncated).toBe(false)
    expect(snapshot.a11yTree.length).toBeGreaterThan(20_000)
  })
})
