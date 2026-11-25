/**
 * 把 Web 工作台的构建产物挂载到宿主 HTTP 应用上。
 *
 * 本模块只做一件事：托管 `@charlie_deng/e2e-assistant-web` 的 dist 目录。
 * 它不认识服务层，也不认识 CLI——调用方把自己的应用实例传进来即可。
 *
 * 这样分层的理由：服务层是纯 API 服务（可独立部署到服务器端），不应依赖前端包；
 * 「页面从哪来」是客户端形态的自由，由本模块表达。
 */
import { access, readFile, realpath } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Context, Hono } from 'hono'
import { lookup as lookupMimeType } from 'mime-types'

const resolveNodeModule = createRequire(import.meta.url)

/** 静态资源与页面统一施加的安全响应头；逐字保留，不放宽任何一项。 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * 宿主应用需满足的最小契约。
 *
 * 刻意只声明用到的 `get`，不引入对具体 `IAppEnv` 的依赖——本包不依赖服务层，
 * 任何 Hono 应用（服务层装配的、或未来桌面端的）都满足这个结构。
 */
type TRouteRegistrableApp = Pick<Hono<any>, 'get'>

/** Web 产物目录的解析结果。 */
export interface IResolvedWebDistInfo {
  /** 产物目录绝对路径；不可用时为 null，由调用方渲染降级页。 */
  webDistDirectoryPath: string | null
  /** `dependency`：从依赖包解析到；`missing`：包或构建产物不可用。 */
  source: 'dependency' | 'missing'
}

/**
 * 解析 Web 工作台的产物目录。
 *
 * 通过 `createRequire` 从**本模块产物所在位置**向上查找 `@charlie_deng/e2e-assistant-web`，
 * 因此本包必须在 `dependencies` 中显式声明 web——否则解析失败会被下面的 catch 吞掉，
 * 表现为用户看到降级页而非构建/启动错误。
 *
 * @returns 产物目录解析结果；包缺失或 dist 未构建时 `webDistDirectoryPath` 为 null。
 * @throws 不抛出异常，解析失败会收敛为 `missing`。
 */
export async function resolveWebDistInfo (): Promise<IResolvedWebDistInfo> {
  try {
    const webPackageJsonPath = resolveNodeModule.resolve(
      '@charlie_deng/e2e-assistant-web/package.json',
    )
    const webPackageDistDirectoryPath = path.join(
      path.dirname(webPackageJsonPath),
      'dist',
    )

    if (
      await isPathAccessible(
        path.join(webPackageDistDirectoryPath, 'index.html'),
      )
    ) {
      return {
        webDistDirectoryPath: webPackageDistDirectoryPath,
        source: 'dependency',
      }
    }
  } catch {
    // Web 包缺失或未构建：由降级页向用户说明，不向上抛异常。
  }

  return { webDistDirectoryPath: null, source: 'missing' }
}

/** `registerWebStaticRoutes` 的可选依赖；缺省使用从依赖包解析的真实实现。 */
export interface IRegisterWebStaticRoutesOptions {
  /**
   * 产物目录解析实现；缺省 `resolveWebDistInfo`（从依赖包解析）。
   *
   * 可注入是为了让「产物缺失」这条分支可被测试覆盖——用替身返回空目录即可，
   * 无需真的卸载 web 包。
   */
  resolveWebDistInfo?: () => Promise<IResolvedWebDistInfo>
}

/**
 * 注册 Web 工作台静态资源路由。
 *
 * 注册两条路由：`/assets/*` 提供构建产物，`*` 作为兜底返回 `index.html`（前端路由需要）。
 * 产物缺失时兜底路由返回 503 降级页——**必须最后注册**，否则会遮蔽宿主的 API 路由。
 *
 * @param app - 宿主 Hono 应用；调用方需保证本函数在全部 API 路由之后被调用。
 * @param options - 可选的依赖覆盖（测试用）。
 * @returns 无返回值。
 */
export function registerWebStaticRoutes (
  app: TRouteRegistrableApp,
  options: IRegisterWebStaticRoutesOptions = {},
): void {
  const resolveDist = options.resolveWebDistInfo ?? resolveWebDistInfo

  app.get('/assets/*', async (context: Context) => {
    const resolvedWebDistInfo = await resolveDist()

    if (!resolvedWebDistInfo.webDistDirectoryPath) {
      return context.text('Not Found', 404)
    }

    return await serveStaticAsset({
      context,
      requestPath: context.req.path,
      webDistDirectoryPath: resolvedWebDistInfo.webDistDirectoryPath,
    })
  })

  app.get('*', async (context: Context) => {
    const resolvedWebDistInfo = await resolveDist()

    if (!resolvedWebDistInfo.webDistDirectoryPath) {
      return context.html(buildMissingWebAssetsHtml(), 503)
    }

    const webIndexFilePath = path.join(
      resolvedWebDistInfo.webDistDirectoryPath,
      'index.html',
    )
    const indexHtmlContent = await readFile(webIndexFilePath, 'utf-8')
    setSecurityHeaders(context)
    return context.html(indexHtmlContent)
  })
}

interface IServeStaticAssetOptions {
  context: Context
  requestPath: string
  webDistDirectoryPath: string
}

/**
 * 读取并返回单个静态资源。
 *
 * 做两次路径校验（解析前后各一次），防住符号链接绕过 dist 目录的路径穿越。
 *
 * @param options 请求上下文、请求路径与产物目录。
 * @returns 资源响应；越界或不存在时返回 404。
 * @throws 不抛出异常，读取失败由调用方处理为 404。
 */
async function serveStaticAsset (
  options: IServeStaticAssetOptions,
): Promise<Response> {
  const relativeAssetPath = options.requestPath.replace(/^\/+/, '')
  const candidatePath = path.resolve(
    options.webDistDirectoryPath,
    relativeAssetPath,
  )
  const relativeFromDist = path.relative(
    options.webDistDirectoryPath,
    candidatePath,
  )

  if (relativeFromDist.startsWith('..') || path.isAbsolute(relativeFromDist)) {
    return options.context.text('Not Found', 404)
  }

  if (!(await isPathAccessible(candidatePath))) {
    return options.context.text('Not Found', 404)
  }

  const [realDistPath, realAssetPath] = await Promise.all([
    realpath(options.webDistDirectoryPath),
    realpath(candidatePath),
  ])
  const realRelativePath = path.relative(realDistPath, realAssetPath)

  if (realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) {
    return options.context.text('Not Found', 404)
  }

  const assetFileBuffer = await readFile(realAssetPath)
  setSecurityHeaders(options.context)

  return new Response(assetFileBuffer, {
    headers: {
      'Content-Type': getContentTypeByFilePath(realAssetPath),
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * 依据文件扩展名推断 Content-Type。
 *
 * @param filePath 资源文件绝对路径。
 * @returns 带 charset 的文本类 MIME；无法识别时为 application/octet-stream。
 * @throws 不抛出异常。
 */
function getContentTypeByFilePath (filePath: string): string {
  const detectedType = lookupMimeType(filePath)

  if (!detectedType) {
    return 'application/octet-stream'
  }

  if (
    detectedType.startsWith('text/') ||
    detectedType === 'application/javascript' ||
    detectedType === 'application/json' ||
    detectedType === 'application/xml'
  ) {
    return `${detectedType}; charset=utf-8`
  }

  return detectedType
}

/**
 * 为响应补充安全头。
 *
 * @param context 请求上下文。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function setSecurityHeaders (context: Context): void {
  context.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  context.header('X-Content-Type-Options', 'nosniff')
  context.header('Referrer-Policy', 'no-referrer')
}

/**
 * 判断路径是否存在且可访问。
 *
 * @param targetPath 目标路径。
 * @returns 可访问时返回 true。
 * @throws 不抛出异常。
 */
async function isPathAccessible (targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 构建「Web 产物不可用」降级页。
 *
 * 文案说明的是本包（web-host）对 web 包的依赖——它不再是 CLI 或服务层的依赖，
 * 因此改写了原措辞中被指认的对象，其余结构与样式逐字保留。
 *
 * @returns 降级页 HTML。
 * @throws 不抛出异常。
 */
function buildMissingWebAssetsHtml (): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Web 工作台未构建</title>
    <style>
      body { margin: 0; padding: 32px; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #111827; }
      main { max-width: 720px; margin: 0 auto; padding: 24px; background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; }
      code { display: inline-block; padding: 4px 8px; border-radius: 8px; background: #f3f4f6; }
    </style>
  </head>
  <body>
    <main>
      <h1>Web 工作台依赖包不可用</h1>
      <p>当前界面需要独立发布的 <code>@charlie_deng/e2e-assistant-web</code> 包来提供页面资源。</p>
      <p>请确认当前环境已正确安装依赖，或在 Monorepo 中先构建并链接 <code>apps/web</code>。</p>
    </main>
  </body>
</html>`
}
