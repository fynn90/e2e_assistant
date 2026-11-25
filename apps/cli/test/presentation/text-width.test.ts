/**
 * 终端宽度计算的测试。
 *
 * 这些用例是**面板边框不错位的唯一保障**：宽度算错一处，卡片右侧就会呈锯齿状。
 * 用例中的期望值以 `@earendil-works/pi-tui` 的 `visibleWidth` 逐例校准过
 * （含 ZWJ 家庭 emoji、国旗、肤色修饰、键帽、VS16、ANSI），因此这里锁定的是
 * 与成熟实现一致的语义，而不是本实现的自说自话。
 */
import { describe, expect, it } from 'vitest'
import {
  measureTextWidth,
  padToWidth,
  truncateToWidth,
  wrapTextToWidth,
} from '../../src/presentation/console/text-width'

const ESC = String.fromCharCode(27)
const VS16 = String.fromCharCode(0xfe0f)
const CJK = '\u4e2d\u6587'

describe('measureTextWidth', () => {
  it('拉丁字母与半角符号占一列', () => {
    expect(measureTextWidth('hello world')).toBe(11)
    expect(measureTextWidth('')).toBe(0)
    expect(measureTextWidth('http://127.0.0.1:5826')).toBe(21)
  })

  it('中文与全角标点占两列', () => {
    expect(measureTextWidth(CJK)).toBe(4)
    expect(measureTextWidth(`abc${CJK}`)).toBe(7)
    // 全角冒号是双宽，半角冒号不是——面板标签里的「：」务必不要用错。
    expect(measureTextWidth('：')).toBe(2)
    expect(measureTextWidth(':')).toBe(1)
  })

  it('边框字符占一列', () => {
    // 圆角与直线边框若算成双宽，整张卡片右边框会逐行右移。
    for (const glyph of ['─', '│', '╭', '╮', '╰', '╯', '▶', '·']) {
      expect(measureTextWidth(glyph)).toBe(1)
    }
  })

  it('默认双宽的 emoji 占两列', () => {
    for (const glyph of [
      '🚀',
      '🤖',
      '🟢',
      '🔄',
      '🕒',
      '✨',
      '📜',
      '🔗',
      '🔌',
      '👀',
      '🛑',
      '✅',
    ]) {
      expect(measureTextWidth(glyph)).toBe(2)
    }
  })

  it('单宽的几何符号不会被误判为双宽', () => {
    // 这些字符带 Extended_Pictographic 属性却只占一列——按属性判宽会算错，
    // 这正是本实现改用 Emoji_Presentation + 显式区间的理由。
    expect(measureTextWidth('♻')).toBe(1)
    expect(measureTextWidth('⚠')).toBe(1)
    expect(measureTextWidth('✓')).toBe(1)
    expect(measureTextWidth('✗')).toBe(1)
  })

  it('带变体选择符 16 的字素簇按 emoji 呈现，占两列', () => {
    // ♻️ / ⚠️ 由「基字符 + VS16」两码元组成，可见宽度是 2 而非 1 或 0。
    expect(measureTextWidth(`♻${VS16}`)).toBe(2)
    expect(measureTextWidth(`⚠${VS16}`)).toBe(2)
  })

  it('组合符不占宽度', () => {
    expect(measureTextWidth('e\u0301')).toBe(1)
    expect(measureTextWidth('e\u0301\u0302')).toBe(1)
  })

  it('ZWJ 序列、国旗与肤色修饰符按一个整体计宽', () => {
    expect(
      measureTextWidth(
        '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}',
      ),
    ).toBe(2)
    expect(measureTextWidth('\u{1f1e8}\u{1f1f3}')).toBe(2)
    expect(measureTextWidth('\u{1f44d}\u{1f3fd}')).toBe(2)
    expect(measureTextWidth(`1${VS16}\u20e3`)).toBe(2)
  })

  it('忽略 ANSI 转义序列', () => {
    expect(measureTextWidth(`${ESC}[32mgreen${ESC}[39m`)).toBe(5)
    expect(
      measureTextWidth(`${ESC}[1m${ESC}[32mbold${ESC}[39m${ESC}[22m`),
    ).toBe(4)
  })

  it('Windows 路径按实际列数计算', () => {
    const windowsLogPath =
      'C:\\Users\\PC\\AppData\\Roaming\\e2e_assistant\\logs\\service.log'

    expect(measureTextWidth(windowsLogPath)).toBe(54)
  })

  it('换行符不计宽（宽度由调用方按行处理）', () => {
    expect(measureTextWidth('a\nb')).toBe(2)
  })

  it('制表符按 3 列计算', () => {
    expect(measureTextWidth('\t')).toBe(3)
  })
})

describe('truncateToWidth', () => {
  it('未超宽时原样返回', () => {
    expect(truncateToWidth('abc', 10)).toBe('abc')
    expect(truncateToWidth(CJK, 4)).toBe(CJK)
  })

  it('超宽时按可见宽度截断并补省略号', () => {
    const result = truncateToWidth('abcdefghij', 5)

    expect(measureTextWidth(result)).toBe(5)
    expect(result.endsWith('…')).toBe(true)
  })

  it('中文按列截断，不会截出半个字', () => {
    const result = truncateToWidth('中文测试内容', 6)

    expect(measureTextWidth(result)).toBeLessThanOrEqual(6)
    expect(result).toBe('中文…')
  })

  it('不会把 emoji 从中间截开', () => {
    const result = truncateToWidth('🚀🚀🚀🚀', 5)

    // 预算 4 列恰好容纳两个双宽 emoji，再加省略号正好占满 5 列。
    expect(measureTextWidth(result)).toBe(5)
    expect(result).toBe('🚀🚀…')
  })

  it('宽度不足以放下任何字素簇时只留省略号', () => {
    // 预算是「上限 - 省略号宽度」；放不下完整 emoji 时不应硬塞半个。
    expect(truncateToWidth('🚀🚀', 2)).toBe('…')
  })

  it('最长路径可截断到面板可用宽度', () => {
    const windowsLogPath =
      'C:\\Users\\PC\\AppData\\Roaming\\e2e_assistant\\logs\\service.log'
    const result = truncateToWidth(windowsLogPath, 40)

    expect(measureTextWidth(result)).toBe(40)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('padToWidth', () => {
  it('按可见宽度补齐，而不是按码元数', () => {
    // 中文占 4 列但有 2 个码元：按 length 补齐会少补 2 格。
    expect(measureTextWidth(padToWidth(CJK, 10))).toBe(10)
    expect(padToWidth(CJK, 10)).toBe(`${CJK}      `)
  })

  it('emoji 同样按列补齐', () => {
    expect(measureTextWidth(padToWidth('🚀', 5))).toBe(5)
  })

  it('已超宽时原样返回，不截断', () => {
    expect(padToWidth('abcdef', 3)).toBe('abcdef')
  })
})

describe('wrapTextToWidth', () => {
  it('短文本不折行', () => {
    expect(wrapTextToWidth('hello', 20)).toEqual(['hello'])
  })

  it('按可见宽度折行，中文长句不会超宽', () => {
    const lines = wrapTextToWidth('这是一句很长的中文说明文字用来测试折行', 10)

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(10)
    }
  })

  it('英文按空格断词', () => {
    const lines = wrapTextToWidth('alpha beta gamma delta', 12)

    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(12)
    }
    expect(lines.join(' ')).toBe('alpha beta gamma delta')
  })

  it('英文单词不会被从中间断开', () => {
    // 每个词都应完整出现在某一行里；被切断会留下半个词。
    const lines = wrapTextToWidth('run e2e_assistant start now', 14)

    for (const word of ['run', 'e2e_assistant', 'start', 'now']) {
      expect(lines.some((line) => line.split(' ').includes(word))).toBe(true)
    }
  })

  it('中文逐字断行，且不凭空插入空格', () => {
    // 中文词间没有空格：若按拉丁规则把整句当一个词，就会在任意位置硬切，
    // 把半句甩到下一行；若拼接时补空格，整句又会被塞满空格。
    const lines = wrapTextToWidth('端口被占用但该服务未响应健康探测', 10)

    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(10)
      expect(line).not.toContain(' ')
    }
    expect(lines.join('')).toBe('端口被占用但该服务未响应健康探测')
  })

  it('中英混排：中文逐字断，英文词保持完整', () => {
    const lines = wrapTextToWidth('请运行 e2e_assistant status 查看状态', 16)

    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(16)
    }

    // 两个英文词都必须完整地落在某一行里——被切断就无法阅读/复制了。
    for (const word of ['e2e_assistant', 'status']) {
      expect(lines.some((line) => line.split(' ').includes(word))).toBe(true)
    }

    // 中文词间无空格，不应凭空插入。
    expect(lines.join('').replace(/ /g, '')).toBe(
      '请运行e2e_assistantstatus查看状态',
    )
  })

  it('单词本身就超宽时按字素簇硬切', () => {
    const lines = wrapTextToWidth('a'.repeat(30), 10)

    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(10)
    }
    expect(lines.join('')).toBe('a'.repeat(30))
  })

  it('超宽词切段后，末段仍可与后续的词拼在同一行', () => {
    // 末段只占 4 列，后面的 "b" 还有空间——不应白白换行。
    const lines = wrapTextToWidth(`${'a'.repeat(24)} b`, 10)

    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(10)
    }
    expect(lines.at(-1)).toContain('b')
  })

  it('超宽词按字素簇切段，不切出半个中文', () => {
    const lines = wrapTextToWidth('中'.repeat(9), 7)

    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(7)
    }
    expect(lines.join('')).toBe('中'.repeat(9))
  })

  it('连续超宽词之间不会插入空行', () => {
    const lines = wrapTextToWidth(`${'x'.repeat(12)} ${'y'.repeat(12)}`, 5)

    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0)
    }
  })

  it('续行带上缩进且缩进计入宽度', () => {
    const lines = wrapTextToWidth('中文'.repeat(10), 12, { indent: '  ' })

    for (const line of lines) {
      expect(measureTextWidth(line)).toBeLessThanOrEqual(12)
      expect(line.startsWith('  ')).toBe(true)
    }
  })

  it('空文本返回单个空串而不是空数组', () => {
    expect(wrapTextToWidth('', 10)).toHaveLength(1)
  })
})
