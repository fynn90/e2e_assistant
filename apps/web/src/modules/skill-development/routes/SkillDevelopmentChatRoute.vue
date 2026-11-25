<!-- Skill 开发 Chat 子路由：适配共享工作区状态到 ChatPanel。 -->
<script setup lang="ts">
import { onBeforeUnmount, useTemplateRef, watch } from 'vue'
import ChatPanel from '../../../common/chat/ChatPanel.vue'
import type { ISkillDevelopmentWorkspaceContext } from '../types'

defineOptions({ name: 'SkillDevelopmentChatRoute' })

const props = defineProps<{
  context: ISkillDevelopmentWorkspaceContext
}>()
const chatPanelRef = useTemplateRef<InstanceType<typeof ChatPanel>>('chatPanel')

watch(chatPanelRef, (handle) => props.context.registerChatPanel(handle), {
  immediate: true,
})

onBeforeUnmount(() => props.context.registerChatPanel(null))
</script>

<template>
  <chat-panel
    ref="chatPanel"
    :model-value="props.context.chatDraft.value"
    :messages="props.context.messages.value"
    :streaming="props.context.streaming.value"
    :disabled="!props.context.chatReady.value"
    :disabled-reason="
      !props.context.chatReady.value
        ? '模型配置无效，请前往系统配置修复后再发送。'
        : undefined
    "
    :dirty-file-notice="
      props.context.dirty.value
        ? '当前文件有未保存修改，Agent 只会看到最近保存版本。'
        : undefined
    "
    @update:model-value="props.context.chatDraft.value = $event"
    @send="props.context.requestSend"
    @stop="props.context.stopChat"
    @retry="props.context.retryChat"
  />
</template>
