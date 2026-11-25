<!--
  AskUserQuestion 卡片中单个问题的作答区（v14 D7/Q19/Q20）。

  与父组件（AskUserQuestion.vue）的分工：
    - 本组件只管「一个问题怎么作答」：候选项点选、选中「其它」时展开长文本；
    - 作答状态（选了什么、能否提交、提交什么）**由父组件持有**（见
      composables/useAskUserQuestionDraft）：本组件通过 `selection` 受控传入，
      点选后只 emit `select` 把值交给父组件，自己不判断何时提交——
      多问题形态要「一题一 tab、全部填完再一起交」，提交时机只有父组件知道。

  版式约定：候选项**一行一项、纵向排列**。候选文案由 Agent 生成，长短不一
  （常见整句），并排横排会让长句难以扫读；且并排的无边框按钮与正文观感雷同，
  「哪段能点」无从判断。故每项为一个带边框的整行方块，左侧有单选圆环作点击提示。

  作答语义（PRD 4.7.1）：点选候选项只是**记录选择**，卡片的提交动作统一由
  底部提交按钮触发（改答不受限——提交前都可以换）；选中「其它」展开长文本输入，
  内容为空或超长时底部提交按钮不可用。输入框旁不再放逐题的小确认按钮，
  避免「点确认 → 再点提交」的两次确认。

  卡片是**主题无关**的：只校验自定义文本「非空、不超长」两条通用约束，
  不解释答案的领域语义（路径规则等由 Skill 指令与下游落盘入口各自承载）。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NInput } from 'naive-ui'
import {
  INTERACTION_OTHER_OPTION_VALUE,
  INTERACTION_OTHER_TEXT_LIMIT,
  type IAgentInteractionOption,
} from '@fynn90-e2e_assistant/types'

const props = defineProps<{
  /** 候选项（host 组装时已在末尾追加固定「其它」）。 */
  options: IAgentInteractionOption[]
  /** 「其它」长文本输入框的占位文案。 */
  placeholder: string
  /** 当前选中的选项值；「其它」哨兵表示展开长文本输入。 */
  selection: string
  /** 「其它」长文本内容（受控）。 */
  otherText: string
  /** 由父组件传下的「其它」校验错误（超长时才有）。 */
  otherError?: string
  /** 整卡已提交：禁用全部交互，避免重复作答。 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 用户点了某个候选项（值可能是「其它」哨兵）。 */
  select: [value: string]
  /** 「其它」长文本内容变化。 */
  'update:otherText': [text: string]
}>()

/** 是否展开「其它」长文本输入（选中 isOther 选项时）。 */
const otherOpen = computed(
  () => props.selection === INTERACTION_OTHER_OPTION_VALUE,
)

/**
 * 选中「其它」但还没填内容：给一句中性的必填提示。
 *
 * 不标红——用户还没动手，不该先指责一次；只有超长（otherError）才是真错误。
 */
const otherHint = computed(() =>
  otherOpen.value && props.otherText.trim().length === 0
    ? '「其它」为必填，填写后方可提交。'
    : '',
)

/**
 * 点选候选项：只记录选择，是否提交由父组件的提交按钮决定。
 *
 * @param option - 被点选的候选项。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function selectOption(option: IAgentInteractionOption): void {
  if (props.disabled) return
  emit('select', option.value)
}
</script>

<template>
  <div class="ask-answer">
    <!--
      候选项列表：一行一项。

      不套 role="radiogroup"：单选语义需要方向键在选项间移动焦点才算完整，
      这里的候选项是普通按钮，逐行保留按钮原生语义更诚实。
    -->
    <div class="ask-options">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="ask-option"
        :class="{ selected: selection === option.value }"
        :disabled="disabled"
        :aria-pressed="selection === option.value"
        @click="selectOption(option)"
      >
        <span class="ask-option-mark" aria-hidden="true" />
        <span class="ask-option-body">
          <span class="ask-option-label">{{ option.label }}</span>
          <span v-if="option.description" class="ask-option-description">
            {{ option.description }}
          </span>
        </span>
      </button>

      <!-- 「其它」输入区：选中「其它」后展开，缩进对齐候选文案，从属关系一目了然 -->
      <div v-if="otherOpen" class="ask-other">
        <n-input
          type="textarea"
          size="small"
          :value="otherText"
          :maxlength="INTERACTION_OTHER_TEXT_LIMIT"
          show-count
          :placeholder="placeholder"
          :disabled="disabled"
          @update:value="emit('update:otherText', $event)"
        />
        <p
          v-if="otherHint || otherError"
          class="ask-other-hint"
          :class="{ 'is-error': Boolean(otherError) }"
          :role="otherError ? 'alert' : undefined"
        >
          {{ otherError || otherHint }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ask-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

/*
  候选项行：整行可点。

  用带边框的方块而不是无边框按钮——后者与正文观感雷同，看不出能点；
  整行铺满也让长候选文案有足够宽度自然折行，不必挤压成多行窄列。
*/
.ask-option {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
  color: var(--color-ink-deep);
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}
.ask-option:hover:not(:disabled) {
  border-color: var(--color-action);
  background: #f5fbf8;
}
.ask-option:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* 选中态：「其它」会停在此态等待输入，普通选项则保留到提交/改选 */
.ask-option.selected {
  border-color: var(--color-action);
  background: #f1f9f4;
  box-shadow: 0 0 0 2px rgb(12 112 62 / 12%);
}

/*
  单选圆环：纯 CSS 绘制，不用字体字形。

  它是表单控件的状态指示而非装饰图标——状态色要跟随 CSS 令牌在悬停/选中间过渡，
  绘成几何图形可免去字形渲染的依赖与对齐偏差。
*/
.ask-option-mark {
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 3px;
  border: 1.5px solid #cbd5e1;
  border-radius: 50%;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background-color var(--motion-fast) var(--ease-out);
}
.ask-option:hover:not(:disabled) .ask-option-mark {
  border-color: var(--color-action);
}
.ask-option.selected .ask-option-mark {
  border-color: var(--color-action);
  background: radial-gradient(
    circle,
    var(--color-action) 0 3.5px,
    transparent 3.5px
  );
}

.ask-option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ask-option-label {
  font-weight: 500;
  word-break: break-word;
}
/* 候选项的补充说明（Agent 可选给出）：弱于主文案一档，避免与候选文案抢读 */
.ask-option-description {
  color: var(--color-ink-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.55;
  word-break: break-word;
}

/* 缩进 12px(行内边距) + 13px(圆环) + 9px(间距)，与上方候选文案左缘对齐 */
.ask-other {
  padding-left: 34px;
}
/* 空文本时是「必填说明」，超长时才升级为错误色（见 otherError） */
.ask-other-hint {
  margin: 6px 0 0;
  color: var(--color-ink-muted);
  font-size: 12px;
}
.ask-other-hint.is-error {
  color: var(--color-danger);
}
</style>
