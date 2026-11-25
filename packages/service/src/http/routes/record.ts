import { Hono } from 'hono'
import type { IRecordStartResponse } from '@authine-e2e-agent/types'
import type { IAppEnv } from '../app-types'

export function createRecordRoutes(): Hono<IAppEnv> {
  const routes = new Hono<IAppEnv>()

  routes.post('/start', (context) => {
    const responseBody: IRecordStartResponse = {
      success: true,
      data: { status: 'pending' },
    }

    return context.json(responseBody)
  })

  return routes
}
