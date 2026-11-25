/**
 * @authine-e2e-agent/web-host 对外出口。
 *
 * 把 Web 工作台的构建产物挂载到任意 Hono 应用上。它依赖 `@authine-e2e-agent/web`
 * 但**不依赖服务层**——服务层是纯 API 服务、可独立部署到服务器端，
 * 「页面从哪来」由客户端形态决定（见 PRD v18 §4.6 的修订）。
 */
export {
  registerWebStaticRoutes,
  resolveWebDistInfo,
  type IResolvedWebDistInfo,
} from './register-web-static-routes'
