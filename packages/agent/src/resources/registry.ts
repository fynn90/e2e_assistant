/**
 * 注册表构建工具：把 prompt / skill 目录 index.ts 默认导出的 map 转换为 ResourceLoader 的注册表。
 *
 * map 的 value 约定：
 *   - string：资源为 markdown 文件，value 即文件原始文本（由 `?raw` 导入）；
 *   - 对象：  资源为 TS 模块，value 即模块导出的结构化数据（PromptTsObject / SkillTsModule）。
 * 由 resourceLoader 自动调用，无需手工登记每个资源。
 */

import type {
  PromptEntry,
  PromptMap,
  ResourceRegistry,
  SkillEntry,
  SkillMap,
} from './types'

/**
 * 从 prompt / skill 的 map 构建注册表。
 *
 * @param prompts - prompt 目录 index.ts 默认导出的 map
 * @param skills - skill 目录 index.ts 默认导出的 map
 * @returns 可供 ResourceLoader 使用的注册表（值类型自动推断为 md / ts）
 * @throws 无
 */
export function buildResourceRegistry(
  prompts: PromptMap,
  skills: SkillMap,
): ResourceRegistry {
  return {
    prompts: Object.entries(prompts).map(([name, value]): PromptEntry =>
      typeof value === 'string'
        ? { format: 'md', name, raw: value }
        : { format: 'ts', name, data: value },
    ),
    skills: Object.entries(skills).map(([name, value]): SkillEntry =>
      typeof value === 'string'
        ? { format: 'md', name, raw: value }
        : { format: 'ts', name, data: value },
    ),
  }
}
