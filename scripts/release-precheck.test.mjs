/**
 * 验证发包前自检的两条结构性校验：
 * - 「CLI 不被任何包依赖」护栏（PRD v18 原则三 / AC-08）；
 * - 服务层与 Web 的运行时依赖链（PRD v18 §4.6 W3）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseChangesetPackageNames,
  validateBrowserLayerIndependence,
  validateNoOneDependsOnCli,
  validateWebHostDependency,
} from './release-precheck.mjs'

const CLI_PACKAGE_NAME = '@authine-e2e-agent/cli'
const SERVICE_PACKAGE_NAME = '@authine-e2e-agent/service'
const WEB_PACKAGE_NAME = '@authine-e2e-agent/web'
const WEB_HOST_PACKAGE_NAME = '@authine-e2e-agent/web-host'
const AGENT_PACKAGE_NAME = '@authine-e2e-agent/agent'
const PLAYWRIGHT_ENGINE_PACKAGE_NAME = '@authine-e2e-agent/playwright-engine'
const SKILL_MANAGER_PACKAGE_NAME = '@authine-e2e-agent/skill-manager'

/**
 * 构造一个工作区包条目。
 * @param {string} name 包名。
 * @param {object} packageJson 额外的 package.json 字段。
 * @returns {{packageJson: object, relativeDirectoryPath: string}} 工作区包条目。
 */
function buildWorkspacePackage(name, packageJson = {}) {
  return {
    packageJson: { name, version: '0.0.0', ...packageJson },
    relativeDirectoryPath: `packages/${name.split('/').pop()}`,
  }
}

/**
 * 在给定工作区上运行一次校验并返回错误列表。
 * @param {(options: object) => void} validate 待运行的校验函数。
 * @param {object[]} workspacePackages 工作区包列表。
 * @returns {string[]} 收集到的错误消息。
 */
function collectErrors(validate, workspacePackages) {
  const validationState = { errors: [], warnings: [] }

  validate({ workspacePackages, validationState })

  return validationState.errors
}

test('正常工作区不产生「依赖 cli」错误', () => {
  const errors = collectErrors(validateNoOneDependsOnCli, [
    buildWorkspacePackage(CLI_PACKAGE_NAME, {
      dependencies: { '@authine-e2e-agent/types': 'workspace:^' },
    }),
    buildWorkspacePackage(SERVICE_PACKAGE_NAME, {
      dependencies: { '@authine-e2e-agent/types': 'workspace:^' },
      devDependencies: { vitest: '^4.1.10' },
    }),
  ])

  assert.deepEqual(errors, [])
})

test('内部包依赖 cli 时报错，并指出违规包名与理由', () => {
  const errors = collectErrors(validateNoOneDependsOnCli, [
    buildWorkspacePackage(CLI_PACKAGE_NAME),
    buildWorkspacePackage(SERVICE_PACKAGE_NAME, {
      dependencies: { [CLI_PACKAGE_NAME]: 'workspace:^' },
    }),
  ])

  assert.equal(errors.length, 1)
  assert.match(errors[0], new RegExp(SERVICE_PACKAGE_NAME.replace(/[/@]/g, '\\$&')))
  assert.match(errors[0], /不应被任何包依赖/)
})

test('四个依赖段都受检查', () => {
  for (const dependencySection of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const errors = collectErrors(validateNoOneDependsOnCli, [
      buildWorkspacePackage(CLI_PACKAGE_NAME),
      buildWorkspacePackage('@authine-e2e-agent/agent', {
        [dependencySection]: { [CLI_PACKAGE_NAME]: 'workspace:^' },
      }),
    ])

    assert.equal(
      errors.length,
      1,
      `依赖段 ${dependencySection} 未被检查到违规`,
    )
    assert.match(errors[0], new RegExp(dependencySection))
  }
})

test('cli 自身声明自己不算违规（它不是「被其它包依赖」）', () => {
  const errors = collectErrors(validateNoOneDependsOnCli, [
    buildWorkspacePackage(CLI_PACKAGE_NAME, {
      dependencies: { '@authine-e2e-agent/types': 'workspace:^' },
    }),
  ])

  assert.deepEqual(errors, [])
})

test('web-host 显式依赖 web、服务层不碰 web 时通过', () => {
  const errors = collectErrors(validateWebHostDependency, [
    buildWorkspacePackage(CLI_PACKAGE_NAME, {
      dependencies: { [SERVICE_PACKAGE_NAME]: 'workspace:^' },
    }),
    buildWorkspacePackage(SERVICE_PACKAGE_NAME, {
      dependencies: { '@authine-e2e-agent/types': 'workspace:^' },
    }),
    buildWorkspacePackage(WEB_HOST_PACKAGE_NAME, {
      dependencies: { [WEB_PACKAGE_NAME]: 'workspace:^' },
    }),
    buildWorkspacePackage(WEB_PACKAGE_NAME, {
      files: ['dist'],
      scripts: { build: 'vite build' },
    }),
  ])

  assert.deepEqual(errors, [])
})

test('web-host 缺少 web 依赖时报错（运行时解析会静默降级为 503）', () => {
  const errors = collectErrors(validateWebHostDependency, [
    buildWorkspacePackage(CLI_PACKAGE_NAME, {
      dependencies: { [SERVICE_PACKAGE_NAME]: 'workspace:^' },
    }),
    buildWorkspacePackage(SERVICE_PACKAGE_NAME),
    buildWorkspacePackage(WEB_HOST_PACKAGE_NAME, {
      dependencies: { hono: '^4.12.23' },
    }),
    buildWorkspacePackage(WEB_PACKAGE_NAME, {
      files: ['dist'],
      scripts: { build: 'vite build' },
    }),
  ])

  assert.equal(errors.length, 1)
  assert.match(errors[0], /必须显式依赖/)
})

test('服务层依赖 web 时报错（服务层须为纯 API 服务、可独立部署）', () => {
  for (const dependencySection of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const errors = collectErrors(validateWebHostDependency, [
      buildWorkspacePackage(CLI_PACKAGE_NAME),
      buildWorkspacePackage(SERVICE_PACKAGE_NAME, {
        [dependencySection]: { [WEB_PACKAGE_NAME]: 'workspace:^' },
      }),
      buildWorkspacePackage(WEB_HOST_PACKAGE_NAME, {
        dependencies: { [WEB_PACKAGE_NAME]: 'workspace:^' },
      }),
      buildWorkspacePackage(WEB_PACKAGE_NAME, {
        files: ['dist'],
        scripts: { build: 'vite build' },
      }),
    ])

    assert.equal(errors.length, 1, `依赖段 ${dependencySection} 未被检查到违规`)
    assert.match(errors[0], /不得依赖/)
    assert.match(errors[0], new RegExp(dependencySection))
  }
})

test('web 未发布 dist 或缺少 build 脚本时报错', () => {
  const errors = collectErrors(validateWebHostDependency, [
    buildWorkspacePackage(CLI_PACKAGE_NAME),
    buildWorkspacePackage(SERVICE_PACKAGE_NAME),
    buildWorkspacePackage(WEB_HOST_PACKAGE_NAME, {
      dependencies: { [WEB_PACKAGE_NAME]: 'workspace:^' },
    }),
    buildWorkspacePackage(WEB_PACKAGE_NAME, {
      files: ['src'],
      scripts: {},
    }),
  ])

  assert.equal(errors.length, 2)
  assert.ok(errors.some((errorMessage) => errorMessage.includes('必须发布 dist 产物')))
  assert.ok(errors.some((errorMessage) => errorMessage.includes('缺少 build 脚本')))
})

test('changeset frontmatter 的行尾兼容 CRLF', () => {
  // Windows 上 core.autocrlf 会把 changeset 检出成 CRLF；若解析器只认 \n，
  // 这些文件会被误报为「没有声明任何包版本变更」。
  const lfContent = '---\n"@authine-e2e-agent/web": minor\n---\n\n正文\n'
  const crlfContent = '---\r\n"@authine-e2e-agent/web": minor\r\n---\r\n\r\n正文\r\n'

  assert.deepEqual(parseChangesetPackageNames(lfContent), [
    '@authine-e2e-agent/web',
  ])
  assert.deepEqual(parseChangesetPackageNames(crlfContent), [
    '@authine-e2e-agent/web',
  ])
})

test('changeset frontmatter 多包与缺 frontmatter 的边界', () => {
  const multiPackageContent =
    '---\n"@authine-e2e-agent/cli": major\n"@authine-e2e-agent/service": minor\n---\n\n正文\n'

  assert.deepEqual(parseChangesetPackageNames(multiPackageContent), [
    '@authine-e2e-agent/cli',
    '@authine-e2e-agent/service',
  ])
  assert.deepEqual(parseChangesetPackageNames('没有 frontmatter 的正文'), [])
})

test('缺失 web-host 或 web 包时给出明确错误', () => {
  const missingWebHostErrors = collectErrors(validateWebHostDependency, [
    buildWorkspacePackage(CLI_PACKAGE_NAME),
  ])

  assert.equal(missingWebHostErrors.length, 1)
  assert.match(missingWebHostErrors[0], /缺少 @authine-e2e-agent\/web-host 包/)
})

test('三包只依赖共享类型包时不产生「浏览器分层」错误', () => {
  const errors = collectErrors(validateBrowserLayerIndependence, [
    buildWorkspacePackage(AGENT_PACKAGE_NAME, {
      dependencies: { '@authine-e2e-agent/types': 'workspace:^' },
    }),
    buildWorkspacePackage(PLAYWRIGHT_ENGINE_PACKAGE_NAME, {
      dependencies: {
        '@authine-e2e-agent/types': 'workspace:^',
        playwright: '1.64.0',
      },
    }),
    buildWorkspacePackage(SKILL_MANAGER_PACKAGE_NAME, {
      dependencies: { '@authine-e2e-agent/types': 'workspace:^' },
    }),
  ])

  assert.deepEqual(errors, [])
})

test('agent 依赖 playwright-engine 或 skill-manager 时报错', () => {
  for (const targetPackageName of [
    PLAYWRIGHT_ENGINE_PACKAGE_NAME,
    SKILL_MANAGER_PACKAGE_NAME,
  ]) {
    const errors = collectErrors(validateBrowserLayerIndependence, [
      buildWorkspacePackage(AGENT_PACKAGE_NAME, {
        dependencies: { [targetPackageName]: 'workspace:^' },
      }),
      buildWorkspacePackage(targetPackageName),
    ])

    assert.equal(errors.length, 1, `未检出 agent → ${targetPackageName}`)
    assert.match(errors[0], /三包互不依赖/)
  }
})

test('playwright-engine 与 skill-manager 互相依赖时双向报错', () => {
  const errors = collectErrors(validateBrowserLayerIndependence, [
    buildWorkspacePackage(PLAYWRIGHT_ENGINE_PACKAGE_NAME, {
      dependencies: { [SKILL_MANAGER_PACKAGE_NAME]: 'workspace:^' },
    }),
    buildWorkspacePackage(SKILL_MANAGER_PACKAGE_NAME, {
      dependencies: { [PLAYWRIGHT_ENGINE_PACKAGE_NAME]: 'workspace:^' },
    }),
  ])

  assert.equal(errors.length, 2)
})

test('浏览器分层校验覆盖全部四个依赖段', () => {
  for (const dependencySection of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const errors = collectErrors(validateBrowserLayerIndependence, [
      buildWorkspacePackage(SKILL_MANAGER_PACKAGE_NAME, {
        [dependencySection]: { [AGENT_PACKAGE_NAME]: 'workspace:^' },
      }),
      buildWorkspacePackage(AGENT_PACKAGE_NAME),
    ])

    assert.equal(
      errors.length,
      1,
      `依赖段 ${dependencySection} 未被检查到违规`,
    )
  }
})
