<!--
  AskUserQuestion 卡片（v14 D5/D7）：Agent 用 `ask_user_question` 工具向用户发问时的渲染组件。

  两种形态，由 `interaction.questions` 是否存在决定（用户不切换形态）：

    ┌ 单问题形态（questions 缺省）：顶层 options 一组候选 ─────────────┐
    │  选一项（或选「其它」并填写）→ 点卡片底部「提交」               │
    └──────────────────────────────────────────────────────────────┘
    ┌ 多问题形态（questions 有 N 项）：一问一 tab ──────────────────┐
    │  tab1 ✓ ─ tab2 ─ tab3                                        │
    │  选完一题自动切到下一道未填的题，也可随时切回改答；            │
    │  全部填完 → 点底部「提交」一次性提交                          │
    └──────────────────────────────────────────────────────────────┘

  关键交互约定（PRD 4.7.1/Q11/Q18-Q23）：
    - **先填写、后提交**：点选候选项只是记录选择，不立即作答；
      提交由卡片底部的提交按钮触发，**提交前可随时切 tab 改答**；
    - 某题填完后自动切到**下一道未填的题**（回头改答时不会把用户推走）；
    - 提交按钮在全部题目填完前保持禁用，并在按钮旁写明还差几题/还差什么；
    - **不提供取消出口**：提问的语义是「拿到答案才能继续」，唯一退出是中止会话
      （此时卡片由服务端定格为 aborted）。

  卡片是**主题无关**的：不按标题猜测提问主题，也不校验答案的领域语义
  （路径是否越界等约束由 Skill 指令承载、由下游落盘入口守边界）。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NTabPane, NTabs } from 'naive-ui'
import {
  INTERACTION_CANCEL_ANSWER,
  type IAgentInteractionOption,
  type IAgentInteractionQuestion,
} from '@authine-e2e-agent/types'
import IconFont from '../../../common/icon/IconFont.vue'
import { INTERACTION_ANSWERED_ICON, INTERACTION_ICON } from '../icons'
import type { IInteractionTimelineItem } from '../timeline'
import {
  buildAskUserQuestionAnswer,
  otherTextError,
  useAskUserQuestionDraft,
} from '../composables/useAskUserQuestionDraft'
import AskUserQuestionAnswer from './AskUserQuestionAnswer.vue'

const props = defineProps<{
  /** 交互块时间线项。 */
  item: IInteractionTimelineItem
}>()

const emit = defineEmits<{
  /**
   * 用户提交回答。
   * 单问题形态为所选选项值或「其它」文本；多问题形态为以 questionId 为键的回答表。
   */
  answer: [interactionId: string, value: string | Record<string, string>]
}>()

/** 等待回答中（服务端 end 事件到达后转为定格展示）。 */
const pending = computed(() => props.item.status === 'pending')

/** 「其它」输入框的缺省占位文案（host 未下发时）。 */
const DEFAULT_PLACEHOLDER = '输入你的回答…'

/** 多问题形态的问题列表（缺省即单问题形态）。 */
const questions = computed<IAgentInteractionQuestion[]>(
  () => props.item.interaction.questions ?? [],
)

/** 是否多问题形态。 */
const isMultiQuestion = computed(() => questions.value.length > 0)

/** 作答草稿：选了什么、能否提交、提交什么，两条形态共用同一套规则。 */
const draft = useAskUserQuestionDraft(questions)

/**
 * 单问题形态的候选项。
 *
 * 「其它」是 host 追加在末尾的固定选项，卡片不做特殊处理——
 * 作答区按 isOther 标记自行展开长文本。
 */
const singleOptions = computed(() => props.item.interaction.options ?? [])

/** 当前激活的 tab（存 questionId 而非下标：题目列表整批到达，语义更稳）。 */
const activeTab = ref('')

/** 已提交但尚未收到 end 事件的冻结态（防重复提交）。 */
const submitted = ref(false)

/**
 * 取某题的候选项。
 *
 * @param questionKey - 题键（单问题形态为 ''）。
 * @returns 该题的候选项；单问题形态回退到顶层的 options。
 * @throws 不抛出异常。
 */
function optionsOf(questionKey: string): IAgentInteractionOption[] {
  const question = questions.value.find(
    (candidate) => candidate.questionId === questionKey,
  )
  return question?.options ?? singleOptions.value
}

/**
 * 取整卡作答的进度与提交条件。
 *
 * 单问题形态恒为 1 题，进度徽标对它没有意义（只显示在多问题形态）。
 */
const totalQuestions = computed(() =>
  isMultiQuestion.value ? questions.value.length : 1,
)
const answeredCount = computed(
  () => totalQuestions.value - draft.remaining.value,
)

/** 提交按钮的禁用原因；为空表示可以提交。 */
const submitHint = computed(() => {
  // 全部选完但「其它」超长：此时坑在内容本身，不是「还没答完」。
  if (draft.remaining.value === 0) return firstInvalidOther()
  if (isMultiQuestion.value) return `还有 ${draft.remaining.value} 题未填完`
  return '请先选择一项'
})

/**
 * 找出第一个「其它」内容超长的题，返回其错误文案。
 *
 * 超长不阻止用户继续编辑，但会挡住提交——否则 2000 字上限只在前端形同虚设。
 *
 * @returns 错误文案；没有超长的题时返回 ''。
 * @throws 不抛出异常。
 */
function firstInvalidOther(): string {
  const keys = isMultiQuestion.value
    ? questions.value.map((question) => question.questionId)
    : ['']
  for (const key of keys) {
    const error = otherTextErrorOf(key)
    if (error) return error
  }
  return ''
}

/**
 * 取某题「其它」输入内容的校验错误。
 *
 * @param questionKey - 题键（单问题形态为 ''）。
 * @returns 错误文案；没有错误时 undefined。
 * @throws 不抛出异常。
 */
function otherTextErrorOf(questionKey: string): string | undefined {
  const selection = draft.selectionOf(questionKey)
  const option = optionsOf(questionKey).find(
    (candidate) => candidate.value === selection,
  )
  return otherTextError(option, draft.otherTextOf(questionKey))
}

/**
 * 提交整卡作答。
 *
 * @returns 无返回值。
 * @throws 不抛出异常（未填完时静默忽略，按钮本应处于禁用态）。
 */
function submit(): void {
  if (submitted.value || submitHint.value !== '') return
  const value = buildAskUserQuestionAnswer(questions.value, draft.answerOf)
  submitted.value = true
  emit('answer', props.item.interaction.interactionId, value)
}

/**
 * 记录某题的作答，并自动切到下一个尚未填完的 tab。
 *
 * 自动换页只在「该题确实填完了」时发生：选中「其它」后还需要输入文本，
 * 此时换页等于把刚展开的输入框藏起来，用户会以为点击没生效。
 * 已填完的题不参与轮转，因此不会把用户从当前题上推走——例如回头改答第一题时，
 * 下一题已填完，焦点仍留在第一题。
 *
 * @param questionKey - 题键（单问题形态为 ''）。
 * @param value - 所选选项值（「其它」为哨兵值）。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function selectOption(questionKey: string, value: string): void {
  draft.setSelection(questionKey, value)
  if (!draft.isAnswered(questionKey)) return

  const following = questions.value.find(
    (question) =>
      question.questionId !== questionKey &&
      !draft.isAnswered(question.questionId),
  )
  if (following) activeTab.value = following.questionId
}

// 初始定位到第一题（多问题形态的 tab 需要有一个合法的激活值）。
watch(
  questions,
  (list) => {
    if (
      list.length > 0 &&
      !list.some((question) => question.questionId === activeTab.value)
    ) {
      activeTab.value = list[0]!.questionId
    }
  },
  { immediate: true },
)

/**
 * 定格展示：多问题形态逐题展示所选答案（Q6：提交后展示确认结果）。
 */
const answeredRows = computed(() => {
  const answer = props.item.answer
  if (typeof answer !== 'object' || answer === null) return []
  return questions.value.map((question) => {
    const value = answer[question.questionId] ?? ''
    const option = (question.options ?? []).find(
      (candidate) => candidate.value === value,
    )
    // 「其它」提交的是用户原文，不在选项表里，此时回退展示原文本身。
    return { label: question.label, text: option?.label ?? value }
  })
})

/** 单问题形态的定格文案。 */
const answeredText = computed(() => {
  const answer = props.item.answer
  if (answer === undefined) return ''
  if (answer === INTERACTION_CANCEL_ANSWER) return '已中止'

  const value = typeof answer === 'string' ? answer : ''
  const option = singleOptions.value.find(
    (candidate) => candidate.value === value,
  )
  return `已选择：${option?.label ?? value}`
})
</script>

<template>
  <div class="ask-card" :class="{ pending }">
    <div class="ask-header">
      <IconFont class="ask-icon" :name="INTERACTION_ICON" :size="15" />
      <span class="ask-title">{{ item.interaction.title }}</span>
      <!-- 多问题形态：进度徽标，让用户知道还剩几题 -->
      <span v-if="pending && isMultiQuestion" class="ask-progress">
        {{ answeredCount }} / {{ questions.length }}
      </span>
    </div>
    <p v-if="item.interaction.description" class="ask-description">
      {{ item.interaction.description }}
    </p>

    <!-- 待回答：按形态渲染作答区 -->
    <template v-if="pending">
      <!-- 单问题形态：一组候选，「其它」展开长文本，选完点底部提交 -->
      <AskUserQuestionAnswer
        v-if="!isMultiQuestion"
        :options="singleOptions"
        :placeholder="DEFAULT_PLACEHOLDER"
        :selection="draft.selectionOf('')"
        :other-text="draft.otherTextOf('')"
        :other-error="otherTextErrorOf('')"
        :disabled="submitted"
        @select="(value) => selectOption('', value)"
        @update:other-text="(text) => draft.setOtherText('', text)"
      />

      <!--
        多问题形态：一问一 tab，选完一题自动切到下一道未填的题，底部统一提交。

        tab 上只放「问题 N」，完整题干放在面板顶部：题干由 Agent 生成、长短不可控，
        整句塞进 tab 会把 tab 栏挤到横向滚动（4 题长标题时尤其明显）。作答仍有进度感，
        因为打勾标记在 tab 上。

        每个 pane 上的 `display-directive="show"` 让面板保持挂载（naive-ui 默认按
        v-if 销毁非激活面板）：切走再切回的 tab 不会丢掉已选的候选与「其它」草稿。
        该属性必须写在 pane 上——Tabs 会把每个 pane 的 displayDirective 逐个读取，
        写在 Tabs 上不生效（已核对 naive-ui 2.44 源码 filterMapTabPanes）。
      -->
      <n-tabs
        v-else
        v-model:value="activeTab"
        type="line"
        size="small"
        class="ask-tabs"
      >
        <n-tab-pane
          v-for="(question, index) in questions"
          :key="question.questionId"
          :name="question.questionId"
          display-directive="show"
        >
          <template #tab>
            <span class="ask-tab-label">
              问题 {{ index + 1 }}
              <!-- 已答的题打勾：一眼看出进度（提交前仍可进来改答） -->
              <IconFont
                v-if="draft.isAnswered(question.questionId)"
                class="ask-tab-check"
                :name="INTERACTION_ANSWERED_ICON"
                :size="12"
              />
            </span>
          </template>

          <!-- 完整题干：tab 上放不下，这里是小标题；单问题形态没有 tab，题干由卡片标题承载 -->
          <p class="ask-question-title">{{ question.label }}</p>

          <AskUserQuestionAnswer
            :options="question.options ?? []"
            :placeholder="question.placeholder ?? DEFAULT_PLACEHOLDER"
            :selection="draft.selectionOf(question.questionId)"
            :other-text="draft.otherTextOf(question.questionId)"
            :other-error="otherTextErrorOf(question.questionId)"
            :disabled="submitted"
            @select="(value) => selectOption(question.questionId, value)"
            @update:other-text="
              (text) => draft.setOtherText(question.questionId, text)
            "
          />
        </n-tab-pane>
      </n-tabs>

      <!-- 提交区：作答统一在此落定（提交前可随时切 tab 改答） -->
      <div class="ask-submit">
        <span class="ask-submit-hint">{{ submitHint }}</span>
        <n-button
          class="ask-submit-button"
          size="small"
          type="primary"
          :disabled="submitted || submitHint !== ''"
          @click="submit"
        >
          提交
        </n-button>
      </div>
    </template>

    <!-- 已回答：定格展示结果 -->
    <div v-else class="ask-answered">
      <template v-if="isMultiQuestion && answeredRows.length > 0">
        <p
          v-for="row in answeredRows"
          :key="row.label"
          class="ask-answered-row"
        >
          {{ row.label }}：{{ row.text }}
        </p>
      </template>
      <template v-else>{{ answeredText }}</template>
      <span v-if="item.answeredBy === 'aborted'" class="ask-answered-by"
        >（会话已中止）</span
      >
      <span v-else-if="item.answeredBy === 'timeout'" class="ask-answered-by"
        >（超时）</span
      >
    </div>
  </div>
</template>

<style scoped>
.ask-card {
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-surface);
  padding: 14px 16px;
  transition: border-color var(--motion-fast) var(--ease-out);
}
/*
  等待回答：高亮边框 + 左侧警示条，提示这轮工作正卡在用户输入上。

  警示条用 **inset 阴影**画，不用绝对定位的伪元素：伪元素要自带圆角才能贴合卡片，
  而 3px 宽的元素上 12px 圆角会被浏览器按「半径不得超出短边一半」等比压到 3px，
  于是它的方角从卡片 12px 的圆角里**探出去**（顶部一截方角看着像长歪了）。
  inset 阴影沿卡片自身的圆角绘制，且不占布局、不推挤内容。
*/
.ask-card.pending {
  border-color: var(--color-warning);
  background: #fffdf7;
  box-shadow:
    inset 3px 0 0 var(--color-warning),
    0 0 0 3px rgb(240 160 32 / 15%);
}
.ask-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-ink-deep);
}
/* 不声明 color：继承 .ask-header 的墨色（字号走 size prop） */
.ask-icon {
  flex-shrink: 0;
}
.ask-progress {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-ink-muted);
  font-variant-numeric: tabular-nums;
}
.ask-description {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-ink-body);
  white-space: pre-wrap;
}
.ask-tabs {
  margin-top: 4px;
}
/* pane 内首个元素自带 margin-top，这里不重复留白 */
.ask-tabs :deep(.n-tab-pane) {
  padding-top: 0;
}
.ask-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
/* 完整题干：作答区的小标题（tab 上只显示「问题 N」） */
.ask-question-title {
  margin: 10px 0 0;
  color: var(--color-ink-deep);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}
/* 颜色继承 .ask-tab-label（选中 tab 时是主题色，未选中是弱化墨色） */
.ask-tab-check {
  flex-shrink: 0;
}

/*
  提交区：提示在左、按钮在右。

  单独一条上分割线：作答区（含「其它」输入框）到卡片底部之间需要有明确的分界，
  否则提交按钮会看上去像是最后一个候选项。
*/
.ask-submit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
}
.ask-submit-hint {
  min-width: 0;
  overflow: hidden;
  color: var(--color-ink-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ask-submit-button {
  flex-shrink: 0;
}

.ask-answered {
  margin-top: 10px;
  font-size: 13px;
  color: var(--color-action-ink);
  font-weight: 600;
}
.ask-answered-row {
  margin: 0 0 4px;
}
.ask-answered-by {
  color: var(--color-ink-muted);
  font-weight: 400;
}
</style>
