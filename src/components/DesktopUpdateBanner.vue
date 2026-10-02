<script setup lang="ts">
/**
 * 全局桌面端自动更新横幅（2026-08-31 收敛自 ControlView）。
 * 任何页面可见：挂载即主动查询（不依赖 Rust 启动事件——懒加载路由会丢事件），
 * 发现新版本显示「一键升级」。后台检查失败静默，不用底层网络错误打扰用户。
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
  <div v-if="supported && (availableVersion || errorText)" class="desktop-update-banner tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:rounded-md tw:text-primary tw:text-body-sm tw:leading-body" role="status">
    <span class="desktop-update-text">
      <template v-if="availableVersion">桌面端新版本 {{ availableVersion }} 可用</template>
      <template v-if="errorText">{{ availableVersion ? ' · ' : '' }}更新失败：{{ errorText }}</template>
      <template v-if="statusText"> · {{ statusText }}</template>
    </span>
    <button
      v-if="availableVersion"
      class="btn btn-primary"
      type="button"
      :disabled="cancelling || undefined"
      @click="installing ? cancelUpdate() : installUpdate()"
    >
      {{ cancelling ? '请稍候…' : installing ? '取消更新' : '一键升级' }}
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
  min-width: 0;
  overflow-wrap: anywhere;
}
.desktop-update-banner > button {
  flex-shrink: 0;
}
</style>
