<!-- 展示首次激活流程的持久化里程碑、当前任务与可选跳过操作。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NTag } from 'naive-ui'
import {
  ONBOARDING_MILESTONE_ORDER,
  getNextOnboardingMilestone,
  type IOnboardingStateV1,
  type TOnboardingMilestone,
} from '../domain/onboarding-state'

const props = withDefaults(
  defineProps<{
    state: IOnboardingStateV1
    compact?: boolean
  }>(),
  {
    compact: false,
  },
)

const emit = defineEmits<{
  dismiss: []
  acknowledgeCompletion: []
}>()

const milestoneCopy: Record<
  TOnboardingMilestone,
  { label: string; guidance: string }
> = {
  'workspace-ready': {
    label: '项目已配置',
    guidance: '平台配置已完成，可以进入真实的 Skill 工作流。',
  },
  'skill-ready': {
    label: 'Skill 已就绪',
    guidance: '创建或打开一个 Skill。结构化测试意图保存在 e2e_schema.json 中。',
  },
  'case-ready': {
    label: '结构化用例已保存',
    guidance: '完成标题、描述、目标 URL 和至少一个启用步骤，然后保存用例。',
  },
  'reviewed-script-saved': {
    label: '脚本已审阅并保存',
    guidance: '生成脚本，检查提示和代码差异，再确认保存 test.spec.ts。',
  },
}

const nextMilestone = computed(() => getNextOnboardingMilestone(props.state))
const completed = computed(() => Boolean(props.state.activationCompletedAt))
const currentGuidance = computed(() => {
  if (completed.value) {
    return '首个 Playwright 脚本已审阅并保存。你可以继续完善用例，或在文件树中检查 test.spec.ts。'
  }

  return nextMilestone.value
    ? milestoneCopy[nextMilestone.value].guidance
    : '继续完成当前 Skill 的结构化用例与脚本审阅。'
})
const liveMessage = ref('')
const mounted = ref(false)

/**
 * 获取指定里程碑的可读状态。
 * @param milestone 待判断的里程碑。
 * @returns “完成”“当前”或“待完成”。
 * @throws 不抛出异常。
 */
function getMilestoneStatus(milestone: TOnboardingMilestone): string {
  if (props.state.milestones[milestone]) {
    return '完成'
  }

  return nextMilestone.value === milestone ? '当前' : '待完成'
}

watch(
  () => props.state.milestones,
  async () => {
    if (!mounted.value) {
      return
    }

    await nextTick()
    liveMessage.value = completed.value
      ? '首次激活流程已完成。'
      : `下一步：${currentGuidance.value}`
  },
  { deep: true },
)

onMounted(() => {
  mounted.value = true
})
</script>

<template>
  <section
    class="onboarding-progress"
    :class="{ 'onboarding-progress--compact': props.compact }"
    aria-labelledby="onboarding-progress-title"
  >
    <div class="progress-heading">
      <div>
        <h2 id="onboarding-progress-title" class="progress-title">
          {{ completed ? '首次脚本已保存' : '完成首次 Playwright 脚本' }}
        </h2>
        <p class="progress-guidance">{{ currentGuidance }}</p>
      </div>
      <n-button
        v-if="completed"
        secondary
        type="primary"
        @click="emit('acknowledgeCompletion')"
      >
        完成引导
      </n-button>
      <n-button v-else quaternary @click="emit('dismiss')">跳过引导</n-button>
    </div>

    <ol class="milestone-list">
      <li
        v-for="milestone in ONBOARDING_MILESTONE_ORDER"
        :key="milestone"
        class="milestone-item"
        :class="{
          'milestone-item--complete': Boolean(
            props.state.milestones[milestone],
          ),
          'milestone-item--current': nextMilestone === milestone,
        }"
        :aria-current="nextMilestone === milestone ? 'step' : undefined"
      >
        <span class="milestone-marker" aria-hidden="true">
          {{
            props.state.milestones[milestone]
              ? '✓'
              : ONBOARDING_MILESTONE_ORDER.indexOf(milestone) + 1
          }}
        </span>
        <span class="milestone-copy">
          <strong>{{ milestoneCopy[milestone].label }}</strong>
          <n-tag
            size="small"
            :type="
              props.state.milestones[milestone]
                ? 'success'
                : nextMilestone === milestone
                  ? 'info'
                  : 'default'
            "
          >
            {{ getMilestoneStatus(milestone) }}
          </n-tag>
        </span>
      </li>
    </ol>

    <p class="scope-note">
      当前流程只生成、审阅并保存 Playwright 脚本，不会运行测试。
    </p>
    <p class="visually-hidden" aria-live="polite">{{ liveMessage }}</p>
  </section>
</template>

<style scoped>
.onboarding-progress {
  padding: 16px 18px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
  color: #334155;
  transition:
    border-color 160ms ease-out,
    background-color 160ms ease-out;
}

.progress-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.progress-title {
  margin: 0;
  color: #0f172a;
  font-size: 18px;
  line-height: 1.4;
}

.progress-guidance {
  max-width: 70ch;
  margin: 4px 0 0;
  color: #334155;
  line-height: 1.6;
}

.milestone-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
}

.milestone-item {
  display: flex;
  align-items: center;
  flex: 1 1 210px;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.milestone-item--current {
  border-color: #3b82f6;
  background: color-mix(in srgb, #3b82f6 8%, #ffffff);
}

.milestone-item--complete {
  border-color: color-mix(in srgb, #18a058 42%, #ffffff);
  background: color-mix(in srgb, #18a058 8%, #ffffff);
}

.milestone-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #e2e8f0;
  color: #334155;
  font-size: 12px;
  font-weight: 700;
}

.milestone-item--current .milestone-marker {
  background: #3b82f6;
  color: #fff;
}

.milestone-item--complete .milestone-marker {
  background: #18a058;
  color: #fff;
}

.milestone-copy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.milestone-copy strong {
  color: #334155;
  font-size: 13px;
}

.scope-note {
  margin: 12px 0 0;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.onboarding-progress--compact {
  padding: 10px 14px;
  border-width: 0 0 1px;
  border-radius: 0;
}

.onboarding-progress--compact .progress-title {
  font-size: 14px;
}

.onboarding-progress--compact .progress-guidance,
.onboarding-progress--compact .scope-note {
  font-size: 12px;
}

.onboarding-progress--compact .milestone-list {
  margin-top: 10px;
}

.onboarding-progress--compact .milestone-item {
  flex-basis: 170px;
  padding: 7px 9px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 720px) {
  .progress-heading {
    flex-direction: column;
  }

  .progress-heading :deep(.n-button) {
    min-height: 42px;
  }

  .milestone-list {
    flex-direction: column;
  }

  .milestone-item {
    flex-basis: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .onboarding-progress {
    transition: none;
  }
}
</style>
