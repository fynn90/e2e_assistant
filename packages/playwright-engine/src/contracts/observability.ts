/**
 * 定义宿主可注入的敏感信息脱敏契约：运行期秘密登记能力。
 *
 * 基础脱敏接口 ISensitiveDataRedactor 属于 agent / 引擎共享契约，
 * 已迁移至 @charlie_deng/e2e-assistant-types；此处再导出以保持引擎公共 API 不变。
 */
import type { ISensitiveDataRedactor } from '@charlie_deng/e2e-assistant-types'

export type { ISensitiveDataRedactor } from '@charlie_deng/e2e-assistant-types'

/**
 * 可登记运行期秘密值的脱敏器（v20 凭据代理）。
 *
 * 存在理由：凭据由工具在**运行期**填入页面，其值在会话构造时不可知，
 * 因此无法走「构造时传入 secrets」的既有路径。但值一旦进入页面，
 * 就会出现在后续快照的无障碍树与元素查询的 value 字段中——
 * 必须让脱敏器在此之后认识这些值，否则密码会经核对结果回流进模型上下文。
 *
 * 与 {@link ISensitiveDataRedactor} 分开声明的原因：该能力只有默认脱敏器实现，
 * 宿主注入的自定义脱敏器可能不具备（此时引擎退化为「不额外登记」），
 * 因此调用方须用 {@link isSecretRegistrable} 做能力检测，不得假定存在。
 */
export interface ISecretRegistrableRedactor {
  /**
   * 登记一个运行期秘密值。
   *
   * @param secret - 需要从此不再出现在任何输出中的真实值；空串被忽略。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  registerSecret (secret: string): void
  /**
   * 读取当前已登记的全部运行期秘密值。
   *
   * 存在理由：快照会按当次调用的长度上限**派生新的脱敏器**，
   * 派生实例若不继承已登记的秘密，运行期登记的值就会在新实例上失效
   * （表现为「填入密码后的第一次快照把密码原样带出」）。
   * 调用方据此在派生时把秘密集合传递下去。
   *
   * 安全约定：返回值只可用于构造新的脱敏器，**不得写入日志、事件或工具结果**。
   *
   * @returns 已登记秘密值的快照副本（外部修改不影响内部状态）。
   * @throws 不抛出异常。
   */
  listSecrets (): readonly string[]
}

/**
 * 判断脱敏器是否支持运行期登记秘密值。
 *
 * @param redactor - 待检测的脱敏器；允许为 undefined。
 * @returns 支持 `registerSecret` 时返回 true。
 * @throws 不抛出异常。
 */
export function isSecretRegistrable (
  redactor: ISensitiveDataRedactor | undefined,
): redactor is ISensitiveDataRedactor & ISecretRegistrableRedactor {
  return (
    !!redactor &&
    typeof (redactor as Partial<ISecretRegistrableRedactor>)
      .registerSecret === 'function'
  )
}
