/**
 * 组合 E2E 应用服务的默认生产实现，并允许测试替换生成器工厂。
 */
import type { IE2ETestCaseApplicationServices } from './application-types'
import {
  generatePlaywrightScript,
  type TPlaywrightGeneratorFactory,
} from './generate-playwright-script'
import { getE2ETestCase } from './get-e2e-test-case'
import {
  generateSkillDocument,
  type TSkillMarkdownGeneratorFactory,
} from './skill-document'
import { saveSkillDocument } from './save-skill-document'
import { savePlaywrightScript } from './save-playwright-script'
import { updateE2ETestCase } from './update-e2e-test-case'

/**
 * 创建 E2E 用例相关的应用服务。
 *
 * 生成器工厂由调用方（组合根）注入：默认实现需要 agent-work 运行时
 * （承载 Agent 会话并发布工作事件）与 generation-runtime（浏览器会话与并发控制），
 * 二者都属于基础设施层，应用层不直接依赖（依赖倒转原则）。
 *
 * @param generatorFactory - 可选的 Playwright 脚本生成器工厂；缺省时抛出，
 *   因为默认实现需要由组合根（app.ts）注入运行时与浏览器宿主。
 * @param skillMarkdownGeneratorFactory - SKILL.md 生成器工厂；缺省时抛出，
 *   因为默认实现需要由组合根（app.ts）注入运行时。
 * @returns 供 HTTP 路由复用的应用服务集合。
 * @throws {Error} 当未注入对应生成器工厂且触发该生成时抛出。
 */
export function createE2ETestCaseApplicationServices(
  generatorFactory?: TPlaywrightGeneratorFactory,
  skillMarkdownGeneratorFactory?: TSkillMarkdownGeneratorFactory,
): IE2ETestCaseApplicationServices {
  const resolveSkillMarkdownGeneratorFactory =
    (): TSkillMarkdownGeneratorFactory => {
      if (!skillMarkdownGeneratorFactory) {
        throw new Error(
          'SKILL.md 生成器工厂未配置：需要由组合根注入带 agent-work 运行时的实现。',
        )
      }
      return skillMarkdownGeneratorFactory
    }
  const resolvePlaywrightGeneratorFactory = (): TPlaywrightGeneratorFactory => {
    if (!generatorFactory) {
      throw new Error(
        'Playwright 脚本生成器工厂未配置：需要由组合根注入带 agent-work 运行时与浏览器宿主的实现。',
      )
    }
    return generatorFactory
  }

  return {
    get: getE2ETestCase,
    update: updateE2ETestCase,
    generate: (input) =>
      generatePlaywrightScript(input, resolvePlaywrightGeneratorFactory()),
    saveScript: savePlaywrightScript,
    generateSkillDocument: (input) =>
      generateSkillDocument(input, resolveSkillMarkdownGeneratorFactory()),
    saveSkillDocument,
  }
}
