/**
 * 资源加载器的核心类型定义与固定目录常量。
 *
 * 这里把 `.md` 文件与 `.ts` 模块两种不同的资源来源，统一成调用方可直接消费的形态，
 * 让调用方只需关注「类型 + 文件名」，无需关心资源底层以何种形式存储。
 * prompt / skill 目录与 resourceLoader 同级，各目录的 index.ts 默认导出一个 map，
 * 由 resourceLoader 自动注册为系统内置资源。
 */

/** 系统内置 skill 的固定目录（相对包根目录） */
export const SKILL_DIR = 'src/skills' as const

/** 资源类型：prompt（系统提示词）或 skill（系统技能） */
export type ResourceType = 'prompt' | 'skill'

/** 资源来源格式：markdown 文件或 TS 模块 */
export type ResourceFormat = 'md' | 'ts'

/** 加载完成的系统提示词 */
export interface SystemPrompt {
  /** 资源文件名（不含扩展名），如 'authineE2E-agent' */
  name: string
  /** 完整的提示词内容，可直接作为 system prompt 发送给模型 */
  content: string
  /** 可选的资源说明（来自 frontmatter 或 TS 模块） */
  description?: string
  /** 来源格式 */
  format: ResourceFormat
}

/**
 * 加载完成的系统技能。
 * 字段结构与 pi-agent-core 的 Skill 兼容，可直接用于
 * formatSkillInvocation / formatSkillsForSystemPrompt。
 */
export interface SystemSkill {
  /** 技能名，用于查找与模型可见的技能列表 */
  name: string
  /** 技能用途的简短描述（模型据此判断何时调用） */
  description: string
  /** 完整技能指令 */
  content: string
  /** 虚拟文件路径，用于模型可见位置与相对引用解析 */
  filePath: string
  /** 为 true 时不出现在模型可见的技能列表中，但仍可显式调用 */
  disableModelInvocation?: boolean
  /** 来源格式 */
  format: ResourceFormat
}

/** prompt 的 TS 模块对象形态（内容 + 可选说明） */
export interface PromptTsObject {
  content: string
  description?: string
}

/** .ts 形式 prompt 模块的默认导出契约：直接字符串，或带元数据的对象 */
export type PromptTsModule = string | PromptTsObject

/** prompt 目录 index.ts 默认导出的 map：文件名 -> 内容（string 为 markdown 原文，对象为 TS 模块） */
export type PromptMap = Record<string, string | PromptTsObject>

/** .ts 形式 skill 模块的默认导出契约：结构化对象（name 缺省时取文件名） */
export interface SkillTsModule {
  /** 技能名，缺省时使用文件名 */
  name?: string
  /** 技能用途描述，必填 */
  description: string
  /** 完整技能指令 */
  content: string
  /** 为 true 时不出现在模型可见列表中 */
  disableModelInvocation?: boolean
}

/** skill 目录 index.ts 默认导出的 map：文件名 -> 内容（string 为 markdown 原文，对象为 TS 模块） */
export type SkillMap = Record<string, string | SkillTsModule>

/** 注册表条目：prompt（markdown 或 TS 来源） */
export type PromptEntry =
  | { format: 'md'; name: string; raw: string }
  | { format: 'ts'; name: string; data: PromptTsModule }

/** 注册表条目：skill（markdown 或 TS 来源） */
export type SkillEntry =
  | { format: 'md'; name: string; raw: string }
  | { format: 'ts'; name: string; data: SkillTsModule }

/** 资源注册表：系统固定目录的静态清单 */
export interface ResourceRegistry {
  /** prompt 条目列表 */
  prompts: PromptEntry[]
  /** skill 条目列表 */
  skills: SkillEntry[]
}

/** 按资源类型取对应的注册表条目类型 */
export type RegistryEntryOf<T extends ResourceType> = T extends 'prompt'
  ? PromptEntry
  : SkillEntry

/** load 的返回值：按资源类型区分（prompt -> SystemPrompt，skill -> SystemSkill） */
export type LoadedResource<T extends ResourceType> = T extends 'prompt'
  ? SystemPrompt
  : SystemSkill
