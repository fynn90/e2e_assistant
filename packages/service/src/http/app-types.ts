import type { TApiErrorCode } from '@fynn90-e2e_assistant/types'

export interface IAppVariables {
  requestId: string
  requestStartedAt: number
  errorCode?: TApiErrorCode
}

export interface IAppEnv {
  Variables: IAppVariables
}
