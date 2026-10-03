<script setup lang="ts">
/**
 * 全局桌面端自动更新横幅（2026-08-31 收敛自 ControlView）。
 * 任何页面可见：挂载即主动查询（不依赖 Rust 启动事件——懒加载路由会丢事件），
 * 发现新版本显示下载与安装入口。后台检查失败静默，不用底层网络错误打扰用户。
 * 审计 2026-09-05 P2-04：横幅只在桌面壳内渲染；普通浏览器既不检查也不显示，
 * 不会再看到与自己无关的「仅桌面端支持自动更新」报错。
 */
import { onMounted } from 'vue'
import { useDesktopUpdater } from '@/composables/useDesktopUpdater'

const {
  availableVersion,
  statusText,
  installing,
  cancelling,
  errorText,
  supported,
  check: checkForUpdate,
  install: installUpdate,
  cancel: cancelUpdate,
} = useDesktopUpdater()

onMounted(() => { if (supported) checkForUpdate(true) })
</script>

<template>
  <div v-if="supported && (availableVersion || errorText)" class="desktop-update-banner tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-3 tw:rounded-md tw:text-primary tw:text-body-sm tw:leading-body">
    <div class="desktop-update-text" role="status">
      <strong v-if="availableVersion">{{ installing ? '正在更新到' : '桌面端新版本' }} {{ availableVersion }}{{ installing ? '' : ' 可用' }}</strong>
      <p v-if="statusText" class="desktop-update-progress">{{ statusText }}</p>
      <p v-if="errorText" class="desktop-update-error" role="alert">更新失败：{{ errorText }}</p>
    </div>
    <button
      v-if="availableVersion"
      class="btn btn-primary"
      type="button"
      :disabled="cancelling || undefined"
      @click="installing ? cancelUpdate() : installUpdate()"
    >
      {{ cancelling ? '请稍候…' : installing ? '取消更新' : errorText ? '重试下载并安装' : '下载并安装' }}
    </button>
  </div>
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
.desktop-update-banner > button {
  flex-shrink: 0;
}
</style>
