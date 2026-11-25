<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import MediaPacksOnboardingProgress from '@/components/MediaPacksOnboardingProgress.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useFluidDialog, isBackdropClick } from '@/composables/useFluidDialog'
import { formatPackBytes, useMediaPacks } from '@/composables/useMediaPacks'
import { hasResourceAssistant, openResourceAssistant } from '@/platform/desktop/resourceAssistant'

const titleId = useId()
const progressId = useId()
const dialogRef = ref<HTMLDialogElement | null>(null)
const progressPanel = ref<InstanceType<typeof MediaPacksOnboardingProgress> | null>(null)
const fluid = useFluidDialog(dialogRef)
const desktopAssistant = hasResourceAssistant()
const selectedMode = ref<'full' | 'lite'>('full')

const {
  status,
  busy,
  task,
  error,
  portraitsPack,
  showcasePack,
  onboardingVisible,
  retain,
  release,
  installPreset,
  cancel,
  dismissOnboarding,
  closeOnboarding,
} = useMediaPacks()

const portraitsBytes = computed(() => portraitsPack.value?.remote.bytes || 436_500_000)
const showcaseBytes = computed(() => showcasePack.value?.remote.bytes || 1_650_000_000)
const fullBytes = computed(() => {
  let sum = 0
  if (!portraitsPack.value?.installed) sum += portraitsBytes.value
  if (!showcasePack.value?.installed) sum += showcaseBytes.value
  return sum || portraitsBytes.value + showcaseBytes.value
})
const liteBytes = computed(() => portraitsBytes.value)

const progressValue = computed<number | undefined>(() => {
  const current = task.value
  if (!current) return undefined
  if (current.phase === 'extracting' && current.filesTotal > 0) {
    return Math.min(100, Math.round((current.filesDone / current.filesTotal) * 100))
  }
  if (current.phase === 'downloading' && current.total > 0) {
    return Math.min(100, Math.round((current.bytes / current.total) * 100))
  }
  return undefined
})

const activePackLabel = computed(() => {
  if (task.value?.packId === 'portraits') return '人物高清立绘包'
  if (task.value?.packId === 'showcase') return '场景样张资源库'
  return '资源包'
})

const isRunning = computed(() => task.value?.state === 'running' || task.value?.state === 'cancelling')

function syncDialog(visible: boolean) {
  const el = dialogRef.value
  if (!el) return
  if (visible) {
    if (!el.open) fluid.open()
  } else if (el.open) {
    fluid.close()
  }
}

watch(onboardingVisible, visible => syncDialog(visible))
watch(() => task.value?.state, state => {
  if (state === 'completed' && onboardingVisible.value) closeOnboarding()
})
watch(isRunning, async running => {
  if (!running || !dialogRef.value?.contains(document.activeElement)) return
  await nextTick()
  if (dialogRef.value?.open && document.activeElement === document.body) {
    progressPanel.value?.focusBackgroundButton()
  }
})

function dismissOrBackground() {
  if (isRunning.value) closeOnboarding()
  else void dismissOnboarding()
}

function onDialogClose() {
  if (dialogRef.value) dialogRef.value.returnValue = ''
  if (onboardingVisible.value) closeOnboarding()
}

function onDialogClick(event: MouseEvent) {
  if (isBackdropClick(event, dialogRef.value)) {
    dismissOrBackground()
  }
}

async function beginSelected() {
  await installPreset(selectedMode.value)
}

async function openOfflineAssistant() {
  closeOnboarding()
  try { await openResourceAssistant() } catch { /* handled in panel */ }
}

onMounted(() => {
  retain()
  if (onboardingVisible.value) syncDialog(true)
})
onUnmounted(() => release())
</script>

<template>
  <dialog
    ref="dialogRef"
    class="media-onboarding-dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="dismissOrBackground"
    @close="onDialogClose"
    @click="onDialogClick"
  >
    <div class="media-onboarding-shell">
      <header class="media-onboarding-head">
        <div>
          <span class="media-onboarding-kicker">首次资源配置</span>
          <h1 :id="titleId">下载绘遇高清图片资源</h1>
          <p class="media-onboarding-sub">
            安装包已精简体积并内置角色缩略图。按需选择要下载的高清资源包，安装完成后也可随时在「控制室 → 资源与素材」补充或清理。
          </p>
        </div>
        <button
          class="media-onboarding-close"
          type="button"
          aria-label="关闭窗口"
          @click="dismissOrBackground"
        >
          <ArchiveIcon name="close" />
        </button>
      </header>

      <MediaPacksOnboardingProgress
        v-if="isRunning"
        ref="progressPanel"
        :task="task"
        :active-pack-label="activePackLabel"
        :progress-value="progressValue"
        :progress-id="progressId"
        @background="closeOnboarding"
        @cancel="cancel"
      />

      <template v-else>
        <fieldset class="media-preset-grid">
          <legend class="media-visually-hidden">资源下载模式</legend>
          <label class="media-preset-card" :class="{ selected: selectedMode === 'full' }" :for="`${titleId}-full`">
            <input :id="`${titleId}-full`" v-model="selectedMode" class="media-visually-hidden" :name="titleId" type="radio" value="full" :aria-labelledby="`${titleId}-full-label`">
            <span class="media-preset-top">
              <strong :id="`${titleId}-full-label`">全量资源包</strong>
              <span class="media-preset-badge">推荐</span>
            </span>
            <span class="media-preset-description">自动下载「人物高清立绘包 + 场景样张资源库」，角色原画欣赏、聊天室立绘与画册样张一步到位。</span>
            <span class="media-preset-meta">
              <span>预计下载 {{ formatPackBytes(fullBytes) }}</span>
              <span>含立绘 + 样张</span>
            </span>
          </label>

          <label class="media-preset-card" :class="{ selected: selectedMode === 'lite' }" :for="`${titleId}-lite`">
            <input :id="`${titleId}-lite`" v-model="selectedMode" class="media-visually-hidden" :name="titleId" type="radio" value="lite" :aria-labelledby="`${titleId}-lite-label`">
            <span class="media-preset-top">
              <strong :id="`${titleId}-lite-label`">精简模式（仅立绘）</strong>
              <span class="media-preset-badge subtle">省空间</span>
            </span>
            <span class="media-preset-description">默认只下载「人物高清立绘包」，节省约 {{ formatPackBytes(showcaseBytes) }} 空间；安装后随时可在控制室补下样张库。</span>
            <span class="media-preset-meta">
              <span>预计下载 {{ formatPackBytes(liteBytes) }}</span>
              <span>{{ portraitsPack?.installed ? '立绘已就绪' : '仅人物立绘' }}</span>
            </span>
          </label>
        </fieldset>

        <p v-if="error || task?.error" class="media-onboarding-error" role="alert">
          <ArchiveIcon name="warning" />
          <span>{{ error || task?.error }}</span>
        </p>

        <footer class="media-onboarding-foot">
          <div class="media-onboarding-secondary">
            <button class="btn btn-ghost" type="button" @click="dismissOnboarding">稍后下载，先逛画室</button>
            <button v-if="desktopAssistant" class="btn btn-ghost" type="button" @click="openOfflineAssistant">
              <ArchiveIcon name="folder" />导入本地离线包
            </button>
          </div>
          <button class="btn btn-primary" type="button" autofocus :disabled="busy" @click="beginSelected">
            <ArchiveIcon name="download" />
            {{ selectedMode === 'full' ? '开始下载全量资源' : '仅下载人物立绘' }}
          </button>
        </footer>
      </template>

      <p v-if="status?.remoteError && !isRunning" class="media-onboarding-hint">
        自动支持 GitHub 与国内镜像加速；如直连较慢，可在「控制室 → 资源与素材」自定义镜像地址。
      </p>
    </div>
  </dialog>
</template>

<style scoped>
.media-onboarding-dialog {
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-xl);
  background: var(--bg-surface);
  color: var(--text-primary);
  max-inline-size: min(680px, calc(100vw - 32px));
  inline-size: 100%;
  box-shadow: var(--shadow-lg);
}
.media-onboarding-dialog[open] {
  display: block;
}
.media-onboarding-dialog:modal {
  overscroll-behavior: contain;
}
.media-onboarding-dialog::backdrop {
  background: var(--bg-scrim, color-mix(in srgb, var(--bg-base) 72%, transparent));
  overflow: hidden;
  overscroll-behavior: contain;
}
.media-onboarding-shell {
  display: grid;
  gap: var(--s-5);
  padding: var(--s-6);
}
.media-onboarding-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
}
.media-onboarding-kicker {
  display: inline-block;
  font-size: var(--fs-label-xs);
  color: var(--accent);
  letter-spacing: 0.02em;
}
.media-onboarding-head h1 {
  margin: var(--s-1) 0 var(--s-2);
  font-size: var(--fs-title);
  line-height: 1.3;
  text-wrap: balance;
}
.media-onboarding-sub {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-label);
  line-height: 1.7;
}
.media-onboarding-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 36px;
  block-size: 36px;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.media-onboarding-close:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}
.media-onboarding-close:focus-visible {
  outline: none;
  box-shadow: var(--focus-shadow);
}
.media-preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-4);
  border: 0;
  padding: 0;
  margin: 0;
  min-inline-size: 0;
}
.media-visually-hidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.media-preset-card {
  position: relative;
  display: grid;
  gap: var(--s-3);
  align-content: start;
  text-align: left;
  padding: var(--s-4);
  border: 1.5px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--bg-deep);
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color 160ms ease, transform 160ms ease;
}
.media-preset-card:hover {
  border-color: var(--border-strong);
}
.media-preset-card.selected {
  border-color: var(--accent);
  background: var(--bg-elevated, var(--bg-deep));
}
.media-preset-card:has(input:focus-visible) {
  outline: none;
  box-shadow: var(--focus-shadow);
}
.media-preset-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}
.media-preset-top strong {
  font-size: var(--fs-body-lg);
}
.media-preset-badge {
  padding: 2px 8px;
  border-radius: var(--r-pill);
  font-size: var(--fs-label-xs);
  color: var(--accent);
  border: 1px solid var(--accent);
}
.media-preset-badge.subtle {
  color: var(--text-secondary);
  border-color: var(--border-strong);
}
.media-preset-description {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-label-sm);
  line-height: 1.65;
}
.media-preset-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--s-2);
  padding-top: var(--s-2);
  border-top: 1px solid var(--border-soft);
  font-size: var(--fs-label-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
@media (prefers-reduced-motion: reduce) {
  .media-preset-card { transition: none; }
}
.media-onboarding-error {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  margin: 0;
  padding: var(--s-3);
  border: 1px solid var(--danger-text);
  border-radius: var(--r-md);
  color: var(--danger-text);
  font-size: var(--fs-label-sm);
  line-height: 1.6;
}
.media-onboarding-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
}
.media-onboarding-secondary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}
.media-onboarding-foot button:disabled {
  color: var(--text-disabled);
  opacity: 1;
}
.media-onboarding-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
  line-height: 1.6;
}
@media (max-width: 640px) {
  .media-preset-grid { grid-template-columns: 1fr; }
  .media-onboarding-shell { padding: var(--s-4); }
}
</style>
