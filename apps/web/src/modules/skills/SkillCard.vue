<!-- 单个 Skill 卡片：以卡片网格形式承载标题、版本、描述与元数据，提供键盘导航和整卡打开。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'
import type { ISkillSummary } from '@charlie_deng/e2e-assistant-types'

const props = defineProps<{
  skill: ISkillSummary
}>()

const emit = defineEmits<{
  open: [skillId: string]
  remove: [skillId: string]
}>()

const accessibleLabel = computed(() => `打开 Skill：${props.skill.title}`)

/**
 * 打开当前 Skill。
 * @returns 事件发送后无返回值。
 * @throws 不抛出异常。
 */
function openSkill(): void {
  emit('open', props.skill.id)
}

/**
 * 请求删除当前 Skill（停止事件冒泡，避免触发卡片「打开」）。
 * @returns 事件发送后无返回值。
 * @throws 不抛出异常。
 */
function removeSkill(): void {
  emit('remove', props.skill.id)
}

/**
 * 将 ISO 时间格式化为卡片中的紧凑日期文本。
 * @param isoTime ISO 时间字符串。
 * @returns 本地日期时间文本。
 * @throws 不抛出异常；无效输入返回短横线。
 */
function formatDisplayTime(isoTime: string): string {
  const timestamp = new Date(isoTime)

  if (Number.isNaN(timestamp.getTime())) {
    return '-'
  }

  return timestamp.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
</script>

<template>
  <article
    class="skill-card"
    role="button"
    tabindex="0"
    :aria-label="accessibleLabel"
    @click="openSkill"
    @keydown.enter="openSkill"
    @keydown.space.prevent="openSkill"
  >
    <div class="skill-card-head">
      <h3 class="skill-card-title">{{ props.skill.title }}</h3>
      <n-tag class="skill-card-tag" size="small" :bordered="false">
        v{{ props.skill.version }}
      </n-tag>
      <button
        class="skill-card-delete"
        type="button"
        :aria-label="`删除 Skill：${props.skill.title}`"
        :title="`删除 Skill：${props.skill.title}`"
        :tabindex="props.skill.id ? 0 : -1"
        @click.stop="removeSkill"
        @keydown.enter.stop
        @keydown.space.stop
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M5.5 1.75a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75V2.5h2.75a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5.5V1.75Zm-2 3h9a.75.75 0 0 1 .75.75v7.25A2.25 2.25 0 0 1 11 15H5A2.25 2.25 0 0 1 2.75 12.75V5.5a.75.75 0 0 1 .75-.75ZM6.5 7.5a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0V7.5Zm4.5 0a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0V7.5Z"
          />
        </svg>
      </button>
    </div>

    <p class="skill-card-description">
      {{
        props.skill.description ||
        '暂未填写描述。打开 Skill 后可补充测试目标和范围。'
      }}
    </p>

    <div class="skill-card-foot">
      <span class="skill-card-id" :title="props.skill.id">{{
        props.skill.id
      }}</span>
      <span class="skill-card-updated"
        >更新于 {{ formatDisplayTime(props.skill.updatedAt) }}</span
      >
      <span class="skill-card-open" aria-hidden="true">›</span>
    </div>
  </article>
</template>

<style scoped>
.skill-card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 168px;
  padding: var(--space-lg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  cursor: pointer;
  transition:
    border-color var(--motion-standard) var(--ease-out),
    box-shadow var(--motion-standard) var(--ease-out),
    transform var(--motion-standard) var(--ease-out);
}

.skill-card:hover {
  border-color: rgb(59 130 246 / 55%);
  box-shadow: var(--shadow-interactive);
  transform: translateY(-2px);
}

.skill-card:focus-visible {
  outline: none;
  border-color: var(--color-review);
  box-shadow: var(--focus-ring), var(--shadow-interactive);
}

.skill-card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-sm);
  padding-right: 28px;
}

.skill-card-title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--color-ink-deep);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.45;
  text-overflow: ellipsis;
  text-wrap: balance;
  white-space: nowrap;
}

.skill-card-tag {
  flex: 0 0 auto;
}

.skill-card-delete {
  position: absolute;
  top: var(--space-md);
  right: var(--space-md);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-ink-muted);
  cursor: pointer;
  opacity: 0;
  transition:
    color var(--motion-fast) var(--ease-out),
    opacity var(--motion-fast) var(--ease-out),
    transform var(--motion-fast) var(--ease-out);
}

.skill-card:hover .skill-card-delete,
.skill-card:focus-within .skill-card-delete {
  opacity: 1;
}

.skill-card-delete:hover {
  /* 悬停删除按钮：不加背景色，仅将图标变红并放大到 1.25 倍 */
  color: var(--color-danger);
  transform: scale(1.25);
}

.skill-card-description {
  display: -webkit-box;
  flex: 1;
  margin: var(--space-md) 0 0;
  overflow: hidden;
  color: var(--color-ink-body);
  font-size: 14px;
  line-height: 1.6;
  text-wrap: pretty;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.skill-card-foot {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-md);
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
}

.skill-card-id {
  min-width: 0;
  overflow: hidden;
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-card-updated {
  flex: 0 0 auto;
  margin-left: auto;
  white-space: nowrap;
}

.skill-card-open {
  color: var(--color-ink-muted);
  font-size: 18px;
  line-height: 1;
  transition:
    color var(--motion-fast) var(--ease-out),
    transform var(--motion-fast) var(--ease-out);
}

.skill-card:hover .skill-card-open,
.skill-card:focus-visible .skill-card-open {
  color: var(--color-review);
  transform: translateX(2px);
}

@media (max-width: 420px) {
  .skill-card {
    min-height: 0;
    padding: var(--space-md);
  }

  .skill-card-description {
    flex: none;
    -webkit-line-clamp: 2;
  }

  .skill-card-foot {
    flex-wrap: wrap;
  }

  .skill-card-updated {
    margin-left: 0;
  }
}
</style>
