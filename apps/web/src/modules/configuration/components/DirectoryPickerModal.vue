<!-- 目录选择弹窗：逐层浏览本机目录，展示空目录与可用性标记，并支持新建文件夹。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NInput,
  NModal,
  NSpace,
  NSpin,
  NTag,
} from 'naive-ui'
import { useDirectoryBrowser } from '../composables/useDirectoryBrowser'
import {
  buildDirectoryBreadcrumbs,
  joinDirectoryPath,
  validateAbsoluteDirectoryPath,
} from '../utils/directory-path'

const props = withDefaults(
  defineProps<{
    show: boolean
    /** 当前已选目录路径，用于打开弹窗时定位。 */
    selectedPath?: string
    /** 是否要求所选目录为空目录（首次初始化场景）。 */
    requireEmpty?: boolean
  }>(),
  {
    selectedPath: '',
    requireEmpty: false,
  },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  confirm: [directoryPath: string]
}>()

const {
  currentListing,
  loading,
  errorMessage,
  browseRoots,
  open,
  navigateTo,
  navigateUp,
  createFolder,
} = useDirectoryBrowser()
const addressInput = ref('')
const addressErrorMessage = ref('')
const creatingFolder = ref(false)
const newFolderName = ref('')

const breadcrumbs = computed(() =>
  currentListing.value
    ? buildDirectoryBreadcrumbs(currentListing.value.currentPath)
    : [],
)
const canConfirm = computed(
  () => currentListing.value?.currentWritable === true,
)
/** 是否可以跳转到当前路径所在的文件系统根；已在根目录时为 false。 */
const canJumpToRoot = computed(() => {
  const listing = currentListing.value

  return (
    Boolean(listing?.rootPath) && listing?.rootPath !== listing?.currentPath
  )
})
/** 文件系统根的名称：Windows 称盘符根，macOS/Linux 称根目录。 */
const rootJumpLabel = computed(() => {
  const rootPath = currentListing.value?.rootPath ?? ''

  return /^[A-Za-z]:/.test(rootPath) ? '盘符根' : '根目录'
})
/** 地址栏输入框的透传属性，用于提供可访问名称。 */
const addressInputProps = {
  'aria-label': '目录路径',
} as const
/** 无法确认选择时的原因说明；为空表示当前目录可直接使用。 */
const blockingReason = computed(() => {
  if (!currentListing.value) {
    return '请先选择一个目录。'
  }

  if (!currentListing.value.currentWritable) {
    return '当前目录没有写入权限，无法保存配置。'
  }

  return ''
})
/** 当前目录是否因非空而不满足初始化要求。 */
const violatesEmptyRequirement = computed(
  () => props.requireEmpty && currentListing.value?.currentEmpty === false,
)

// 每次打开弹窗都重新定位，避免展示上一次的过期浏览结果。
watch(
  () => props.show,
  (visible) => {
    if (!visible) {
      return
    }

    addressInput.value = props.selectedPath
    creatingFolder.value = false
    newFolderName.value = ''
    void open(props.selectedPath)
  },
)

// 导航后同步地址栏，使用户始终看到当前所在路径。
watch(
  () => currentListing.value?.currentPath,
  (currentPath) => {
    if (currentPath) {
      addressInput.value = currentPath
    }
  },
)

/**
 * 关闭弹窗。
 * @returns 关闭完成后无返回值。
 * @throws 不抛出异常。
 */
function closeModal(): void {
  emit('update:show', false)
}

/**
 * 跳转到地址栏中输入的路径。
 *
 * 先在本地拒绝相对路径并给出即时提示，避免用户看到一次无意义的往返请求。
 *
 * @returns 跳转完成后无返回值。
 * @throws 不抛出异常，失败原因写入地址栏提示或浏览状态。
 */
async function jumpToAddress(): Promise<void> {
  const validationResult = validateAbsoluteDirectoryPath(addressInput.value)

  if (!validationResult.valid) {
    addressErrorMessage.value = validationResult.message
    return
  }

  addressErrorMessage.value = ''
  await navigateTo(addressInput.value.trim())
}

/**
 * 进入指定子目录。
 * @param directoryPath 目标子目录绝对路径。
 * @returns 进入完成后无返回值。
 * @throws 不抛出异常，失败原因由浏览状态展示。
 */
async function enterDirectory(directoryPath: string): Promise<void> {
  await navigateTo(directoryPath)
}

/**
 * 确认选择当前目录并关闭弹窗。
 * @returns 确认完成后无返回值。
 * @throws 不抛出异常。
 */
function confirmSelection(): void {
  const currentPath = currentListing.value?.currentPath

  if (!currentPath || !canConfirm.value) {
    return
  }

  emit('confirm', currentPath)
  emit('update:show', false)
}

/**
 * 在当前目录下新建文件夹。
 * @returns 创建完成后无返回值。
 * @throws 不抛出异常，失败原因由浏览状态展示。
 */
async function submitNewFolder(): Promise<void> {
  const folderName = newFolderName.value.trim()

  if (!folderName) {
    return
  }

  const created = await createFolder(folderName)

  if (created) {
    newFolderName.value = ''
    creatingFolder.value = false
  }
}

/**
 * 生成子目录的完整路径提示文本，用于鼠标悬停查看。
 * @param name 子目录名称。
 * @returns 子目录完整路径；无当前目录时返回名称本身。
 * @throws 不抛出异常。
 */
function describeEntryPath(name: string): string {
  const currentPath = currentListing.value?.currentPath

  return currentPath ? joinDirectoryPath(currentPath, name) : name
}
</script>

<template>
  <n-modal
    :show="props.show"
    role="dialog"
    aria-modal="true"
    @update:show="(val) => emit('update:show', val)"
  >
    <n-card
      style="width: min(680px, calc(100vw - 32px))"
      title="选择项目目录"
      :bordered="false"
      size="huge"
      role="dialog"
      aria-modal="true"
    >
      <div class="picker-body">
        <n-alert v-if="errorMessage" type="warning" :show-icon="false">
          {{ errorMessage }}
        </n-alert>

        <div class="address-row">
          <span class="field-label">目录路径</span>
          <div class="address-controls">
            <!-- n-input 会把 id 渲染到外层容器上，因此通过 inputProps 把标识透传到真正的输入框，
                 保证可访问名称可被屏幕阅读器与测试定位到 -->
            <n-input
              v-model:value="addressInput"
              placeholder="可直接粘贴绝对路径，例如 D:\workspace"
              :disabled="loading"
              :input-props="addressInputProps"
              @keyup.enter="jumpToAddress"
              @update:value="addressErrorMessage = ''"
            />
            <n-button :disabled="loading" @click="jumpToAddress">跳转</n-button>
            <n-button
              :disabled="loading || !currentListing?.parentPath"
              @click="navigateUp()"
            >
              上一级
            </n-button>
            <n-button
              :disabled="loading || !canJumpToRoot"
              @click="enterDirectory(currentListing?.rootPath ?? '')"
            >
              {{ rootJumpLabel }}
            </n-button>
          </div>
          <!-- 地址格式提示只约束这一行输入，因此就近展示而不占用顶部告警位 -->
          <p v-if="addressErrorMessage" class="address-error" role="alert">
            {{ addressErrorMessage }}
          </p>
        </div>

        <div v-if="browseRoots.length > 0" class="roots-row">
          <span class="field-label">起始位置</span>
          <div class="roots-list">
            <n-button
              v-for="rootPath in browseRoots"
              :key="rootPath"
              size="small"
              secondary
              :disabled="loading"
              @click="enterDirectory(rootPath)"
            >
              {{ rootPath }}
            </n-button>
          </div>
        </div>

        <nav
          v-if="breadcrumbs.length > 0"
          class="breadcrumbs"
          aria-label="目录层级"
        >
          <template
            v-for="(breadcrumb, index) in breadcrumbs"
            :key="breadcrumb.path"
          >
            <span
              v-if="index > 0"
              class="breadcrumb-separator"
              aria-hidden="true"
              >/</span
            >
            <n-button
              text
              size="small"
              class="breadcrumb-item"
              :disabled="loading"
              @click="enterDirectory(breadcrumb.path)"
            >
              {{ breadcrumb.label }}
            </n-button>
          </template>
        </nav>

        <div class="directory-panel">
          <div v-if="loading" class="directory-loading">
            <n-spin size="small" />
          </div>

          <n-empty
            v-else-if="
              !currentListing || currentListing.directories.length === 0
            "
            size="small"
            class="directory-empty"
            description="当前目录下没有子目录，可直接选择此目录。"
          />

          <ul v-else class="directory-list">
            <li
              v-for="directoryEntry in currentListing.directories"
              :key="directoryEntry.absolutePath"
            >
              <button
                type="button"
                class="directory-item"
                :disabled="!directoryEntry.accessible || loading"
                :title="describeEntryPath(directoryEntry.name)"
                @click="enterDirectory(directoryEntry.absolutePath)"
              >
                <span class="directory-name">{{ directoryEntry.name }}</span>
                <span class="directory-tags">
                  <n-tag v-if="directoryEntry.empty" size="small" type="success"
                    >空目录</n-tag
                  >
                  <n-tag v-if="directoryEntry.symbolicLink" size="small"
                    >快捷方式</n-tag
                  >
                  <n-tag
                    v-if="!directoryEntry.accessible"
                    size="small"
                    type="error"
                    >无权限</n-tag
                  >
                </span>
              </button>
            </li>
          </ul>

          <p v-if="currentListing?.truncated" class="truncated-note">
            子目录过多，仅显示前
            {{ currentListing.directories.length }} 项，可通过上方路径直接跳转。
          </p>
        </div>

        <n-alert v-if="blockingReason" type="warning" :show-icon="false">
          {{ blockingReason }}
        </n-alert>
        <n-alert
          v-else-if="violatesEmptyRequirement"
          type="warning"
          :show-icon="false"
        >
          该目录不是空目录，初始化需要选择一个空目录。
        </n-alert>
        <n-alert v-else type="success" :show-icon="false">
          {{
            props.requireEmpty
              ? '该目录为空，可用于项目初始化。'
              : '该目录可用于项目目录。'
          }}
        </n-alert>

        <div v-if="creatingFolder" class="new-folder-row">
          <n-input
            v-model:value="newFolderName"
            placeholder="新文件夹名称"
            :disabled="loading"
            @keyup.enter="submitNewFolder"
          />
          <n-button
            type="primary"
            size="small"
            :disabled="!newFolderName.trim() || loading"
            @click="submitNewFolder"
          >
            创建
          </n-button>
          <n-button
            size="small"
            :disabled="loading"
            @click="creatingFolder = false"
          >
            取消新建
          </n-button>
        </div>
      </div>

      <template #footer>
        <div class="picker-footer">
          <n-button
            v-if="!creatingFolder"
            :disabled="!currentListing || loading"
            @click="creatingFolder = true"
          >
            新建文件夹
          </n-button>
          <span v-else />

          <n-space>
            <n-button @click="closeModal">取消</n-button>
            <n-button
              type="primary"
              :disabled="!canConfirm"
              @click="confirmSelection"
            >
              选择此目录
            </n-button>
          </n-space>
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.picker-body {
  display: grid;
  gap: 14px;
}

.field-label {
  color: var(--color-ink-muted, #64748b);
  font-size: 12px;
  font-weight: 600;
}

.address-row,
.roots-row {
  display: grid;
  gap: 6px;
}

.address-error {
  margin: 0;
  color: #d03050;
  font-size: 12px;
  line-height: 1.5;
}

.address-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.roots-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #f1f5f9;
}

.breadcrumb-item,
.breadcrumb-separator {
  font-size: 12px;
}

.breadcrumb-separator {
  color: #94a3b8;
}

.directory-panel {
  height: 240px;
  overflow-y: auto;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 8px;
  background: #ffffff;
}

.directory-loading,
.directory-empty {
  padding: 24px;
  text-align: center;
}

.directory-list {
  margin: 0;
  padding: 6px;
  list-style: none;
}

.directory-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #1e293b;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.directory-item:hover:not(:disabled) {
  background: #f1f5f9;
}

.directory-item:disabled {
  color: #94a3b8;
  cursor: not-allowed;
}

.directory-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory-tags {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

.truncated-note {
  margin: 0;
  padding: 8px 12px;
  color: #b45309;
  font-size: 12px;
}

.new-folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.picker-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

@media (max-width: 640px) {
  .directory-item {
    min-height: 44px;
  }

  .address-controls {
    flex-wrap: wrap;
  }
}
</style>
