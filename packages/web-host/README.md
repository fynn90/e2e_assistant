# `@fynn90-e2e_assistant/web-host`

把 Web 工作台的构建产物挂载到任意 Hono 应用上。

## 1. 它为什么存在

**分层理由**：`packages/service` 是纯 API 服务，要能独立部署到服务器端，
因此它**不依赖任何前端包**。但浏览器需要一个地址同时拿到页面与 API
（前端以相对路径调用 `/api/*`，同源才不需要额外配置 CORS 与 Cookie 策略）。

本包就是这两者之间的桥：它依赖 `web`（前端产物）但不依赖 `service`，
由调用方把它的路由挂到服务应用上。

```text
apps/cli ──▶ packages/service   （纯 API，提供 extendApp 扩展点）
    │              ▲
    │              │ extendApp: registerWebStaticRoutes
    └─────▶ packages/web-host ──▶ packages/web（前端产物）
```

`service` 与 `web-host` **互不依赖**——两者只在调用方处被组合。

## 2. 用法

```ts
import { registerWebStaticRoutes } from '@fynn90-e2e_assistant/web-host'
import { startLocalServer } from '@fynn90-e2e_assistant/service'

// 方式一：作为服务启动的扩展点（CLI 当前的做法）
await startLocalServer({ port: 5826, extendApp: registerWebStaticRoutes })

// 方式二：挂到自己的 Hono 应用上（未来的桌面端、或其他宿主）
const app = new Hono()
app.route('/api', myApiRoutes)
registerWebStaticRoutes(app) // 必须最后调用
```

### 注册的路由

| 路由 | 行为 |
| --- | --- |
| `/assets/*` | 提供构建产物；越界或不存在的资源返回 404 |
| `*`（兜底） | 返回 `index.html`，使前端路由的深链（如 `/agent`）可直接访问 |

> ⚠️ **兜底路由必须最后注册**，否则会遮蔽宿主的 API 路由。这是本包唯一的调用约定。

### 产物缺失时

`web` 包未安装、或其 `dist/index.html` 不存在时，页面路由返回 **503 降级页**
（说明依赖包不可用），资源路由返回 404。降级页不泄露任何本机路径。

## 3. 不可放宽的安全性质

这些是从服务层迁出时**逐字保留**的约束，改动本包时不得放宽：

- **路径穿越防护**：解析前后各做一次越界校验，防住符号链接绕过 `dist` 目录；
- **安全响应头**：`Content-Security-Policy`（`frame-ancestors 'none'` 等）、
  `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；
- **降级页状态码为 503**（不是 500 或 404）。

`test/web-static-routes.test.ts` 对以上每项都有断言。

## 4. 依赖声明不可省

本包用 `createRequire(import.meta.url)` 在运行时解析 `@fynn90-e2e_assistant/web`，
因此必须在 `dependencies` 中**显式声明**它——pnpm 只有看到这条声明才会建立
`node_modules` 链接。

漏声明的后果不是构建失败，而是运行时解析失败被 `try/catch` 吞掉：构建、测试、
typecheck 全部通过，只有用户打开浏览器才看到 503 降级页。`pnpm release:check`
有对应护栏。
