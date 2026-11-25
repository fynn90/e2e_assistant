<!-- 在 E2E 文件版本冲突时比较本地草稿与最新磁盘版本。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NCard, NModal, NSpace } from 'naive-ui'
import type {
  IE2ETestCase,
  IE2ETestCaseDocumentData,
} from '@fynn90-e2e_assistant/types'
import CodeDiffEditor from '../../../common/code/CodeDiffEditor.vue'

const props = defineProps<{
  draft: IE2ETestCase | null
  diskDocument: IE2ETestCaseDocumentData | null
}>()
const emit = defineEmits<{ reload: []; close: [] }>()
const visible = computed(() => Boolean(props.draft && props.diskDocument))
const diskJson = computed(() =>
  props.diskDocument
    ? `${JSON.stringify(props.diskDocument.testCase, null, 2)}\n`
    : '',
)
const draftJson = computed(() =>
  props.draft ? `${JSON.stringify(props.draft, null, 2)}\n` : '',
)
</script>

<template>
  <n-modal :show="visible" :mask-closable="false">
    <n-card title="E2E 用例已在外部修改" class="conflict-card">
      <p>
        左侧是最新磁盘版本，右侧是当前页面草稿。重新加载会放弃当前草稿；关闭对话框会继续保留草稿。
      </p>
      <!-- 弹窗宽度 min(1100px, ...) 足以并排，且文案以「左磁盘 / 右草稿」描述，故显式要求并排 -->
      <code-diff-editor
        :original="diskJson"
        :modified="draftJson"
        language="json"
        mode="sideBySide"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="emit('close')">保留当前草稿</n-button>
          <n-button type="error" secondary @click="emit('reload')"
            >重新加载磁盘版本</n-button
          >
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.conflict-card {
  width: min(1100px, calc(100vw - 32px));
}
p {
  color: #475569;
}
</style>
