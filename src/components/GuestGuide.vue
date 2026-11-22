<template>
  <StudioDialog
    v-if="presented"
    v-model:open="visible"
    title="欢迎来到绘遇"
    size="md"
    close-label="关闭使用引导"
    :described-by="isLocalHost ? undefined : descriptionId"
    borderless-header
    dialog-class="guest-guide-dialog"
    @close="onDialogClose"
  >
    <div class="guest-guide-body">
      <nav class="guest-guide-destinations" aria-label="开始创作">
        <CreationDestinations @navigate="dismiss" />
      </nav>
      <p v-if="!isLocalHost" :id="descriptionId" class="guest-guide-note">生成任务在分享者的电脑上执行。</p>
    </div>

    <template #footer>
      <div class="guest-guide-actions">
        <RouterLink class="btn btn-quiet" to="/guide" @click="dismiss"><span class="studio-control-label">使用指南</span></RouterLink>
        <button
          v-if="isLocalHost"
          ref="setupButton"
          class="btn btn-primary"
          type="button"
          autofocus
          @click="beginSetup"
        >配置绘图</button>
        <button
          ref="dismissButton"
          class="btn"
          :class="isLocalHost ? 'btn-ghost' : 'btn-primary'"
          type="button"
          :autofocus="!isLocalHost || undefined"
          @click="dismiss"
        >
          {{ isLocalHost ? '先浏览' : '开始浏览' }}
        </button>
      </div>
    </template>
  </StudioDialog>
</template>

<script setup lang="ts">
import StudioDialog from '@/components/ui/StudioDialog.vue'
import { defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import { appearanceFocusOrigin } from '@/composables/useDesktopInteraction'
import { settingsRepository, GUEST_GUIDE_DISMISSED_SETTING } from '@/storage/settingsRepository.ts'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { useRouter } from 'vue-router'

const isLocalHost = isLocalStudioHost()
const forcedGuest = new URLSearchParams(window.location.search).get('guest') === '1'
const router = useRouter()
const descriptionId = useId()

/**
 * 首次访问一律展示，文案按本机 / 访客分流（2026-08-30 UX 审计 P1）。
 *
 * 原先这里要求 isNonLocal，而本项目是单人本机部署，条件恒为假——主人自己
 * 反而永远看不到引导。`?guest=1` 保留作「强制再看一次」的开关。
 */
const shouldShow = forcedGuest || (isLocalHost && !settingsRepository.get(GUEST_GUIDE_DISMISSED_SETTING))
const CreationDestinations = defineAsyncComponent(() => import('@/components/home/CreationDestinations.vue'))
const presented = ref(false)
const visible = ref(false)
const dismissButton = ref<HTMLButtonElement | null>(null)
const setupButton = ref<HTMLButtonElement | null>(null)
let openOrigin: HTMLElement | null = null

function openGuide() {
  openOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  presented.value = true
  visible.value = true
}

function beginSetup() {
  dismiss()
  void router.push('/control#control-inference')
}

onMounted(() => {
  if (shouldShow) openGuide()
  window.addEventListener('atelier:welcome', openGuide)
})

onUnmounted(() => window.removeEventListener('atelier:welcome', openGuide))

function persistDismissal() {
  settingsRepository.set(GUEST_GUIDE_DISMISSED_SETTING, true)
}

async function restoreFallbackFocus(origin: HTMLElement | null) {
  await nextTick()
  if (!visible.value && document.activeElement === document.body) {
    appearanceFocusOrigin(origin)?.focus({ preventScroll: true })
  }
}

function dismiss() {
  const origin = openOrigin
  openOrigin = null
  persistDismissal()
  visible.value = false
  void restoreFallbackFocus(origin)
}

function onDialogClose() {
  const origin = openOrigin
  openOrigin = null
  persistDismissal()
  void restoreFallbackFocus(origin)
}
</script>

<style scoped>
.guest-guide-body {
  display: grid;
  gap: var(--s-3);
}

.guest-guide-note {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-label);
  line-height: var(--lh-body);
}

.guest-guide-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--s-2);
  width: 100%;
}

.guest-guide-actions > a {
  margin-inline-end: auto;
}
</style>
