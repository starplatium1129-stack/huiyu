<script setup lang="ts">
/**
 * 全局桌面端自动更新横幅（2026-08-31 收敛自 ControlView）。
 * 挂载先接续 Rust 当前更新会话，再按需检查新版本。
 * 后台检查失败静默，不用底层网络错误打扰用户。
 * 审计 2026-09-05 P2-04：横幅只在桌面壳内渲染；普通浏览器既不检查也不显示，
 * 不会再看到与自己无关的「仅桌面端支持自动更新」报错。
 */
import { onMounted, onScopeDispose } from 'vue'
import { useDesktopUpdater } from '@/composables/useDesktopUpdater'
import { onDesktopShellMenuAction } from '@/platform/desktop/shell'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'

const {
  availableVersion,
  currentVersion,
  releaseNotes,
  progress,
  statusText,
  installing,
  cancelling,
  canCancel,
  starting,
  checking,
  reminderPending,
  errorText,
  supported,
  check: checkForUpdate,
  install: installUpdate,
  cancel: cancelUpdate,
  remind,
  openReleasePage,
} = useDesktopUpdater()

const checkNow = () => { void checkForUpdate() }
let stopTray: (() => void) | undefined
onMounted(() => {
  if (!supported) return
  window.addEventListener('aics:check-desktop-updates', checkNow)
  stopTray = onDesktopShellMenuAction('check-updates', checkNow)
  void checkForUpdate(true)
})
onScopeDispose(() => {
  window.removeEventListener('aics:check-desktop-updates', checkNow)
  stopTray?.()
})
</script>

<template>
  <section v-if="supported && (availableVersion || installing || checking || statusText || errorText)" class="desktop-update-banner tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-3 tw:rounded-md tw:text-primary tw:text-body-sm tw:leading-body" aria-label="桌面更新">
    <div class="desktop-update-text">
      <p role="status">
        <strong v-if="availableVersion">{{ installing ? '正在更新到' : '可更新至' }} {{ availableVersion }}</strong>
        <strong v-else-if="checking">正在检查更新…</strong>
        <strong v-else>{{ statusText || '桌面更新' }}</strong>
        <span v-if="currentVersion"> · 当前 {{ currentVersion }}</span>
      </p>
      <progress v-if="installing" class="desktop-update-meter" :value="progress ?? undefined" max="1" aria-label="安装包下载进度" />
      <p v-if="statusText && (installing || availableVersion)" class="desktop-update-progress">{{ statusText }}</p>
      <p v-if="errorText" class="desktop-update-error" role="alert">{{ errorText }}</p>
      <details v-if="releaseNotes && !installing">
        <StudioDisclosureSummary>版本更新说明</StudioDisclosureSummary>
        <p class="desktop-update-notes">{{ releaseNotes }}</p>
      </details>
    </div>
    <div class="desktop-update-actions">
      <button v-if="availableVersion || installing || errorText" class="btn btn-primary btn-sm" type="button"
        :disabled="starting || cancelling || checking || reminderPending || (installing && !canCancel)"
        @click="installing ? cancelUpdate() : availableVersion ? installUpdate() : checkForUpdate()">
        {{ starting || cancelling ? '请稍候…' : installing ? canCancel ? '取消更新' : '正在安装…' : checking ? '正在检查…' : !availableVersion ? '重新检查' : errorText ? '重试下载并安装' : '下载并安装' }}
      </button>
      <template v-if="availableVersion && !installing">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="reminderPending || starting" @click="remind('later')">稍后提醒</button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="reminderPending || starting" @click="remind('skip')">跳过此版本</button>
      </template>
      <button v-if="errorText || availableVersion && !installing" class="btn btn-ghost btn-sm" type="button" @click="openReleasePage">在浏览器打开下载页</button>
    </div>
  </section>
</template>

<style scoped>
.desktop-update-banner {
  margin: var(--s-3) var(--s-4) 0;
  padding: var(--s-3) var(--s-4);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
}
.desktop-update-text {
  flex: 1 1 240px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.desktop-update-text p { margin: var(--s-1) 0 0; }
.desktop-update-progress { color: var(--text-secondary); }
.desktop-update-error { color: var(--danger-text); }
.desktop-update-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.desktop-update-meter { display: block; width: min(100%, 24rem); margin-block-start: var(--s-2); accent-color: var(--accent); }
.desktop-update-notes { white-space: pre-wrap; max-block-size: 10rem; overflow: auto; }
.desktop-update-banner .btn:disabled { color: var(--text-disabled); opacity: 1; }
</style>
