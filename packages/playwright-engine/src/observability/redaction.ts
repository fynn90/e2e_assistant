/** 实现 Engine 默认文本脱敏器，过滤秘密值、凭据模式和本机绝对路径。 */

import os from 'node:os'
import path from 'node:path'
import type {
  ISecretRegistrableRedactor,
  ISensitiveDataRedactor,
} from '../contracts/observability'

const SECRET_PATTERNS = [
  /(password|passwd|token|api[_-]?key|secret)\s*[=:]\s*[^\s,;]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/gi,
]

/**
 * 使用固定长度上限和可注入秘密集合执行脱敏。
 *
 * 秘密集合支持运行期登记（v20 凭据代理）：凭据在会话运行中才被填入页面，
 * 构造时不可知，而填入后其值会出现在无障碍树与元素查询结果里，
 * 因此必须能在填写的当下把值登记进来。
 */
export class DefaultSensitiveDataRedactor
  implements ISensitiveDataRedactor, ISecretRegistrableRedactor
{
  private readonly secrets: string[]
  private readonly maxLength: number
  private readonly absolutePaths: readonly string[]

  /**
   * 创建默认脱敏器。
   *
   * @param options - 额外秘密值和输出长度配置。
   * @returns 可用于事件、错误和命令输出的脱敏器。
   * @throws 不抛出异常。
   */
  constructor(
    options: { secrets?: readonly string[]; maxLength?: number } = {},
  ) {
    this.secrets = (options.secrets ?? []).filter((secret) => secret.length > 0)
    this.maxLength = Math.max(256, options.maxLength ?? 8_192)
    this.absolutePaths = [
      os.homedir(),
      process.cwd(),
      path.resolve(os.tmpdir()),
    ].filter(Boolean)
  }

  /**
   * 登记一个运行期秘密值，此后所有输出中的该值都会被替换。
   *
   * @param secret - 需要屏蔽的真实值；空串与重复值被忽略。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  registerSecret(secret: string): void {
    if (typeof secret !== 'string' || secret.length === 0) {
      return
    }
    if (this.secrets.includes(secret)) {
      return
    }
    this.secrets.push(secret)
  }

  /**
   * 读取当前已登记的全部秘密值。
   *
   * @returns 秘密值副本；调用方修改该数组不影响内部状态。
   * @throws 不抛出异常。
   */
  listSecrets(): readonly string[] {
    return [...this.secrets]
  }

  /**
   * 移除已知秘密、常见凭据字段和用户目录绝对路径。
   *
   * @param value - 可能包含敏感信息的文本。
   * @returns 已脱敏并截断的文本。
   * @throws 不抛出异常；非字符串输入按空文本处理。
   */
  redact(value: string): string {
    let result = typeof value === 'string' ? value : ''

    for (const secret of this.secrets) {
      result = result.split(secret).join('[REDACTED]')
    }

    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, (match) => {
        const separatorIndex = match.search(/\s*[=:]\s*/)
        return separatorIndex >= 0
          ? `${match.slice(0, separatorIndex)}=[REDACTED]`
          : '[REDACTED]'
      })
    }

    for (const absolutePath of this.absolutePaths) {
      if (absolutePath) {
        result = result.split(absolutePath).join('[PATH]')
      }
    }

    return result.length > this.maxLength
      ? `${result.slice(0, this.maxLength)}…`
      : result
  }
}

/**
 * 创建默认脱敏器。
 *
 * @param options - 额外秘密和输出长度配置。
 * @returns 默认脱敏器实例。
 * @throws 不抛出异常。
 */
export function createDefaultRedactor(
  options: { secrets?: readonly string[]; maxLength?: number } = {},
): DefaultSensitiveDataRedactor {
  return new DefaultSensitiveDataRedactor(options)
}
