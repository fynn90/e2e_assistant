/**
 * 提案服务的依赖端口类型（v17）。
 *
 * 单独成文件的原因：`proposal-service.ts` 只描述「提案怎么流转」，
 * 它**消费**的能力（用例保存 / 生命周期）由组合根注入。把端口的形状放在这里，
 * `app.ts` 组合根与测试替身可以只依赖这个轻量模块，不必把整个服务实现拉进来。
 */

import type {
  IE2ETestCase,
  IUpdateE2ETestCaseData,
} from '@charlie_deng/e2e-assistant-types'

/**
 * 用例保存端口（`updateE2ETestCase` 的形状）。
 *
 * 为什么在这里声明而不是直接 import 应用层的函数类型：那是**实现**，
 * 本服务只需要「给我一份目标用例与期望版本，你负责校验、乐观锁与落盘」这个契约
 *（依赖倒转）。实现方是 `application/e2e-test-case/update-e2e-test-case.ts`。
 */
export interface IUpdateE2ETestCase {
  /**
   * 保存结构化用例。
   *
   * @param input - 工作区、用例 ID、目标用例与期望版本。
   * @returns 保存结果（新版本、来源哈希与文档状态）。
   * @throws SkillManagerError（FILE_VERSION_CONFLICT）版本不符时抛出（E4 的判据）。
   * @throws SkillManagerError 校验不通过或写入失败时抛出。
   */
  (input: {
    rootDir: string
    skillId: string
    request: {
      testCase: IE2ETestCase
      expectedVersion: string
    }
  }): Promise<IUpdateE2ETestCaseData>
}
