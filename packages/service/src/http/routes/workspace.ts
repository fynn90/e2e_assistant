import { Hono } from 'hono'
import type { IWorkspaceFilesResponse } from '@charlie_deng/e2e-assistant-types'
import type { IAppEnv } from '../app-types'
import { listProjectFiles } from '../../workspace/project-files'
import { requirePlatformConfig } from './route-utils'

export function createWorkspaceRoutes (): Hono<IAppEnv> {
  const routes = new Hono<IAppEnv>()

  routes.get('/files', async (context) => {
    const { config } = await requirePlatformConfig()
    const projectFiles = await listProjectFiles({
      rootDirectory: config.projectDirectory,
    })
    const responseBody: IWorkspaceFilesResponse = {
      success: true,
      data: projectFiles,
    }

    return context.json(responseBody)
  })

  return routes
}
