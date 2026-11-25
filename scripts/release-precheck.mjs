import { access, readFile, readdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const workspaceRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const changesetDirectoryPath = path.join(workspaceRootPath, '.changeset')
const changesetConfigFilePath = path.join(changesetDirectoryPath, 'config.json')
const packageJsonGlobPaths = [
  path.join(workspaceRootPath, 'apps'),
  path.join(workspaceRootPath, 'packages'),
]
const cliPackageName = '@authine-e2e-agent/cli'
const webPackageName = '@authine-e2e-agent/web'
const servicePackageName = '@authine-e2e-agent/service'
const webHostPackageName = '@authine-e2e-agent/web-host'
const agentPackageName = '@authine-e2e-agent/agent'
const playwrightEnginePackageName = '@authine-e2e-agent/playwright-engine'
const skillManagerPackageName = '@authine-e2e-agent/skill-manager'
const requireChangeset = process.argv.includes('--require-changeset')

/**
 * 执行发包前静态自检，输出错误与警告摘要。
 * @returns 校验完成后无返回值。
 */
export async function runReleasePrecheck() {
  const changesetConfig = await readJsonFile(changesetConfigFilePath)
  const workspacePackages = await collectWorkspacePackages()
  const validationState = {
    errors: [],
    warnings: [],
  }

  validateWorkspacePackages({
    workspacePackages,
    changesetConfig,
    validationState,
  })

  await validateCliBinShebang({
    workspacePackages,
    validationState,
  })

  await validateChangesets({
    workspacePackages,
    changesetConfig,
    validationState,
    requireChangeset,
  })

  printValidationSummary(validationState)

  if (validationState.errors.length > 0) {
    process.exit(1)
  }
}

/**
 * 收集工作区内所有子包的 package.json 信息。
 * @returns 工作区包列表。
 */
async function collectWorkspacePackages() {
  const packageFilePaths = []

  for (const parentDirectoryPath of packageJsonGlobPaths) {
    const hasParentDirectory = await isPathAccessible(parentDirectoryPath)

    if (!hasParentDirectory) {
      continue
    }

    const childEntries = await readDirectoryNames(parentDirectoryPath)

    for (const childEntryName of childEntries) {
      const packageJsonFilePath = path.join(parentDirectoryPath, childEntryName, 'package.json')
      const hasPackageJson = await isPathAccessible(packageJsonFilePath)

      if (!hasPackageJson) {
        continue
      }

      packageFilePaths.push(packageJsonFilePath)
    }
  }

  const workspacePackages = []

  for (const packageJsonFilePath of packageFilePaths) {
    const packageJson = await readJsonFile(packageJsonFilePath)
    const packageDirectoryPath = path.dirname(packageJsonFilePath)
    const relativeDirectoryPath = path.relative(workspaceRootPath, packageDirectoryPath)

    workspacePackages.push({
      packageJson,
      packageJsonFilePath,
      packageDirectoryPath,
      relativeDirectoryPath,
    })
  }

  return workspacePackages
}

/**
 * 对工作区包元数据和包间依赖关系进行校验。
 * @param options 校验参数。
 * @returns 校验完成后无返回值。
 */
function validateWorkspacePackages(options) {
  const ignoredPackageNames = new Set(options.changesetConfig.ignore ?? [])
  const packageNameMap = new Map()

  for (const workspacePackage of options.workspacePackages) {
    const packageName = workspacePackage.packageJson.name

    if (!packageName) {
      options.validationState.errors.push(
        `包 ${workspacePackage.relativeDirectoryPath} 缺少 name 字段。`,
      )
      continue
    }

    if (packageNameMap.has(packageName)) {
      options.validationState.errors.push(
        `包名 ${packageName} 重复，冲突路径：${packageNameMap.get(packageName)} 与 ${workspacePackage.relativeDirectoryPath}。`,
      )
      continue
    }

    packageNameMap.set(packageName, workspacePackage.relativeDirectoryPath)
  }

  for (const workspacePackage of options.workspacePackages) {
    validateSinglePackage({
      workspacePackage,
      packageNameMap,
      ignoredPackageNames,
      validationState: options.validationState,
    })
  }

  validateWebHostDependency({
    workspacePackages: options.workspacePackages,
    validationState: options.validationState,
  })

  validateNoOneDependsOnCli({
    workspacePackages: options.workspacePackages,
    validationState: options.validationState,
  })

  validateBrowserLayerIndependence({
    workspacePackages: options.workspacePackages,
    validationState: options.validationState,
  })
}

/**
 * 校验 CLI 的 bin 产物首行是 node shebang。
 *
 * npm 的 cmd-shim 依赖首行 shebang 决定是否为启动脚本加 `node` 前缀：
 * 缺少 shebang 时生成的 shim 会直接执行 .js 文件，Windows 会把它交给 .js 文件关联
 * （如 VS Code、WScript）而不是 node，表现为命令静默无输出或语法错误。
 * 该缺陷只在「用户安装后」暴露，本地 `pnpm dev` 走 tsx 不会触发，因此在此静态拦住。
 *
 * @param options 校验参数。
 * @returns 校验完成后无返回值。
 */
async function validateCliBinShebang(options) {
  const cliPackage = options.workspacePackages.find(
    (workspacePackage) => workspacePackage.packageJson.name === cliPackageName,
  )

  if (!cliPackage) {
    return
  }

  const binEntries = Object.entries(cliPackage.packageJson.bin ?? {})

  if (binEntries.length === 0) {
    options.validationState.errors.push(`${cliPackageName} 缺少 bin 配置，用户无法通过命令启动。`)
    return
  }

  for (const [binName, binRelativePath] of binEntries) {
    const binFilePath = path.resolve(cliPackage.packageDirectoryPath, binRelativePath)

    if (!(await isPathAccessible(binFilePath))) {
      // 产物未构建时无法校验首行；交给「构建型包缺少 build/prepack」等其它校验提示。
      continue
    }

    const binFileContent = await readFile(binFilePath, 'utf8')

    if (!binFileContent.startsWith('#!')) {
      options.validationState.errors.push(
        `${cliPackageName} 的 bin "${binName}" 指向的 ${binRelativePath} 首行不是 shebang：` +
          'npm 生成的启动脚本不会加 node 前缀，用户安装后执行该命令会静默失败。' +
          '请在 CLI 入口源文件首行添加 "#!/usr/bin/env node"。',
      )
    }
  }
}

/**
 * 校验单个包的发布元数据与内部依赖配置。
 * @param options 校验参数。
 * @returns 校验完成后无返回值。
 */
function validateSinglePackage(options) {
  const packageJson = options.workspacePackage.packageJson
  const packageName = packageJson.name
  const isIgnored = options.ignoredPackageNames.has(packageName)
  const isPrivatePackage = packageJson.private === true
  const isPublishablePackage = !isPrivatePackage && !isIgnored

  if (!packageJson.version) {
    options.validationState.errors.push(`包 ${packageName} 缺少 version 字段。`)
  }

  if (isPublishablePackage) {
    if (!packageJson.publishConfig?.access) {
      options.validationState.errors.push(`可发布包 ${packageName} 缺少 publishConfig.access。`)
    }

    if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
      options.validationState.errors.push(`可发布包 ${packageName} 缺少 files 配置。`)
    }

    if (!packageJson.exports && !packageJson.main) {
      options.validationState.errors.push(`可发布包 ${packageName} 至少需要声明 exports 或 main。`)
    }

    if (!packageJson.engines?.node) {
      options.validationState.errors.push(
        `可发布包 ${packageName} 缺少 engines.node：用户用过低版本 Node 安装时拿不到任何提示，` +
          '只会在运行命令时失败。应与仓库根基线一致（>=22.19.0）。',
      )
    }

    if (usesDistFiles(packageJson)) {
      if (!packageJson.scripts?.build) {
        options.validationState.errors.push(`构建型包 ${packageName} 缺少 build 脚本。`)
      }

      if (!packageJson.scripts?.prepack) {
        options.validationState.errors.push(`构建型包 ${packageName} 缺少 prepack 脚本。`)
      }
    }
  }

  if (isIgnored && !isPrivatePackage) {
    options.validationState.warnings.push(`包 ${packageName} 被 Changesets ignore，但当前不是 private 包。`)
  }

  validateInternalDependencies({
    packageJson,
    packageNameMap: options.packageNameMap,
    validationState: options.validationState,
  })
}

/**
 * 校验内部依赖是否正确使用 workspace 协议，并避免依赖被忽略的包。
 * @param options 校验参数。
 * @returns 校验完成后无返回值。
 */
function validateInternalDependencies(options) {
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]

  for (const dependencySection of dependencySections) {
    const dependencies = options.packageJson[dependencySection]

    if (!dependencies) {
      continue
    }

    for (const [dependencyName, dependencyVersion] of Object.entries(dependencies)) {
      if (!options.packageNameMap.has(dependencyName)) {
        continue
      }

      if (typeof dependencyVersion !== 'string' || !dependencyVersion.startsWith('workspace:')) {
        options.validationState.errors.push(
          `包 ${options.packageJson.name} 在 ${dependencySection} 中引用内部包 ${dependencyName} 时必须使用 workspace: 协议。`,
        )
      }
    }
  }
}

/**
 * 校验 Web 工作台的静态资源托管链。
 *
 * 托管职责归 `web-host`——**服务层是纯 API 服务，不得依赖任何前端包**
 * （它要能独立部署到服务器端）。因此：
 * - `web-host` 必须显式依赖 web：它在运行时用 createRequire 解析 web 的 dist 目录，
 *   pnpm 只有看到这条依赖声明才会建立 node_modules 链接，漏声明会让工作台静默降级为 503 页；
 * - 服务层不得依赖 web（否则它无法脱离前端独立部署）；
 * - web 必须发布 dist 产物且声明 build 脚本。
 *
 * @param options 校验参数。
 * @returns 校验完成后无返回值。
 */
function validateWebHostDependency(options) {
  const webHostPackage = options.workspacePackages.find((workspacePackage) => workspacePackage.packageJson.name === webHostPackageName)
  const webPackage = options.workspacePackages.find((workspacePackage) => workspacePackage.packageJson.name === webPackageName)
  const servicePackage = options.workspacePackages.find((workspacePackage) => workspacePackage.packageJson.name === servicePackageName)

  if (!webHostPackage) {
    options.validationState.errors.push(`缺少 ${webHostPackageName} 包。`)
    return
  }

  if (!webPackage) {
    options.validationState.errors.push(`缺少 ${webPackageName} 包。`)
    return
  }

  if (!webHostPackage.packageJson.dependencies?.[webPackageName]) {
    options.validationState.errors.push(
      `${webHostPackageName} 必须显式依赖 ${webPackageName}：它在运行时解析 web 的 dist 目录，缺少该声明会让工作台静默降级为 503 页。`,
    )
  }

  for (const dependencySection of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (servicePackage?.packageJson[dependencySection]?.[webPackageName]) {
      options.validationState.errors.push(
        `${servicePackageName} 不得依赖 ${webPackageName}（当前出现在 ${dependencySection}）：服务层是纯 API 服务，需能独立部署到服务器端。前端资源托管归 ${webHostPackageName}。`,
      )
    }
  }

  if (!usesDistFiles(webPackage.packageJson)) {
    options.validationState.errors.push(`${webPackageName} 必须发布 dist 产物，供 ${webHostPackageName} 在用户电脑上托管。`)
  }

  if (!webPackage.packageJson.scripts?.build) {
    options.validationState.errors.push(`${webPackageName} 缺少 build 脚本。`)
  }
}

/**
 * 校验没有任何工作区包依赖 CLI。
 *
 * CLI 是命令层（PRD v18 §4.0 原则三），一旦被依赖，
 * 服务层或未来的 desktop 就能触达「启动进程 / 结束进程」的能力，
 * 「谁提供能力」与「谁管理进程」的边界立刻失效。
 *
 * @param options 校验参数。
 * @returns 校验完成后无返回值。
 */
function validateNoOneDependsOnCli(options) {
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]

  for (const workspacePackage of options.workspacePackages) {
    if (workspacePackage.packageJson.name === cliPackageName) {
      continue
    }

    for (const dependencySection of dependencySections) {
      if (workspacePackage.packageJson[dependencySection]?.[cliPackageName]) {
        options.validationState.errors.push(
          `包 ${workspacePackage.packageJson.name} 在 ${dependencySection} 中依赖 ${cliPackageName}：CLI 是命令层，不应被任何包依赖（PRD v18 原则三）。`,
        )
      }
    }
  }
}

/**
 * 校验 agent、playwright-engine、skill-manager 三包互不依赖。
 *
 * agent 是模型能力层，浏览器实现归 playwright-engine、SKILL 存储归 skill-manager，
 * 三者的共享契约（浏览器会话类型、脱敏器接口等）统一定义在 @authine-e2e-agent/types。
 * 任何一边直接依赖另一边都会破坏依赖倒转：组合根（service / CLI）应负责装配实现，
 * 三包也才能独立构建、测试与发布。
 *
 * @param options 校验参数。
 * @returns 校验完成后无返回值。
 */
function validateBrowserLayerIndependence(options) {
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]
  const forbiddenEdges = [
    {
      sourcePackageName: agentPackageName,
      targetPackageNames: [playwrightEnginePackageName, skillManagerPackageName],
    },
    {
      sourcePackageName: playwrightEnginePackageName,
      targetPackageNames: [agentPackageName, skillManagerPackageName],
    },
    {
      sourcePackageName: skillManagerPackageName,
      targetPackageNames: [agentPackageName, playwrightEnginePackageName],
    },
  ]

  for (const edge of forbiddenEdges) {
    const sourcePackage = options.workspacePackages.find(
      (workspacePackage) => workspacePackage.packageJson.name === edge.sourcePackageName,
    )

    if (!sourcePackage) {
      continue
    }

    for (const targetPackageName of edge.targetPackageNames) {
      for (const dependencySection of dependencySections) {
        if (sourcePackage.packageJson[dependencySection]?.[targetPackageName]) {
          options.validationState.errors.push(
            `包 ${edge.sourcePackageName} 在 ${dependencySection} 中依赖 ${targetPackageName}：agent、playwright-engine、skill-manager 三包互不依赖，共享契约统一定义在 @authine-e2e-agent/types，由组合根注入实现。`,
          )
        }
      }
    }
  }
}

/**
 * 校验 changeset 文件是否存在、是否引用了合法包，并检查改动覆盖。
 * @param options 校验参数。
 * @returns 校验完成后无返回值。
 */
async function validateChangesets(options) {
  const packageNameMap = new Map(
    options.workspacePackages.map((workspacePackage) => [workspacePackage.packageJson.name, workspacePackage]),
  )
  const ignoredPackageNames = new Set(options.changesetConfig.ignore ?? [])
  const changesetFiles = await collectChangesetFiles()
  const changedPublishablePackages = getChangedPublishablePackages({
    workspacePackages: options.workspacePackages,
    baseBranch: options.changesetConfig.baseBranch,
    ignoredPackageNames,
    validationState: options.validationState,
  })
  const referencedPackageNames = new Set()

  for (const changesetFile of changesetFiles) {
    const referencedPackages = parseChangesetPackageNames(changesetFile.content)

    if (referencedPackages.length === 0) {
      options.validationState.errors.push(
        `changeset ${changesetFile.fileName} 没有声明任何包版本变更。`,
      )
    }

    for (const referencedPackageName of referencedPackages) {
      referencedPackageNames.add(referencedPackageName)

      if (!packageNameMap.has(referencedPackageName)) {
        options.validationState.errors.push(
          `changeset ${changesetFile.fileName} 引用了不存在的包 ${referencedPackageName}。`,
        )
        continue
      }

      if (ignoredPackageNames.has(referencedPackageName)) {
        options.validationState.errors.push(
          `changeset ${changesetFile.fileName} 不应包含被忽略的包 ${referencedPackageName}。`,
        )
      }
    }
  }

  if (options.requireChangeset && changesetFiles.length === 0) {
    options.validationState.errors.push('当前没有待处理的 changeset 文件，无法执行正式发布前校验。')
  }

  for (const changedPackageName of changedPublishablePackages) {
    if (!referencedPackageNames.has(changedPackageName)) {
      options.validationState.errors.push(
        `包 ${changedPackageName} 自 ${options.changesetConfig.baseBranch} 以来有改动，但缺少对应 changeset。`,
      )
    }
  }

  if (!options.requireChangeset && changesetFiles.length === 0) {
    options.validationState.warnings.push('当前没有检测到待处理的 changeset 文件。')
  }
}

/**
 * 收集 .changeset 目录下除 README 外的变更文件。
 * @returns changeset 文件列表。
 */
async function collectChangesetFiles() {
  const hasChangesetDirectory = await isPathAccessible(changesetDirectoryPath)

  if (!hasChangesetDirectory) {
    return []
  }

  const entryNames = await readdir(changesetDirectoryPath)
  const changesetFiles = []

  for (const entryName of entryNames) {
    if (!entryName.endsWith('.md') || entryName === 'README.md') {
      continue
    }

    const filePath = path.join(changesetDirectoryPath, entryName)
    const content = await readFile(filePath, 'utf-8')

    changesetFiles.push({
      fileName: entryName,
      content,
    })
  }

  return changesetFiles
}

/**
 * 从 changeset markdown 中解析 frontmatter 里涉及的包名。
 *
 * 行尾兼容 CRLF：Windows 上 `core.autocrlf` 会把提交的文件检出成 \r\n，
 * 而 Changesets 自身能解析这种文件。若这里只认 \n，那些 changeset 会被误判为
 * 「没有声明任何包版本变更」——报错指向格式，实际是解析器不够宽容。
 *
 * @param content changeset 文件内容。
 * @returns 该 changeset 涉及的包名集合。
 */
function parseChangesetPackageNames(content) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)

  if (!frontmatterMatch) {
    return []
  }

  const packageNames = []
  const frontmatterContent = frontmatterMatch[1]
  const packageEntryPattern = /['"]?(@[^'":\n]+\/[^'":\n]+)['"]?\s*:/g

  for (const entryMatch of frontmatterContent.matchAll(packageEntryPattern)) {
    packageNames.push(entryMatch[1])
  }

  return packageNames
}

/**
 * 基于 git diff 推断自基线分支以来发生改动的可发布包。
 * @param options 校验参数。
 * @returns 改动包名集合。
 */
function getChangedPublishablePackages(options) {
  const changedFilePaths = getChangedFilePathsFromGit(options.baseBranch)

  if (!changedFilePaths) {
    options.validationState.warnings.push('未能从 git diff 推断改动范围，跳过“改动包必须有 changeset”校验。')
    return new Set()
  }

  const changedPackageNames = new Set()

  for (const workspacePackage of options.workspacePackages) {
    const packageName = workspacePackage.packageJson.name
    const isIgnored = options.ignoredPackageNames.has(packageName)
    const isPrivatePackage = workspacePackage.packageJson.private === true

    if (isIgnored || isPrivatePackage) {
      continue
    }

    for (const changedFilePath of changedFilePaths) {
      if (changedFilePath.startsWith(`${workspacePackage.relativeDirectoryPath}/`)) {
        changedPackageNames.add(packageName)
        break
      }
    }
  }

  return changedPackageNames
}

/**
 * 从 git 中读取当前分支相对基线分支的改动文件。
 * @param baseBranch Changesets 配置的基线分支名。
 * @returns 改动文件路径列表；无法获取时返回 `null`。
 */
function getChangedFilePathsFromGit(baseBranch) {
  const candidateRefs = [`origin/${baseBranch}`, baseBranch, 'origin/main', 'main']

  for (const candidateRef of candidateRefs) {
    try {
      execSync(`git rev-parse --verify ${candidateRef}`, {
        cwd: workspaceRootPath,
        stdio: 'ignore',
      })

      const outputText = execSync(`git diff --name-only ${candidateRef}...HEAD`, {
        cwd: workspaceRootPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })

      return outputText
        .split('\n')
        .map((filePath) => filePath.trim())
        .filter(Boolean)
    } catch {
      // 继续尝试下一个候选分支。
    }
  }

  return null
}

/**
 * 输出自检摘要，帮助快速定位错误与警告。
 * @param validationState 校验结果。
 * @returns 输出完成后无返回值。
 */
function printValidationSummary(validationState) {
  if (validationState.errors.length === 0 && validationState.warnings.length === 0) {
    console.log('Release precheck passed.')
    return
  }

  if (validationState.errors.length > 0) {
    console.error('Release precheck failed with errors:')

    for (const errorMessage of validationState.errors) {
      console.error(`- ${errorMessage}`)
    }
  }

  if (validationState.warnings.length > 0) {
    console.warn('Release precheck warnings:')

    for (const warningMessage of validationState.warnings) {
      console.warn(`- ${warningMessage}`)
    }
  }
}

/**
 * 读取 JSON 文件并返回解析结果。
 * @param filePath JSON 文件绝对路径。
 * @returns 解析后的对象。
 */
async function readJsonFile(filePath) {
  const fileContent = await readFile(filePath, 'utf-8')
  return JSON.parse(fileContent)
}

/**
 * 读取目录下第一层子目录名称。
 * @param directoryPath 目录绝对路径。
 * @returns 子目录名称列表。
 */
async function readDirectoryNames(directoryPath) {
  const directoryEntries = await readdir(directoryPath, {
    withFileTypes: true,
  })

  return directoryEntries
    .filter((directoryEntry) => directoryEntry.isDirectory())
    .map((directoryEntry) => directoryEntry.name)
}

/**
 * 判断目标路径是否存在。
 * @param targetPath 目标路径。
 * @returns 存在时返回 `true`。
 */
async function isPathAccessible(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 判断当前包是否发布 dist 产物。
 * @param packageJson 包配置。
 * @returns 使用 dist 发布时返回 `true`。
 */
function usesDistFiles(packageJson) {
  return Array.isArray(packageJson.files) && packageJson.files.some((filePattern) => filePattern === 'dist')
}

/**
 * 判断当前脚本是否由 Node 直接执行，而不是被测试或其他模块导入。
 *
 * 注意：本文件用 `import path from 'node:path'`（命名空间默认导入），
 * 因此这里必须写 path.resolve，不能照抄 check-dev-ports.mjs 的 resolve。
 *
 * @returns 当前模块为进程入口时返回 true，否则返回 false。
 * @throws 不抛出异常。
 */
function isMainModule() {
  return Boolean(
    process.argv[1] &&
      path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]),
  )
}

if (isMainModule()) {
  runReleasePrecheck().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export {
  parseChangesetPackageNames,
  validateNoOneDependsOnCli,
  validateBrowserLayerIndependence,
  validateWebHostDependency,
  validateWorkspacePackages,
  validateSinglePackage,
  validateInternalDependencies,
}
