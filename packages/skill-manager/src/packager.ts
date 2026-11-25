/**
 * Skill 打包器（导出契约，PRD v11 A7 先行立约，v14 更新）。
 *
 * **导出边界约定**：Skill 的导出/分享产物**不包含**以下目录：
 *   - `test_report/`——测试报告只是本地执行留痕，不属于正式 Skill 产物；
 *   - `temp/`——Agent 工作期间的临时工作区（候选脚本、探查截图等），任务结束即清理；
 *     探查产物 `temp/exploration/` 是它的子目录，因此已随本条一并排除。
 *
 * **包含** `userWorkSpace/`（v14 R1 已采纳）：基准图等测试产物影响后续测试的
 * 可复现性，随 Skill 导出。v14 起 Skill 根目录下的历史 `baselines/` 不再作为
 * 默认基准根（基线位于 `userWorkSpace/baselines/`，随 userWorkSpace 一并导出），
 * 根目录残留的 `baselines/` 按普通用户内容对待。
 *
 * 本期导出能力尚未实现；实装时必须在此排除上述目录（与 file-tree 的
 * IGNORED_NAMES 规则独立维护：temp 不在树中展示，test_report 正常展示但随包排除）。
 */

export interface IPackageSkillOptions {
  skillPath: string
  outputPath: string
}

export async function packageSkill(
  options: IPackageSkillOptions,
): Promise<string> {
  return options.outputPath
}
