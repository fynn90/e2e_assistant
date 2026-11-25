/**
 * 技能子文件组装工具（v12）。
 *
 * 背景：技能（Skill）正文在**构建期**经 `?raw` 内联进内存注册表，
 * 运行期只有注册表里的整段文本，**没有**按路径读取子文件的能力
 * （`load_skill` 只按名取整段内容，不递归、不解析引用）。
 *
 * 因此「主文件引用子文件」只能在**注册时**完成：主文件写 `{{> 子文件名 }}` 占位符，
 * 本模块负责把占位符替换为对应子文件的原文。这样：
 *   - 主文件保持简洁，可读性接近「路由表」（内容索引 + 输入数据 + 组成声明）；
 *   - 长篇幅的模板与规则放在独立子文件中，便于单独维护与评审；
 *   - 对模型而言，最终加载到上下文的仍是一份**完整连续的 Skill 文本**，没有额外读取步骤。
 *
 * 与 `resources/template.ts` 的 `{{ 变量 }}` 机制的区别：那套是**运行期**变量替换
 * （值由调用方在 `getSkill(name, variables)` 时传入），本模块是**注册期**的静态包含，
 * 不需要也无法由调用方提供值。两者语法刻意区分（`{{ name }}` vs `{{> name }}`），
 * 避免运行期变量替换误伤静态包含。
 */

/** 静态包含占位符：`{{> 子文件名 }}`。 */
const INCLUDE_PATTERN = /\{\{>\s*([\w.-]+)\s*\}\}/g

/**
 * 使用给定的子文件表展开主文件中的所有静态包含。
 *
 * 支持嵌套包含（子文件里也能写 `{{> ... }}`），最多展开 {@link MAX_INCLUDE_DEPTH} 层，
 * 以在出现循环引用时快速失败而不是无限递归。
 *
 * @param mainContent - 主文件原文（含 `{{> 子文件名 }}` 占位符）。
 * @param fragments - 子文件名（不含 .md 扩展名）到其原文的映射。
 * @param options - 可选的名称与深度（内部递归使用，调用方无需传）。
 * @returns 展开后的完整技能文本。
 * @throws {Error} 占位符引用了 `fragments` 中不存在的子文件，或包含层级过深（循环引用）时抛出。
 */
export function composeSkillContent(
  mainContent: string,
  fragments: Readonly<Record<string, string>>,
  options: { name?: string; depth?: number } = {},
): string {
  const name = options.name ?? 'skill'
  const depth = options.depth ?? 0

  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(
      `技能 ${name} 的静态包含层级超过 ${MAX_INCLUDE_DEPTH} 层，可能存在循环引用。`,
    )
  }

  return mainContent.replace(INCLUDE_PATTERN, (_match, fileName: string) => {
    const fragment = fragments[fileName]

    if (fragment === undefined) {
      throw new Error(
        `技能 ${name} 引用了未提供的子文件「${fileName}」。`
          + `已提供的子文件：${Object.keys(fragments).sort().join('、') || '（无）'}。`,
      )
    }

    // 子文件本身也可以声明包含，递归展开。
    return composeSkillContent(fragment, fragments, { name, depth: depth + 1 })
  })
}

/**
 * 静态包含的最大嵌套层数。
 *
 * 取 5 是「足够表达常见的两级目录组织」与「循环引用能快速失败」之间的折中。
 */
const MAX_INCLUDE_DEPTH = 5

/**
 * 拼装一个由主文件与子文件组成的技能。
 *
 * 供 `skills/index.ts` 使用：把 `playwright_script_generation/index.md` 与同目录下的
 * 模板、规则子文件组装为注册表需要的单一字符串。
 *
 * @param mainContent - 主文件原文。
 * @param fragments - 子文件映射。
 * @param name - 技能名，仅用于错误信息。
 * @returns 可直接放进技能注册表的完整文本。
 * @throws {Error} 主文件引用了缺失的子文件，或包含层级过深时抛出。
 */
export function composeSkill(
  mainContent: string,
  fragments: Readonly<Record<string, string>>,
  name: string,
): string {
  return composeSkillContent(mainContent, fragments, { name })
}
