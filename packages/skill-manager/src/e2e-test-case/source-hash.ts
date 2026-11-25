/**
 * 计算与文件字节版本独立的 E2E 领域 sourceHash。
 */
import { createHash } from 'node:crypto'
import type { IE2ETestCase } from '@charlie_deng/e2e-assistant-types'
import { canonicalizeE2ETestCaseForHash } from './serializer'

/**
 * 对 canonical E2E 领域对象计算 SHA-256 哈希。
 *
 * 使用剔除 browserVisualization 的 canonical 形式（技术方案 5.1.1）：
 * 该字段只影响浏览器运行模式，切换它不应使已有脚本被判定为过期。
 *
 * @param testCase - 已校验的 E2E 测试用例。
 * @returns 带 `sha256:` 前缀的稳定源数据哈希。
 */
export function calculateE2ESourceHash (testCase: IE2ETestCase): string {
  const canonicalJson = JSON.stringify(canonicalizeE2ETestCaseForHash(testCase))
  return `sha256:${createHash('sha256').update(canonicalJson, 'utf-8').digest('hex')}`
}
