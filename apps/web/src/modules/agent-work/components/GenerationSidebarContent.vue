<!--
  侧边栏内容组装（PRD 5.1 / 5.4）：按发生顺序渲染阶段区块与产物卡片。

  排列顺序（正常流程）：
    ├── 阶段区块：SKILL 阶段
    ├── 产物卡片：SKILL.md
    ├── 阶段区块：Playwright 脚本阶段
    └── 产物卡片：Playwright 脚本

  排列顺序（SKILL 阶段失败）：
    ├── 阶段区块：SKILL 阶段（展示失败摘要）
    └── 终止卡片：错误信息

  **本组件不再有底部操作栏，也没有关闭按钮**（v13 PRD B-1/B-4）：
  销毁内容的入口是抽屉底部的「清空」，位于 `GlobalChatDrawer` 而非本组件——
  它是工作台级动作（对执行工作项同样适用），不属于生成内容。
  **没有自由对话输入区**（PRD 2.2 / AC-12）。

  交互卡片的回答在此收敛为一处 handler：既有 AgentWorkPanel 直接调用
  answerAgentInteraction 而绕过 store action（agent-work store 中没有 answer action），
  本组件保持该策略，但避免在多个卡片中重复实现。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useMessage } from 'naive-ui'
import type { TAgentInteractionAnswer } from '@authine-e2e-agent/types'
import { answerAgentInteraction } from '../../../services/agent-work-api'
import { useGenerationFlowStore } from '../../../stores/generation-flow'
import type { IProductCard } from '../../generation-flow/types'
import StageBlock from './StageBlock.vue'
import SkillDocumentCard from './SkillDocumentCard.vue'
import SkillDocumentCardActions from './SkillDocumentCardActions.vue'
import PlaywrightScriptCard from './PlaywrightScriptCard.vue'
import PlaywrightScriptCardActions from './PlaywrightScriptCardActions.vue'
import StageFailureCard from './StageFailureCard.vue'
import StageFailureCardActions from './StageFailureCardActions.vue'

const store = useGenerationFlowStore()
const message = useMessage()

/**
 * 「查看测试脚本」的跳转由宿主提供（本组件不感知路由与显示主体）。
 *
 * 用 emit 而非在此直接跳转：目标 Skill 来自**显示主体**（PRD E-3），
 * 而那属于抽屉的职责；本组件只组装内容。
 */
const emit = defineEmits<{
  /** 用户点击脚本卡片的「查看测试脚本」。 */
  openScript: []
}>()

/** 空态判定（PRD 5.5）。 */
const isEmpty = computed(() => !store.hasFlowData)

/**
 * 提交交互卡片的回答。
 *
 * 交互回答不经归约器：本地 pending 状态由服务端随后下发的
 * interaction.end 事件清除（与 AgentWorkPanel 的策略一致）。
 *
 * @param kind 阶段种类（用于定位该阶段的 Agent 会话）。
 * @param interactionId 交互卡片 ID。
 * @param value 用户回答。
 * @returns 提交完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleAnswer(
  kind: 'skill' | 'script',
  interactionId: string,
  value: TAgentInteractionAnswer,
): Promise<void> {
  const sessionId = store.sessionIdFor(kind)
  if (!sessionId) return

  try {
    await answerAgentInteraction(sessionId, interactionId, value)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '提交回答失败。')
  }
}

/**
 * 由卡片取所属阶段的种类（用于保存状态与交互回答的分派）。
 * @param card 产物卡片。
 * @returns 阶段种类。
 */
function stageKindFor(card: IProductCard): 'skill' | 'script' {
  return card.kind === 'skill-document' ? 'skill' : 'script'
}

// v13：清空与收尾逻辑已移交抽屉底部的「清空」（`GlobalChatDrawer.handleClear`），
// 因为它同时适用于执行工作项，不属于生成内容。本组件不再持有任何关闭入口。
</script>

<template>
  <div class="generation-content">
    <!--
      空态在本组件内是**过渡态**：抽屉只在「显示主体为生成」时渲染本组件，
      而主体落地与首个阶段记录建立之间有一个极短的窗口（PRD C-2 的启动瞬间）。
      工作台的整体空态（无主体）由抽屉自己渲染。
    -->
    <div v-if="isEmpty" class="generation-empty">
      <n-empty description="正在准备生成…">
        <template #extra>
          <p class="empty-hint">生成过程将在这里实时展示。</p>
        </template>
      </n-empty>
    </div>

    <div v-else class="generation-items">
      <template v-for="item in store.sidebarItems" :key="item.key">
        <!-- 阶段区块：承载过程，可折叠；终态自动折叠 -->
        <StageBlock
          v-if="item.kind === 'stage'"
          :stage="item.stage"
          @cancel="store.cancelStage(item.stage.kind)"
          @answer="(id, value) => handleAnswer(item.stage.kind, id, value)"
        />

        <!-- SKILL.md 产物卡片：承载结果，不可折叠 -->
        <SkillDocumentCard
          v-else-if="
            item.kind === 'card' && item.card.kind === 'skill-document'
          "
          :card="item.card"
          :save-error-message="store.saveErrorMessageFor(item.card.key)"
          :on-retry-save="() => store.retrySave(item.card.key)"
          :on-reload="() => store.reloadCard(item.card.key)"
          @content-change="store.updateCardContent(item.card.key, $event)"
        >
          <template #actions>
            <SkillDocumentCardActions
              :primary-action="store.primaryActionFor(item.card)"
              :primary-disabled="store.isRunning"
              @generate-script="store.startScriptGeneration()"
            />
          </template>
        </SkillDocumentCard>

        <!-- Playwright 脚本产物卡片 -->
        <PlaywrightScriptCard
          v-else-if="
            item.kind === 'card' && item.card.kind === 'playwright-script'
          "
          :card="item.card"
          :existing-code="store.scriptExistingCode()"
          :save-error-message="store.saveErrorMessageFor(item.card.key)"
          :on-retry-save="() => store.retrySave(item.card.key)"
          :on-reload="() => store.reloadCard(item.card.key)"
          @code-change="store.updateCardContent(item.card.key, $event)"
        >
          <template #actions>
            <PlaywrightScriptCardActions
              :version="item.card.meta.version"
              @open-script="emit('openScript')"
            />
          </template>
        </PlaywrightScriptCard>

        <!-- 终止卡片：阶段失败或被用户停止 -->
        <StageFailureCard v-else-if="item.kind === 'failure'" :card="item.card">
          <template #actions>
            <StageFailureCardActions />
          </template>
        </StageFailureCard>
      </template>
    </div>
  </div>
</template>

<style scoped>
.generation-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-card);
}

.generation-items {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
}

.generation-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--space-page);
}

.empty-hint {
  max-width: 360px;
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}
</style>
