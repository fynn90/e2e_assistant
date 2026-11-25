/**
 * 验证保存与生成动作的就绪标签、阻塞原因和外部状态组合。
 */
import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  createDefaultE2ETestCase,
  type IE2ETestCase,
} from '@charlie_deng/e2e-assistant-types'
import { useE2ETestCaseReadiness } from '../../src/modules/e2e-test-case/composables/useE2ETestCaseReadiness'
import {
  getDraftGenerationIssues,
  getDraftSaveIssues,
} from '../../src/modules/e2e-test-case/validation/test-case-form-validator'

function validDraft (): IE2ETestCase {
  return {
    ...createDefaultE2ETestCase({
      skillId: 'abc123def',
      title: '登录测试',
      description: '验证用户登录。',
    }),
    baseUrl: 'https://example.test',
    steps: [
      {
        id: 'step_login',
        order: 1,
        description: '打开登录页',
        action: '填写账号密码并提交',
        expectedResult: '进入工作台',
        testData: {},
        enabled: true,
      },
    ],
  }
}

function createHarness (
  input: {
    draft?: IE2ETestCase
    dirty?: boolean
    chatReady?: boolean
    readOnly?: boolean
    running?: boolean
    status?: 'ready' | 'saving' | 'conflicted'
    skillDocumentExists?: boolean
    skillDocumentCurrent?: boolean
    scriptGenerationRunning?: boolean
    /** env 引用就绪问题（v10）：仅注入 generate 与 generateScript 动作。 */
    envReferenceIssues?: Array<{
      path: Array<string | number>
      message: string
    }>
  } = {},
) {
  const draft = ref<IE2ETestCase | null>(input.draft ?? validDraft())
  const dirty = ref(input.dirty ?? false)
  const chatReady = ref(input.chatReady ?? true)
  const readOnly = ref(input.readOnly ?? false)
  const running = ref(input.running ?? false)
  const status = ref(input.status ?? 'ready')
  const skillDocumentExists = ref(input.skillDocumentExists ?? false)
  const skillDocumentCurrent = ref(input.skillDocumentCurrent ?? false)
  const scriptGenerationRunning = ref(input.scriptGenerationRunning ?? false)

  return useE2ETestCaseReadiness({
    draft,
    dirty: computed(() => dirty.value),
    status,
    saveIssues: computed(() =>
      draft.value ? getDraftSaveIssues(draft.value) : [],
    ),
    generationIssues: computed(() =>
      draft.value ? getDraftGenerationIssues(draft.value) : [],
    ),
    envReferenceIssues: computed(() => input.envReferenceIssues ?? []),
    chatReady: computed(() => chatReady.value),
    readOnly: computed(() => readOnly.value),
    generationRunning: computed(() => running.value),
    skillDocumentExists: computed(() => skillDocumentExists.value),
    skillDocumentCurrent: computed(() => skillDocumentCurrent.value),
    scriptGenerationRunning: computed(() => scriptGenerationRunning.value),
  })
}

describe('useE2ETestCaseReadiness', () => {
  it('labels a valid dirty action as save-and-generate', () => {
    const readiness = createHarness({ dirty: true })

    expect(readiness.generate.value).toMatchObject({
      enabled: true,
      label: '保存并生成 Skill 文档',
      requiresSave: true,
      reasons: [],
    })
  })

  it('keeps clean generation explicit and disables redundant save', () => {
    const readiness = createHarness()

    expect(readiness.generate.value).toMatchObject({
      enabled: true,
      label: '生成 Skill 文档',
      requiresSave: false,
    })
    expect(readiness.save.value.enabled).toBe(false)
    expect(readiness.save.value.reasons[0]?.message).toContain('没有未保存修改')
  })

  it('labels dirty generation as save-and-update once SKILL.md already exists', () => {
    const readiness = createHarness({ dirty: true, skillDocumentExists: true })

    expect(readiness.generate.value).toMatchObject({
      enabled: true,
      label: '保存并更新 Skill 文档',
      requiresSave: true,
    })
  })

  it('保存用例后（草稿已干净但 SKILL.md 已过期）仍允许更新文档', () => {
    // 回归用例：用户改完用例先点了「保存用例」，此时 dirty=false 但 SKILL.md
    // 正是被这次修改变成过期的。若“无需更新”判定只看 dirty，按钮会在这里
    // 变灰——用户在最需要更新文档的时候反而点不动（保存用例后按钮失效）。
    const readiness = createHarness({
      dirty: false,
      skillDocumentExists: true,
      skillDocumentCurrent: false,
    })

    expect(readiness.generate.value.enabled).toBe(true)
    expect(readiness.generate.value.label).toBe('更新 Skill 文档')
    expect(readiness.generate.value.reasons).toEqual([])
  })

  it('草稿干净且 SKILL.md 已基于当前用例时仍提示无需更新', () => {
    const readiness = createHarness({
      dirty: false,
      skillDocumentExists: true,
      skillDocumentCurrent: true,
    })

    expect(readiness.generate.value.enabled).toBe(false)
    expect(readiness.generate.value.reasons).toEqual([
      expect.objectContaining({ key: 'skill-document-current' }),
    ])
  })

  it('maps domain validation issues to focusable field reasons', () => {
    const draft = validDraft()
    draft.baseUrl = ''
    draft.steps = []
    const readiness = createHarness({ draft, dirty: true })

    expect(readiness.generate.value.enabled).toBe(false)
    expect(readiness.generate.value.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '目标 URL',
          targetId: 'e2e-base-url',
        }),
        expect.objectContaining({
          label: '测试步骤',
          targetId: 'e2e-steps-section',
        }),
      ]),
    )
  })

  it('keeps save and generation enabled for plaintext sensitive test data in MVP', () => {
    const draft = validDraft()
    draft.steps[0]!.testData = { username: 'bo2', password: '123456' }
    // dirty: true 才会让保存动作进入可执行判断，否则被“没有未保存修改”单独阻塞
    const readiness = createHarness({
      draft,
      dirty: true,
      skillDocumentExists: true,
    })

    // MVP 阶段敏感数据总开关关闭：明文测试数据不阻塞保存与生成
    expect(readiness.generate.value.enabled).toBe(true)
    expect(readiness.save.value.enabled).toBe(true)
    expect(
      readiness.generate.value.reasons.some((reason) =>
        reason.message.includes('password'),
      ),
    ).toBe(false)
  })

  it('combines read-only, model, conflict, and running blockers without hiding them', () => {
    const readiness = createHarness({
      readOnly: true,
      chatReady: false,
      running: true,
      status: 'conflicted',
    })
    const messages = readiness.generate.value.reasons.map(
      (reason) => reason.message,
    )

    expect(readiness.generate.value.enabled).toBe(false)
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('版本冲突'),
        expect.stringContaining('只读'),
        expect.stringContaining('模型配置'),
        expect.stringContaining('正在生成'),
      ]),
    )
  })

  it('env 引用失效阻断生成但不阻断保存（v10 PRD 6.3）', () => {
    const envIssues = [
      {
        path: ['steps', 0, 'testData', 'E2E_PASSWORD'],
        message:
          '引用的 key "E2E_PASSWORD" 在 env.json 中不存在，请在 env.json 中补充该 key 或移除此引用。',
      },
    ]
    const readiness = createHarness({
      dirty: true,
      envReferenceIssues: envIssues,
    })

    expect(readiness.save.value.enabled).toBe(true)
    expect(readiness.save.value.reasons).toEqual([])
    expect(readiness.generate.value.enabled).toBe(false)
    expect(readiness.generate.value.reasons).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('E2E_PASSWORD'),
      }),
    ])
  })
})

describe('useE2ETestCaseReadiness Playwright 脚本生成（v7）', () => {
  it('SKILL.md 基于当前用例且草稿干净时才允许生成脚本', () => {
    const readiness = createHarness({
      skillDocumentExists: true,
      skillDocumentCurrent: true,
    })

    expect(readiness.generateScript.value).toMatchObject({
      enabled: true,
      label: '生成 Playwright 脚本',
    })
    expect(readiness.generateScript.value.reasons).toEqual([])
  })

  it('SKILL.md 缺失或过期时给出明确阻塞原因', () => {
    // 未生成、已生成但过期（stale）都必须被拦住：服务端会校验来源一致性，
    // 放行只会让用户等到模型跑完才失败。
    for (const input of [
      { skillDocumentExists: false, skillDocumentCurrent: false },
      { skillDocumentExists: true, skillDocumentCurrent: false },
    ]) {
      const readiness = createHarness(input)

      expect(readiness.generateScript.value.enabled).toBe(false)
      expect(
        readiness.generateScript.value.reasons.map((reason) => reason.message),
      ).toEqual([expect.stringContaining('请先生成并确认 SKILL.md')])
    }
  })

  it('草稿未保存时阻止生成脚本，避免服务端来源校验失败', () => {
    const readiness = createHarness({
      skillDocumentExists: true,
      skillDocumentCurrent: true,
      dirty: true,
    })

    expect(readiness.generateScript.value.enabled).toBe(false)
    expect(
      readiness.generateScript.value.reasons.map((reason) => reason.message),
    ).toEqual([expect.stringContaining('请先保存最新的结构化用例')])
  })

  it('脚本生成进行中时禁用重复提交', () => {
    const readiness = createHarness({
      skillDocumentExists: true,
      skillDocumentCurrent: true,
      scriptGenerationRunning: true,
    })

    expect(readiness.generateScript.value.enabled).toBe(false)
    expect(
      readiness.generateScript.value.reasons.map((reason) => reason.message),
    ).toEqual([expect.stringContaining('Playwright 脚本正在生成')])
  })
})
