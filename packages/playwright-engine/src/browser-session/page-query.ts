/** 将页面 selector 查询结果转换为有界、结构化且脱敏的元素信息。 */

import type { Frame, Page } from 'playwright'
import type { IElementInfo } from '../contracts/browser'
import type { ISensitiveDataRedactor } from '../contracts/observability'

const DEFAULT_QUERY_LIMIT = 100

/**
 * 查询页面元素并提取有限属性。
 *
 * @param page - Playwright 页面对象，仅在 Engine 内部使用。
 * @param selector - CSS 或 Playwright selector。
 * @param redactor - 用于过滤文本和属性的脱敏器。
 * @param limit - 最多返回的元素数量。
 * @returns 脱敏后的结构化元素信息。
 * @throws 页面关闭、selector 无效或 Playwright 查询失败时抛出底层异常。
 */
export async function queryPageElements(
  page: Page | Frame,
  selector: string,
  redactor: ISensitiveDataRedactor,
  limit = DEFAULT_QUERY_LIMIT,
): Promise<IElementInfo[]> {
  const elements = await page
    .locator(selector)
    .evaluateAll((nodes, querySelector) => {
      return nodes.slice(0, 100).map((node, index) => {
        const htmlElement = node as HTMLElement
        const input = htmlElement as HTMLInputElement
        // 密码框的值永不回传（v20）：即便是用户手输或凭据代理填入的内容，
        // 一旦进入模型上下文就无法收回。此处按元素类型屏蔽，与脱敏器互为独立防线——
        // 脱敏器依赖「知道具体值」，而这里不需要知道任何值即可生效。
        const isPasswordField =
          (input.type ?? '').toLowerCase() === 'password'
        const attributes: Record<string, string> = {}
        for (const attribute of Array.from(htmlElement.attributes).slice(
          0,
          20,
        )) {
          if (
            (attribute.name === 'value' && !isPasswordField) ||
            attribute.name === 'data-testid' ||
            attribute.name.startsWith('aria-')
          ) {
            attributes[attribute.name] = attribute.value.slice(0, 500)
          }
        }
        const value =
          'value' in input && !isPasswordField
            ? input.value.slice(0, 500)
            : undefined
        const text = (htmlElement.textContent ?? '').trim().slice(0, 500)
        return {
          selector: querySelector,
          index,
          tagName: htmlElement.tagName.toLowerCase(),
          role: htmlElement.getAttribute('role') ?? undefined,
          name: htmlElement.getAttribute('aria-label') ?? undefined,
          ...(text ? { text } : {}),
          ...(value ? { value } : {}),
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        }
      })
    }, selector)

  return elements.slice(0, Math.max(1, limit)).map((element) => ({
    ...element,
    selector: redactor.redact(element.selector),
    ...(element.tagName ? { tagName: redactor.redact(element.tagName) } : {}),
    ...(element.role ? { role: redactor.redact(element.role) } : {}),
    ...(element.name ? { name: redactor.redact(element.name) } : {}),
    ...(element.text ? { text: redactor.redact(element.text) } : {}),
    ...(element.value ? { value: redactor.redact(element.value) } : {}),
    ...(element.attributes
      ? {
          attributes: Object.fromEntries(
            Object.entries(element.attributes).map(([key, value]) => [
              key,
              redactor.redact(value),
            ]),
          ),
        }
      : {}),
  }))
}

/** 查询默认最大元素数量。 */
export const browserQueryDefaults = {
  limit: DEFAULT_QUERY_LIMIT,
} as const
