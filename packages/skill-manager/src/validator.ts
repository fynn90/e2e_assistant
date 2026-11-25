/**
 * 兼容导出 Skill manifest 持久化模型和校验器。
 * 新代码应优先从 manifest/skill-manifest 模块导入。
 */
export {
  toSkillSummary,
  validateSkillManifest,
  type IGeneratedScriptMetadata,
  type ISkillManifest,
} from './manifest/skill-manifest'
