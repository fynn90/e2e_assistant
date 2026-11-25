/**
 * 资源加载器单元测试。
 *
 * 使用注入的 fixture 注册表覆盖 markdown / TS 两种来源的 prompt 与 skill 加载、
 * 模板变量渲染、错误处理、缓存、名称规范化等行为；
 * 最后用默认单例验证真实系统资源可加载。
 */

import { describe, expect, it } from 'vitest'
import {
  ResourceLoader,
  resourceLoader,
  systemRegistry,
  buildResourceRegistry,
  ResourceNotFoundError,
  ResourceParseError,
} from '../src/resourceLoader'
import type { ResourceRegistry } from '../src/resources/types'
import { parseFrontmatter } from '../src/resources/frontmatter'
import { renderTemplate } from '../src/resources/template'

/** fixture 注册表：覆盖 md / ts 两种来源，以及带 frontmatter 的场景 */
const fixtureRegistry: ResourceRegistry = {
  prompts: [
    // 无 frontmatter 的 markdown 提示词
    {
      format: 'md',
      name: 'md-prompt',
      raw: '# 你好\n\n这是 markdown 提示词。',
    },
    // 带 frontmatter 的 markdown 提示词
    {
      format: 'md',
      name: 'meta-prompt',
      raw: '---\ndescription: 带元数据的提示词\n---\n正文内容',
    },
    // TS 模块对象形式
    {
      format: 'ts',
      name: 'ts-prompt',
      data: { content: 'TS 模块提示词', description: '来自 ts' },
    },
    // TS 模块字符串形式
    { format: 'ts', name: 'ts-string-prompt', data: '纯字符串 TS 提示词' },
    // 带模板变量的 markdown 提示词（用于验证变量渲染）
    {
      format: 'md',
      name: 'template-prompt',
      raw: '你好 {{ name }}，请执行 {{ step }} 次，开关为 {{ flag }}。缺失: {{ missing }}',
    },
  ],
  skills: [
    {
      format: 'md',
      name: 'md-skill',
      raw: '---\ndescription: 使用 markdown 书写的技能\n---\n技能正文',
    },
    {
      format: 'md',
      name: 'renamed-skill',
      raw: '---\nname: renamed-by-frontmatter\ndescription: 通过 frontmatter 指定技能名\n---\n正文',
    },
    {
      format: 'ts',
      name: 'ts-skill',
      data: {
        name: 'ts-skill',
        description: '使用 TS 书写的技能',
        content: 'TS 技能正文',
      },
    },
    // 缺少 description 的 markdown skill（用于验证解析错误）
    { format: 'md', name: 'broken-skill', raw: '---\nname: broken\n---\n正文' },
    // 带模板变量的 markdown skill（用于验证变量渲染）
    {
      format: 'md',
      name: 'template-skill',
      raw: '---\ndescription: 带变量的技能\n---\n执行 {{ step }} 操作，目标 {{ target }}',
    },
  ],
}

describe('parseFrontmatter', () => {
  it('无 frontmatter 的文本返回 null', () => {
    expect(parseFrontmatter('# 纯文本')).toBeNull()
  })

  it('解析出元数据与正文', () => {
    const parsed = parseFrontmatter(
      '---\ndescription: 你好\nflag: true\n---\n\n正文',
    )
    expect(parsed).toEqual({
      metadata: { description: '你好', flag: true },
      body: '正文',
    })
  })
})

describe('renderTemplate', () => {
  it('替换 `{{ 变量名 }}` 占位符（支持空格 / 无空格写法）', () => {
    expect(
      renderTemplate('a={{name}} b={{ name }} c={{ name }}', { name: 'x' }),
    ).toBe('a=x b=x c=x')
  })

  it('数字与布尔值转为字符串', () => {
    expect(renderTemplate('n={{n}} f={{f}}', { n: 3, f: true })).toBe(
      'n=3 f=true',
    )
  })

  it('未提供值的占位符原样保留', () => {
    expect(
      renderTemplate('有 {{ present }}，缺 {{ absent }}', { present: '值' }),
    ).toBe('有 值，缺 {{ absent }}')
  })
})

describe('ResourceLoader', () => {
  const loader = new ResourceLoader(fixtureRegistry)

  it('加载 markdown prompt（无 frontmatter）：正文即内容', () => {
    const prompt = loader.load('prompt', 'md-prompt')
    expect(prompt).toEqual({
      name: 'md-prompt',
      content: '# 你好\n\n这是 markdown 提示词。',
      format: 'md',
    })
  })

  it('加载 markdown prompt（带 frontmatter）：剥离元信息', () => {
    const prompt = loader.load('prompt', 'meta-prompt')
    expect(prompt.content).toBe('正文内容')
    expect(prompt.description).toBe('带元数据的提示词')
    expect(prompt.format).toBe('md')
  })

  it('加载 TS prompt（对象形式）', () => {
    const prompt = loader.load('prompt', 'ts-prompt')
    expect(prompt.content).toBe('TS 模块提示词')
    expect(prompt.description).toBe('来自 ts')
    expect(prompt.format).toBe('ts')
  })

  it('加载 TS prompt（字符串形式）', () => {
    expect(loader.load('prompt', 'ts-string-prompt').content).toBe(
      '纯字符串 TS 提示词',
    )
  })

  it('加载 markdown skill：name 取文件名，content 取正文', () => {
    const skill = loader.getSkill('md-skill')
    expect(skill).toMatchObject({
      name: 'md-skill',
      description: '使用 markdown 书写的技能',
      content: '技能正文',
      filePath: 'src/skills/md-skill.md',
      format: 'md',
    })
  })

  it('markdown skill 的 name 可由 frontmatter 覆盖', () => {
    const skill = loader.getSkill('renamed-skill')
    expect(skill.name).toBe('renamed-by-frontmatter')
    expect(skill.filePath).toBe('src/skills/renamed-by-frontmatter.md')
  })

  it('加载 TS skill', () => {
    const skill = loader.getSkill('ts-skill')
    expect(skill).toMatchObject({
      name: 'ts-skill',
      description: '使用 TS 书写的技能',
      content: 'TS 技能正文',
      filePath: 'src/skills/ts-skill.ts',
      format: 'ts',
    })
  })

  it('has / list 返回正确结果', () => {
    expect(loader.has('prompt', 'md-prompt')).toBe(true)
    expect(loader.has('prompt', 'missing')).toBe(false)
    expect(loader.has('skill', 'md-skill')).toBe(true)
    expect(loader.list('prompt')).toEqual([
      'md-prompt',
      'meta-prompt',
      'template-prompt',
      'ts-prompt',
      'ts-string-prompt',
    ])
  })

  it('文件名支持带扩展名', () => {
    expect(loader.load('prompt', 'md-prompt.md').name).toBe('md-prompt')
    expect(loader.load('skill', 'md-skill.md').name).toBe('md-skill')
  })

  it('加载结果被缓存（同一对象引用）', () => {
    expect(loader.load('prompt', 'md-prompt')).toBe(
      loader.load('prompt', 'md-prompt'),
    )
  })

  it('资源不存在时抛出 ResourceNotFoundError 并携带可用清单', () => {
    expect(() => loader.load('prompt', 'nope')).toThrow(ResourceNotFoundError)
    expect(() => loader.load('prompt', 'nope')).toThrow(/nope/)
    expect(() => loader.load('prompt', 'nope')).toThrow(/md-prompt/)
    expect(() => loader.load('skill', 'nope')).toThrow(ResourceNotFoundError)
  })

  it('skill 缺少 description 时抛出 ResourceParseError', () => {
    expect(() => loader.getSkill('broken-skill')).toThrow(ResourceParseError)
  })

  it('getPrompt 传入变量时替换模板占位符', () => {
    const content = loader.getPrompt('template-prompt', {
      name: '张三',
      step: 3,
      flag: true,
    })
    expect(content).toBe(
      '你好 张三，请执行 3 次，开关为 true。缺失: {{ missing }}',
    )
  })

  it('load 传入变量时返回渲染后的资源对象（不修改缓存）', () => {
    const rendered = loader.load('prompt', 'template-prompt', { step: 9 })
    expect(rendered.content).toBe(
      '你好 {{ name }}，请执行 9 次，开关为 {{ flag }}。缺失: {{ missing }}',
    )

    // 未传入变量的加载结果应保持原始模板，且与渲染结果不是同一对象
    const plain = loader.load('prompt', 'template-prompt')
    expect(plain.content).toBe(loader.getPrompt('template-prompt'))
    expect(plain).not.toBe(rendered)
  })

  it('getSkill 传入变量时渲染技能内容', () => {
    const skill = loader.getSkill('template-skill', {
      step: '登录',
      target: '首页',
    })
    expect(skill.content).toBe('执行 登录 操作，目标 首页')
    // 元信息不受渲染影响
    expect(skill.description).toBe('带变量的技能')
  })

  it('空变量对象不改变内容（直接返回缓存的原始对象）', () => {
    expect(loader.load('prompt', 'template-prompt', {})).toBe(
      loader.load('prompt', 'template-prompt'),
    )
  })
})

describe('buildResourceRegistry', () => {
  it('把 map 转换为注册表条目（string -> md，对象 -> ts）', () => {
    const registry = buildResourceRegistry(
      { a: 'markdown内容', b: { content: 'ts内容', description: 'd' } },
      {
        s: '---\ndescription: d\n---\n正文',
        t: { description: 'd', content: 'c' },
      },
    )
    expect(registry.prompts).toEqual([
      { format: 'md', name: 'a', raw: 'markdown内容' },
      {
        format: 'ts',
        name: 'b',
        data: { content: 'ts内容', description: 'd' },
      },
    ])
    expect(registry.skills).toEqual([
      { format: 'md', name: 's', raw: '---\ndescription: d\n---\n正文' },
      { format: 'ts', name: 't', data: { description: 'd', content: 'c' } },
    ])
  })
})

describe('默认单例 resourceLoader', () => {
  // 系统 prompt 在 src/prompt/index.ts 中以 authineE2E-agent（文件名）为 key 注册
  it('可加载真实系统 prompt 资源', () => {
    expect(typeof resourceLoader.getPrompt('authineE2E-agent')).toBe('string')
    expect(resourceLoader.has('prompt', 'authineE2E-agent')).toBe(true)
  })

  it('自动注册 prompt/skill 目录 index.ts 的 map', () => {
    // systemRegistry 由 prompt / skill 目录的 index.ts 默认导出构建。
    // v16 新增 workbench 区块（/agent 工作台规则，按会话能力注入）。
    // v17 新增 workbench-threshold（P 组信息充分性门槛）与 workbench-capabilities
    // （能力清单：**由 TS 模块派生**，与能力卡共用同一常量，故在此也列为 prompt）。
    expect(systemRegistry.prompts.map((entry) => entry.name)).toEqual([
      'authineE2E-agent',
      'workbench',
      'workbench-threshold',
      'workbench-capabilities',
    ])
    expect(systemRegistry.prompts[0]?.format).toBe('md')
    expect(resourceLoader.list('prompt')).toContain('authineE2E-agent')
    // list 返回按名称排序的已注册技能；v7 新增 playwright_script_generation
    // （根据用例、SKILL.md 与页面真实元素生成 Playwright 脚本的专用技能）。
    // v16：test_script_execution 随 execute_test 与检索工具一同接线到 /agent 工作台。
    expect(resourceLoader.list('skill')).toEqual([
      'e2e_test_case',
      'playwright_script_generation',
      'test_case_Skill_document',
      'test_script_execution',
    ])

    const skill = resourceLoader.getSkill('e2e_test_case')
    expect(skill).toMatchObject({
      name: 'e2e_test_case',
      filePath: 'src/skills/e2e_test_case.md',
      format: 'md',
    })

    const skillDocument = resourceLoader.getSkill('test_case_Skill_document')
    expect(skillDocument).toMatchObject({
      name: 'test_case_Skill_document',
      filePath: 'src/skills/test_case_Skill_document.md',
      format: 'md',
    })
    expect(skillDocument.content).toContain('根据结构化 `test_case` 数据')
  })

  // CLI 只表达业务意图、不点名 Skill，因此 description 成为模型选择技能的唯一路由信号。
  // 以下断言锁住三者的职责边界，避免后续改动让路由信号重新变得不可区分。
  it('技能 description 承载可区分的路由信号', () => {
    const scriptGeneration = resourceLoader.getSkill(
      'playwright_script_generation',
    )
    // 覆盖 CLI 新提示词的词面：SKILL.md、e2e_schema.json、test.spec.ts。
    expect(scriptGeneration.description).toContain('SKILL.md')
    expect(scriptGeneration.description).toContain('e2e_schema.json')
    expect(scriptGeneration.description).toContain('test.spec.ts')
    // 生成前必须核对页面：description 常驻系统提示词，是未加载 Skill 时的唯一兜底。
    expect(scriptGeneration.description).toContain('核对目标页面')

    // SKILL.md 生成与脚本生成的句式高度同构，必须各自声明排除边界。
    const skillDocument = resourceLoader.getSkill('test_case_Skill_document')
    expect(skillDocument.description).toContain('不产出 Playwright 脚本')

    // e2e_test_case 是列表中的通用方法论技能，需声明自己不属于自动化生成流程。
    const genericSkill = resourceLoader.getSkill('e2e_test_case')
    expect(genericSkill.description).toContain('不参与平台的自动化生成流程')
  })

  it('Playwright 脚本生成 Skill 由 Agent 按需加载，而非由客户端点名工具', () => {
    const scriptGeneration = resourceLoader.getSkill(
      'playwright_script_generation',
    )

    // 加载哪个 Skill 属于 Agent 侧判断：正文不应回退成"客户端要求你调用 load_skill"。
    expect(scriptGeneration.content).not.toContain('要求你先调用 `load_skill`')
    // 被下沉的规则必须真正落到 Skill 正文里，否则等于删除约束。
    expect(scriptGeneration.content).toContain('核对目标页面')
    expect(scriptGeneration.content).toContain('候选脚本写入路径')
  })
})
