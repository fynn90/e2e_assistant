/**
 * 系统技能注册表：默认导出一个 map，由 resourceLoader 自动注册。
 *
 * map 的 value 约定：
 *   - string：markdown 文件原文（通过 `?raw` 导入），需带 frontmatter（description 必填）；
 *   - 对象：TS 模块导出的结构化数据（SkillTsModule：{ name?, description, content }）。
 *
 * 新增 skill 只需两步：
 *   1. 在本目录下新建 `<name>.md`（或 `<name>.ts`，default 导出 SkillTsModule）；
 *   2. 在下方的 skillMap 中登记一条。
 *
 * 由主文件 + 子文件组成的 skill（内容较长、需要分区维护）放在**同名目录**下，
 * 以 `index.md` 为主文件，用 `{{> 子文件名 }}` 占位符引用同级子文件——
 * 组装在**注册期**完成（见 compose-skill.ts），因此对模型仍是一份完整连续的文本。
 */

import e2eTestCaseSkill from "./e2e_test_case.md?raw";
import testCaseSkillDocument from "./test_case_Skill_document.md?raw";
import testScriptExecutionSkill from "./test_script_execution.md?raw";
import playwrightScriptGenerationMain from "./playwright_script_generation/index.md?raw";
import playwrightScriptGenerationPageVerification from "./playwright_script_generation/page-verification.md?raw";
import playwrightScriptGenerationMultiStepFlow from "./playwright_script_generation/multi-step-flow.md?raw";
import playwrightScriptGenerationVisualRegression from "./playwright_script_generation/visual-regression.md?raw";
import playwrightScriptGenerationUserWorkspace from "./playwright_script_generation/user-workspace.md?raw";
import playwrightScriptGenerationOutputFormat from "./playwright_script_generation/output-format.md?raw";
import playwrightScriptGenerationRules from "./playwright_script_generation/generation-rules.md?raw";
import playwrightScriptGenerationDelivery from "./playwright_script_generation/delivery.md?raw";
import { composeSkill } from "./compose-skill";
import type { SkillMap } from "../resources/types";

/**
 * Playwright 脚本生成 Skill 的子文件表（键名即主文件中 `{{> 键名 }}` 引用的名字）。
 *
 * 拆分的依据是「读者是否需要单独查阅」：页面核对流程、多步骤流程、视觉回归核对、
 * userWorkSpace 产物边界（v14）、输出格式、生成规则、交付要求各自成篇；
 * 主文件只保留用途、章节索引、输入数据与组成声明，
 * 便于快速建立整体认知后再按需深入。
 */
const playwrightScriptGenerationFragments = {
  "page-verification": playwrightScriptGenerationPageVerification,
  "multi-step-flow": playwrightScriptGenerationMultiStepFlow,
  "visual-regression": playwrightScriptGenerationVisualRegression,
  "user-workspace": playwrightScriptGenerationUserWorkspace,
  "output-format": playwrightScriptGenerationOutputFormat,
  "generation-rules": playwrightScriptGenerationRules,
  "delivery": playwrightScriptGenerationDelivery,
} as const;

/** 系统技能 map：文件名 -> 内容 */
const skillMap: SkillMap = {
  // e2e 测试用例转 Skill 的通用技能
  "e2e_test_case": e2eTestCaseSkill,
  // 根据结构化 test_case 生成测试用例 SKILL.md 的专用技能
  "test_case_Skill_document": testCaseSkillDocument,
  // 根据结构化 test_case、SKILL.md 与页面真实元素生成 Playwright 脚本的专用技能（v7）
  "playwright_script_generation": composeSkill(
    playwrightScriptGenerationMain,
    playwrightScriptGenerationFragments,
    "playwright_script_generation",
  ),
  // 发起测试执行并解读结果的专用技能（v11 引入，v16 接线）：
  // 与 execute_test / list_skills / read_skill_document 一同开放到 /agent 工作台。
  "test_script_execution": testScriptExecutionSkill,
};

export default skillMap;
