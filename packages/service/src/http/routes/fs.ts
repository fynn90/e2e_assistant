/**
 * 目录浏览 HTTP 路由：为前端目录选择器提供子目录列举、起始位置与新建目录能力。
 *
 * 这些路由刻意不依赖 requirePlatformConfig，
 * 因为首次初始化向导需要在平台配置尚不存在时使用目录选择器。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type {
  IBrowseRootsResponse,
  ICreateDirectoryResponse,
  IListDirectoryResponse,
} from '@authine-e2e-agent/types'
import {
  createDirectory,
  listBrowseRoots,
  listDirectory,
} from '../../workspace/directory-browser'
import type { IAppEnv } from '../app-types'
import { parseJsonBody } from '../request-validation'

const CREATE_DIRECTORY_BODY_LIMIT = 8 * 1024
const createDirectorySchema = z
  .object({
    parentPath: z.string(),
    name: z.string(),
  })
  .strict()

export function createFsRoutes(): Hono<IAppEnv> {
  const routes = new Hono<IAppEnv>()

  routes.get('/directories', async (context) => {
    const requestedPath = context.req.query('path') ?? ''
    const listing = await listDirectory({ directoryPath: requestedPath })
    const responseBody: IListDirectoryResponse = {
      success: true,
      data: listing,
    }

    return context.json(responseBody)
  })

  routes.get('/roots', async (context) => {
    const roots = await listBrowseRoots()
    const responseBody: IBrowseRootsResponse = {
      success: true,
      data: { roots },
    }

    return context.json(responseBody)
  })

  routes.post('/directories', async (context) => {
    const requestPayload = await parseJsonBody(
      context,
      createDirectorySchema,
      CREATE_DIRECTORY_BODY_LIMIT,
    )
    const createdDirectory = await createDirectory({
      parentPath: requestPayload.parentPath,
      name: requestPayload.name,
    })
    const responseBody: ICreateDirectoryResponse = {
      success: true,
      data: createdDirectory,
    }

    return context.json(responseBody)
  })

  return routes
}
