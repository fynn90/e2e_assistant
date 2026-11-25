<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  ref,
  useSlots,
  watch,
} from 'vue'
import { NAlert, NButton, NEmpty } from 'naive-ui'
import type { IChatMessageViewModel } from './types'
import ChatComposer from './ChatComposer.vue'
import ChatMessageList from './ChatMessageList.vue'

const props = defineProps<{
  modelValue: string
  messages: IChatMessageViewModel[]
  streaming: boolean
  disabled?: boolean
  disabledReason?: string
  dirtyFileNotice?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: [content: string]
  stop: []
  retry: [messageId: string]
}>()
const slots = useSlots()
const scrollContainer = ref<HTMLElement | null>(null)
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null)
const pinnedToBottom = ref(true)
const active = ref(true)
const hasMessages = computed(() => props.messages.length > 0)
const hasNotices = computed(() =>
  Boolean(
    props.disabledReason || props.dirtyFileNotice || slots['disabled-action'],
  ),
)
const lastMessageSignature = computed(() => {
  const lastMessage = props.messages.at(-1)
  return lastMessage
    ? `${lastMessage.id}:${lastMessage.content.length}:${lastMessage.status}`
    : ''
})
let scrollFrame = 0

watch(
  () => props.messages.length,
  async (messageCount, previousCount) => {
    if (!active.value || messageCount <= previousCount) {
      return
    }

    pinnedToBottom.value = true
    await nextTick()
    if (active.value) {
      scrollToBottom(prefersReducedMotion() ? 'auto' : 'smooth')
    }
  },
)

watch(lastMessageSignature, async () => {
  if (!active.value || !props.streaming || !pinnedToBottom.value) {
    return
  }

  await nextTick()
  if (active.value) {
    scheduleScrollToBottom()
  }
})

onActivated(async () => {
  active.value = true
  await nextTick()

  if (pinnedToBottom.value) {
    scheduleScrollToBottom()
  }
})
onDeactivated(() => {
  active.value = false
  cancelScheduledScroll()
})
onBeforeUnmount(cancelScheduledScroll)

/**
 * 取消待执行的自动滚动帧，避免缓存停用后操作隐藏 DOM。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function cancelScheduledScroll(): void {
  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame)
    scrollFrame = 0
  }
}

function handleScroll(): void {
  const element = scrollContainer.value

  if (!element) {
    return
  }

  const distanceToBottom =
    element.scrollHeight - element.scrollTop - element.clientHeight
  pinnedToBottom.value = distanceToBottom <= 80
}

function scheduleScrollToBottom(): void {
  if (scrollFrame) {
    return
  }

  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    scrollToBottom('auto')
  })
}

function scrollToBottom(behavior: ScrollBehavior): void {
  const element = scrollContainer.value

  if (!element) {
    return
  }

  element.scrollTo({ top: element.scrollHeight, behavior })
  pinnedToBottom.value = true
}

function focusComposer(): void {
  composerRef.value?.focus()
}

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
}

defineExpose({ focusComposer })
</script>

<template>
  <section
    class="chat-panel"
    :class="{ 'is-empty': !hasMessages, 'has-messages': hasMessages }"
    aria-label="Skill Agent 对话"
  >
    <div
      v-if="hasMessages"
      ref="scrollContainer"
      class="chat-scroll"
      @scroll="handleScroll"
    >
      <div class="chat-column message-column">
        <div v-if="hasNotices" class="chat-notices">
          <n-alert
            v-if="props.disabledReason"
            type="warning"
            :show-icon="false"
          >
            {{ props.disabledReason }}
          </n-alert>
          <n-alert v-if="props.dirtyFileNotice" type="info" :show-icon="false">
            {{ props.dirtyFileNotice }}
          </n-alert>
        </div>

        <chat-message-list
          :messages="props.messages"
          @retry="emit('retry', $event)"
        />
        <div class="bottom-anchor" aria-hidden="true" />
      </div>
    </div>

    <div v-else class="empty-zone">
      <div class="chat-column empty-column">
        <div v-if="hasNotices" class="chat-notices">
          <n-alert
            v-if="props.disabledReason"
            type="warning"
            :show-icon="false"
          >
            {{ props.disabledReason }}
          </n-alert>
          <div v-if="slots['disabled-action']" class="notice-action">
            <slot name="disabled-action" />
          </div>
          <n-alert v-if="props.dirtyFileNotice" type="info" :show-icon="false">
            {{ props.dirtyFileNotice }}
          </n-alert>
        </div>

        <n-empty
          description="与 Agent 讨论当前 Skill。Agent 只提供建议，不会直接修改文件。"
          class="empty-chat"
        />

        <chat-composer
          ref="composerRef"
          :model-value="props.modelValue"
          :disabled="props.disabled"
          :streaming="props.streaming"
          @update:model-value="emit('update:modelValue', $event)"
          @send="emit('send', $event)"
          @stop="emit('stop')"
        />
      </div>
    </div>

    <div v-if="hasMessages" class="composer-zone">
      <div class="chat-column composer-column">
        <n-button
          v-if="!pinnedToBottom"
          class="back-to-bottom"
          size="small"
          secondary
          round
          @click="scrollToBottom(prefersReducedMotion() ? 'auto' : 'smooth')"
        >
          回到底部
        </n-button>
        <chat-composer
          ref="composerRef"
          :model-value="props.modelValue"
          :disabled="props.disabled"
          :streaming="props.streaming"
          @update:model-value="emit('update:modelValue', $event)"
          @send="emit('send', $event)"
          @stop="emit('stop')"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-panel {
  container-name: chat-panel;
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #f8fafc;
}

.chat-column {
  width: 68%;
  max-width: 960px;
  min-width: 0;
  margin-inline: auto;
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.message-column {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 22px 0 12px;
}

.chat-notices {
  display: grid;
  gap: 10px;
  margin-bottom: 16px;
}

.notice-action {
  display: flex;
  justify-content: flex-start;
}

.bottom-anchor {
  width: 100%;
  height: 1px;
  flex: 0 0 auto;
}

.empty-zone {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: center;
  padding: 24px 0;
}

.empty-column {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.empty-chat {
  padding: 6px 0;
}

.composer-zone {
  flex: 0 0 auto;
  padding: 8px 0 calc(15px + env(safe-area-inset-bottom, 0px));
  background: linear-gradient(to bottom, rgba(248, 250, 252, 0), #f8fafc 18px);
}

.composer-column {
  position: relative;
}

.back-to-bottom {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  z-index: 2;
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.12);
}

@container chat-panel (max-width: 780px) {
  .chat-column {
    width: calc(100% - 24px);
  }

  .message-column {
    padding-top: 56px;
  }
}
</style>
