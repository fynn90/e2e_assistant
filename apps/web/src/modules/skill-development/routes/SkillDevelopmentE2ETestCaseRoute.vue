<!-- Skill 开发结构化 E2E 子路由：适配共享工作区状态到结构化编辑器。 -->
<script setup lang="ts">
import { onBeforeUnmount, useTemplateRef, watch } from 'vue'
import E2ETestCaseEditor from '../../e2e-test-case/components/E2ETestCaseEditor.vue'
import type { ISkillDevelopmentWorkspaceContext } from '../types'

defineOptions({ name: 'SkillDevelopmentE2ETestCaseRoute' })

const props = defineProps<{
  context: ISkillDevelopmentWorkspaceContext
}>()
const editorRef =
  useTemplateRef<InstanceType<typeof E2ETestCaseEditor>>('editor')

watch(editorRef, (handle) => props.context.registerStructuredEditor(handle), {
  immediate: true,
})

onBeforeUnmount(() => props.context.registerStructuredEditor(null))
</script>

<template>
  <e2-e-test-case-editor
    v-if="props.context.skill.value"
    ref="editor"
    :skill-id="props.context.skill.value.id"
    :chat-ready="props.context.chatReady.value"
    :read-only="props.context.skill.value.readOnly"
    :show-onboarding-hint="props.context.showOnboardingCaseHint.value"
    :env-file-state="props.context.envFileState"
    @dirty-change="props.context.setStructuredDirty"
    @saved="props.context.updateSkillProjection"
    @case-ready="props.context.recordCaseReady(props.context.skill.value.id)"
    @reviewed-script-saved="
      props.context.recordReviewedScriptSaved(props.context.skill.value.id)
    "
    @refresh-tree="props.context.refreshTree"
    @open-raw="props.context.openRawE2ETestCase"
  />
</template>
