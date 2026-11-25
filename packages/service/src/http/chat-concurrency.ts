import { ApiError } from '../shared/errors/api-error'

export interface IChatConcurrencyLease {
  release(): void
}

export class ChatConcurrencyGate {
  private activeGlobal = 0
  private readonly activeBySkill = new Map<string, number>()

  constructor(
    private readonly globalLimit = 2,
    private readonly perSkillLimit = 1,
  ) {}

  acquire(skillId: string): IChatConcurrencyLease {
    const activeForSkill = this.activeBySkill.get(skillId) ?? 0

    if (
      this.activeGlobal >= this.globalLimit ||
      activeForSkill >= this.perSkillLimit
    ) {
      throw new ApiError({
        code: 'CHAT_CONCURRENCY_LIMITED',
        status: 429,
        message: '当前 Chat 请求较多，请等待已有请求完成后重试。',
      })
    }

    this.activeGlobal += 1
    this.activeBySkill.set(skillId, activeForSkill + 1)
    let released = false

    return {
      release: () => {
        if (released) {
          return
        }

        released = true
        this.activeGlobal = Math.max(0, this.activeGlobal - 1)
        const nextActiveForSkill = Math.max(
          0,
          (this.activeBySkill.get(skillId) ?? 1) - 1,
        )

        if (nextActiveForSkill === 0) {
          this.activeBySkill.delete(skillId)
        } else {
          this.activeBySkill.set(skillId, nextActiveForSkill)
        }
      },
    }
  }
}
