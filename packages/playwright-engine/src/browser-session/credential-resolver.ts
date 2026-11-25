/**
 * 凭据引用解析（v20 凭据代理）。
 *
 * 职责：把 `${ENV:KEY}` 形态的引用交给宿主注入的解析端口换取真实值，
 * 并在拿到真值的**同一时刻**把值登记进脱敏器。
 *
 * 为什么单独成文件：这段逻辑是「Agent 只看引用、真值不回流」这条安全不变式的
 * 唯一实现点，独立后既可被单测直接覆盖，也便于会话类保持职责单一。
 *
 * 不变式（改动时必须同时满足）：
 *   1. 真值只在本模块的局部变量中短暂存在，绝不进入返回值以外的任何通道；
 *   2. 真值在填入页面**之前**完成脱敏器登记——否则填入后产生的快照
 *      会把密码原样读回模型（无障碍树与元素查询都会带出 input 的当前值）；
 *   3. 失败原因只使用稳定分类码，绝不复用宿主返回的原始文本。
 */

import type {
  ICredentialResolution,
  ICredentialResolver,
} from '../contracts/browser'

/**
 * `${ENV:KEY}` 引用形态。
 *
 * 完整匹配整个字符串（`^...$`）——与 packages/types 的 `ENV_REFERENCE_PATTERN`
 * 语法同源，但用途不同：那边是全局扫描用例文本，这边是判定「整个值就是一个引用」。
 * 两处的字符集规则必须保持一致，改动时需同步。
 */
export const CREDENTIAL_REFERENCE_PATTERN = /^\$\{ENV:([A-Z_][A-Z0-9_]*)\}$/

/**
 * 解析待填入的值。
 *
 * 三种输入形态的处理：
 *   - **字面量**：原样返回，`isCredential=false`；
 *   - **引用且已注入解析端口**：调用端口换取真值；
 *   - **引用但未注入解析端口**：返回失败。
 *
 * 第三种情形**必须报错而不是当字面量填入**：把 `${ENV:LOGIN_PASSWORD}` 这串文本
 * 填进密码框不会立刻失败，而是要等到断言阶段才以「登录不成功」的形式暴露，
 * 排查成本极高，且会让用户误以为是环境问题。
 *
 * @param value - 工具传入的待填值（字面量或引用）。
 * @param resolver - 宿主注入的凭据解析端口；未注入时引用形态不可用。
 * @returns 解析结果：可填入的值、是否来自凭据、以及失败时的稳定原因。
 * @throws 不抛出异常——所有失败以返回值表达，避免异常堆栈携带秘密值。
 */
export async function resolveFillValue(
  value: string,
  resolver: ICredentialResolver | undefined,
): Promise<TFillValueResolution> {
  const matched = CREDENTIAL_REFERENCE_PATTERN.exec(value)

  if (!matched) {
    return { ok: true, value, isCredential: false }
  }

  const key = matched[1]

  if (!resolver) {
    return { ok: false, reason: 'resolver-unavailable', key }
  }

  let resolution: ICredentialResolution
  try {
    resolution = await resolver.resolve(key)
  } catch {
    // 解析端口抛错可能是宿主缺陷（如文件系统异常）；归类为不可用，
    // 不复用异常消息——它可能意外携带被解析的值。
    return { ok: false, reason: 'unavailable', key }
  }

  if (!resolution.ok) {
    return { ok: false, reason: resolution.reason, key }
  }

  if (resolution.value.length === 0) {
    // 空凭据填入没有意义，且会让「登录失败」的根因变得隐晦；
    // 与解析端口的 empty 分类保持一致。
    return { ok: false, reason: 'empty', key }
  }

  return { ok: true, value: resolution.value, isCredential: true, key }
}

/**
 * 待填值的解析结果。
 *
 * 成功分支的 `key` 仅在值来自凭据引用时存在，供调用方在事件里标注
 * 「本次使用了凭据」而不泄露值本身。
 */
export type TFillValueResolution =
  | {
      ok: true
      /** 可安全填入页面的值（字面量或解析出的真实凭据）。 */
      value: string
      /** 值是否来自 `${ENV:KEY}` 引用解析。 */
      isCredential: boolean
      /** 引用的 env key；字面量时不存在。 */
      key?: string
    }
  | {
      ok: false
      /** 稳定失败分类：未注入解析端口 / 未找到 / 不可用 / 空值。 */
      reason:
        | 'resolver-unavailable'
        | 'not-found'
        | 'unavailable'
        | 'empty'
      /** 引用中的 env key，供错误消息点名（key 名本身不是秘密）。 */
      key: string
    }
