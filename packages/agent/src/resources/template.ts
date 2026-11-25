/**
 * 模板渲染工具：把 markdown 资源内容中的变量占位符替换为传入的值。
 *
 * 占位符语法为 `{{ variableName }}`，兼容 `{{ name }}` 与 `{{name}}` 两种写法。
 * 未提供值的占位符会原样保留，不会抛错，方便内容中包含可选变量。
 */

/** 变量值类型：字符串、数字、布尔，替换时统一转为字符串 */
export type TemplateVariables = Record<string, string | number | boolean>

/** 占位符匹配正则：`{{ 变量名 }}`，变量名允许字母、数字、下划线、点、连字符 */
const PLACEHOLDER_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g

/**
 * 渲染模板：把 `{{ 变量名 }}` 占位符替换为变量对象中的同名值。
 *
 * @param template - 模板字符串（资源内容）
 * @param variables - 变量名到值的映射对象
 * @returns 渲染后的完整内容；未提供值的占位符原样保留
 * @throws 无
 */
export function renderTemplate(
  template: string,
  variables: TemplateVariables,
): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    const value = variables[name]
    // 变量未提供（或显式传 null/undefined）时保留原占位符
    if (value === undefined || value === null) {
      return match
    }
    return String(value)
  })
}
