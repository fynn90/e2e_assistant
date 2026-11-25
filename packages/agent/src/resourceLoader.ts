/**
 * 静态资源加载器：统一加载系统内置的 prompt 与 skill。
 *
 * 调用方只需传入「资源类型 + 文件名」，即可自动加载对应内容，
 * 无需关心资源底层是 markdown 文件还是 TS 模块。
 * 资源内容支持 `{{ 变量名 }}` 模板占位符，加载时传入变量对象即可替换。
 *
 * 系统内置资源目录（prompt / skill）与 resourceLoader 同级，
 * 各目录的 index.ts 默认导出一个 map，resourceLoader 在初始化时自动注册这些资源，
 * 无需手工维护注册表。
 */

import type {
  LoadedResource,
  PromptEntry,
  ResourceType,
  ResourceRegistry,
  SkillEntry,
  SystemPrompt,
  SystemSkill,
} from './resources/types'
import { SKILL_DIR } from './resources/types'
import { buildResourceRegistry } from './resources/registry'
import { parseFrontmatter } from './resources/frontmatter'
import { renderTemplate, type TemplateVariables } from './resources/template'
import { ResourceNotFoundError, ResourceParseError } from './resources/errors'

// 自动注册系统内置资源：prompt / skill 目录 index.ts 默认导出的 map
import promptMap from './prompt'
import skillMap from './skills'

/** 系统内置资源注册表：由 prompt / skill 目录的 index.ts 自动构建 */
export const systemRegistry = buildResourceRegistry(promptMap, skillMap)

/**
 * 资源加载器。
 *
 * 通过固定的注册表（默认自动注册的系统内置清单）按类型与文件名解析资源，
 * 并缓存解析结果。支持：
 *   - prompt：markdown 或 TS 模块；
 *   - skill： markdown（带 frontmatter）或 TS 模块。
 * 内容中的 `{{ 变量名 }}` 占位符可在加载时通过变量对象替换。
 */
export class ResourceLoader {
  /** 底层资源注册表 */
  private readonly registry: ResourceRegistry
  /** 解析结果缓存，键为 `type:name` */
  private readonly cache = new Map<string, SystemPrompt | SystemSkill>()

  /**
   * @param registry - 资源注册表，缺省使用系统内置清单
   */
  constructor(registry: ResourceRegistry = systemRegistry) {
    this.registry = registry
  }

  /**
   * 按资源类型与文件名加载资源。
   *
   * @param type - 资源类型：'prompt' | 'skill'
   * @param name - 资源文件名（可带 .md / .ts 扩展名，会自动去掉）
   * @param variables - 可选的模板变量，用于替换内容中的 `{{ 变量名 }}` 占位符
   * @returns 加载完成的资源对象（prompt -> SystemPrompt，skill -> SystemSkill）
   * @throws {ResourceNotFoundError} 资源不存在
   * @throws {ResourceParseError} 资源内容解析失败
   */
  load<T extends ResourceType>(
    type: T,
    name: string,
    variables?: TemplateVariables,
  ): LoadedResource<T> {
    const key = buildCacheKey(type, name)
    let resource = this.cache.get(key) as LoadedResource<T> | undefined

    // 缓存未命中时解析并放入缓存（缓存保存未渲染的原始模板）
    if (!resource) {
      resource =
        type === 'prompt'
          ? (this.loadPrompt(name) as LoadedResource<T>)
          : (this.loadSkill(name) as LoadedResource<T>)
      this.cache.set(key, resource)
    }

    // 传入变量时渲染模板，返回新对象，避免污染缓存中的原始模板
    if (variables && Object.keys(variables).length > 0) {
      return this.renderResource(resource, variables)
    }
    return resource
  }

  /**
   * 判断指定资源是否存在。
   *
   * @param type - 资源类型
   * @param name - 资源文件名
   * @returns 存在返回 true，否则 false
   */
  has(type: ResourceType, name: string): boolean {
    return this.findEntry(type, name) !== undefined
  }

  /**
   * 列出指定类型的所有资源名（按名称排序）。
   *
   * @param type - 资源类型
   * @returns 资源名数组
   */
  list(type: ResourceType): string[] {
    return this.entriesOf(type)
      .map((entry) => entry.name)
      .sort()
  }

  /**
   * 快捷方法：直接获取 prompt 内容字符串。
   *
   * @param name - 资源文件名
   * @param variables - 可选的模板变量，用于替换内容中的 `{{ 变量名 }}` 占位符
   * @returns 提示词内容
   * @throws {ResourceNotFoundError} 资源不存在
   * @throws {ResourceParseError} 解析失败
   */
  getPrompt(name: string, variables?: TemplateVariables): string {
    return this.load('prompt', name, variables).content
  }

  /**
   * 快捷方法：直接获取 skill 对象。
   *
   * @param name - 资源文件名
   * @param variables - 可选的模板变量，用于替换内容中的 `{{ 变量名 }}` 占位符
   * @returns 系统技能对象
   * @throws {ResourceNotFoundError} 资源不存在
   * @throws {ResourceParseError} 解析失败
   */
  getSkill(name: string, variables?: TemplateVariables): SystemSkill {
    return this.load('skill', name, variables)
  }

  // ---------- 内部实现 ----------

  /**
   * 渲染资源内容中的模板变量，返回新对象（不修改缓存中的原始模板）。
   *
   * @param resource - 已加载的资源对象（未渲染）
   * @param variables - 模板变量映射
   * @returns 渲染后的资源对象
   * @throws 无
   */
  private renderResource<T extends ResourceType>(
    resource: LoadedResource<T>,
    variables: TemplateVariables,
  ): LoadedResource<T> {
    return {
      ...resource,
      content: renderTemplate(resource.content, variables),
    } as LoadedResource<T>
  }

  /**
   * 加载 prompt。
   *
   * @param name - 资源文件名
   * @returns 系统提示词
   * @throws {ResourceNotFoundError} 资源不存在
   */
  private loadPrompt(name: string): SystemPrompt {
    const entry = this.findEntry('prompt', name)
    if (!entry) {
      this.throwNotFound('prompt', name)
    }
    return entry.format === 'md'
      ? this.promptFromMarkdown(entry)
      : this.promptFromModule(entry)
  }

  /**
   * 加载 skill。
   *
   * @param name - 资源文件名
   * @returns 系统技能
   * @throws {ResourceNotFoundError} 资源不存在
   * @throws {ResourceParseError} frontmatter / 模块导出非法
   */
  private loadSkill(name: string): SystemSkill {
    const entry = this.findEntry('skill', name)
    if (!entry) {
      this.throwNotFound('skill', name)
    }
    return entry.format === 'md'
      ? this.skillFromMarkdown(entry)
      : this.skillFromModule(entry)
  }

  /** 从 markdown 原始文本构建 prompt；存在 frontmatter 时剥离元信息，正文作为内容 */
  private promptFromMarkdown(
    entry: Extract<PromptEntry, { format: 'md' }>,
  ): SystemPrompt {
    const parsed = parseFrontmatter(entry.raw)
    const content = parsed ? parsed.body : entry.raw
    const description =
      parsed && typeof parsed.metadata.description === 'string'
        ? parsed.metadata.description
        : undefined
    return { name: entry.name, content, description, format: 'md' }
  }

  /** 从 TS 模块导出构建 prompt（字符串或 { content, description }） */
  private promptFromModule(
    entry: Extract<PromptEntry, { format: 'ts' }>,
  ): SystemPrompt {
    const data = entry.data
    if (typeof data === 'string') {
      return { name: entry.name, content: data, format: 'ts' }
    }
    return {
      name: entry.name,
      content: data.content,
      description: data.description,
      format: 'ts',
    }
  }

  /**
   * 从 markdown 原始文本构建 skill。
   * frontmatter 必须提供非空的 description；name 缺省时取文件名。
   */
  private skillFromMarkdown(
    entry: Extract<SkillEntry, { format: 'md' }>,
  ): SystemSkill {
    const parsed = parseFrontmatter(entry.raw)
    if (!parsed) {
      throw new ResourceParseError(
        'skill',
        entry.name,
        '缺少 frontmatter，需提供 description 字段',
      )
    }

    const description =
      typeof parsed.metadata.description === 'string'
        ? parsed.metadata.description
        : ''
    if (!description.trim()) {
      throw new ResourceParseError(
        'skill',
        entry.name,
        'frontmatter 缺少非空的 description 字段',
      )
    }

    const name =
      typeof parsed.metadata.name === 'string'
        ? parsed.metadata.name
        : entry.name
    return {
      name,
      description,
      content: parsed.body,
      filePath: `${SKILL_DIR}/${name}.md`,
      disableModelInvocation:
        parsed.metadata['disable-model-invocation'] === true,
      format: 'md',
    }
  }

  /** 从 TS 模块导出构建 skill（name 缺省时取文件名） */
  private skillFromModule(
    entry: Extract<SkillEntry, { format: 'ts' }>,
  ): SystemSkill {
    const data = entry.data
    if (!data.description.trim()) {
      throw new ResourceParseError('skill', entry.name, 'description 不能为空')
    }
    const name = data.name ?? entry.name
    return {
      name,
      description: data.description,
      content: data.content,
      filePath: `${SKILL_DIR}/${name}.ts`,
      disableModelInvocation: data.disableModelInvocation,
      format: 'ts',
    }
  }

  /** 按类型返回注册表中的条目列表 */
  private entriesOf(type: ResourceType): PromptEntry[] | SkillEntry[] {
    return type === 'prompt' ? this.registry.prompts : this.registry.skills
  }

  /** 按规范化后的文件名查找条目；未找到返回 undefined */
  private findEntry<T extends ResourceType>(
    type: T,
    name: string,
  ): (T extends 'prompt' ? PromptEntry : SkillEntry) | undefined {
    const normalized = normalizeResourceName(name)
    return (
      this.entriesOf(type) as ReadonlyArray<PromptEntry | SkillEntry>
    ).find((entry) => entry.name === normalized) as
      (T extends 'prompt' ? PromptEntry : SkillEntry) | undefined
  }

  /** 抛出资源不存在的错误（返回 never 便于类型收窄） */
  private throwNotFound(type: ResourceType, name: string): never {
    throw new ResourceNotFoundError(type, name, this.list(type))
  }
}

/** 全局唯一的资源加载器实例，使用系统内置清单 */
export const resourceLoader = new ResourceLoader()

/** 生成缓存键：`type:name` */
function buildCacheKey(type: ResourceType, name: string): string {
  return `${type}:${normalizeResourceName(name)}`
}

/** 规范化资源名：去掉首尾空白与 .md / .ts 扩展名 */
function normalizeResourceName(name: string): string {
  return name.trim().replace(/\.(md|ts)$/i, '')
}

// 类型再导出，方便调用方使用
export type {
  LoadedResource,
  PromptEntry,
  PromptTsModule,
  ResourceFormat,
  ResourceType,
  ResourceRegistry,
  SkillEntry,
  SkillTsModule,
  SystemPrompt,
  SystemSkill,
} from './resources/types'
export { buildResourceRegistry } from './resources/registry'
export { renderTemplate, type TemplateVariables } from './resources/template'
export {
  ResourceError,
  ResourceNotFoundError,
  ResourceParseError,
} from './resources/errors'
