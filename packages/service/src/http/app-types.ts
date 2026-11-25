import type { TApiErrorCode } from '@authine-e2e-agent/types'

export interface IAppVariables {
  requestId: string
  requestStartedAt: number
  errorCode?: TApiErrorCode
}

export interface IAppEnv {
  Variables: IAppVariables
}
