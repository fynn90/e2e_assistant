import type { TApiErrorCode } from '@charlie_deng/e2e-assistant-types'

export interface IAppVariables {
  requestId: string
  requestStartedAt: number
  errorCode?: TApiErrorCode
}

export interface IAppEnv {
  Variables: IAppVariables
}
