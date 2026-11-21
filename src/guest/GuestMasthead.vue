<script setup lang="ts">
import { computed } from 'vue'
import BrandLogo from '@/components/BrandLogo.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { GuestTheme } from './guestTheme'

const props = defineProps<{
  checking: boolean
  connected: boolean
  ready: boolean
  theme: GuestTheme
}>()

const emit = defineEmits<{
  reconnect: []
  openHelp: []
  toggleTheme: []
}>()

const connectionState = computed(() => {
  if (props.checking) return 'checking'
  if (props.ready) return 'ready'
  if (props.connected) return 'standby'
  return 'offline'
})

const connectionLabel = computed(() => {
  if (props.checking) return '正在连接…'
  if (props.ready) return '房主画室已就绪'
  if (props.connected) return '画室准备中'
  return '未连接 · 点此重连'
})

const connectionTip = computed(() => {
  if (props.checking) return '正在确认房主的绘图服务状态'
  if (props.ready) return '房主电脑在线且 MiaoMiao Anima 1.6 已就绪，可以开始绘制'
  if (props.connected) return '已连上房主，等待对方开启 MiaoMiao Anima 1.6 出图服务'
  return '点击尝试重新连接房主的画室'
})

const themeLabel = computed(() => (props.theme === 'dark' ? '切换为浅色模式' : '切换为深色模式'))
</script>

<template>
  <header class="guest-masthead">
    <div class="guest-mastheadLeft">
      <BrandLogo class="guest-brand" />
      <span class="guest-mastheadDivider" aria-hidden="true" />
      <span class="guest-mastheadPill">
        <ArchiveIcon name="spark" />好友试玩
      </span>
    </div>

    <div class="guest-mastheadRight">
      <StudioTooltip v-if="connectionState === 'offline'" :content="connectionTip">
        <button
          type="button"
          class="guest-connection"
          :data-state="connectionState"
          @click="emit('reconnect')"
        >
          <span class="guest-connectionDot" aria-hidden="true" />
          <span>{{ connectionLabel }}</span>
        </button>
      </StudioTooltip>
      <StudioTooltip v-else :content="connectionTip">
        <span
          class="guest-connection"
          :data-state="connectionState"
          role="status"
        >
          <span class="guest-connectionDot" aria-hidden="true" />
          <span>{{ connectionLabel }}</span>
        </span>
      </StudioTooltip>

      <button
        class="btn btn-quiet btn-sm"
        type="button"
        @click="emit('openHelp')"
      >
        <ArchiveIcon name="info" />玩法说明
      </button>

      <StudioTooltip :content="themeLabel">
        <button
          class="guest-themeToggle"
          type="button"
          :aria-label="themeLabel"
          :aria-pressed="theme === 'dark'"
          :data-dark="theme === 'dark'"
          @click="emit('toggleTheme')"
        >
          <span class="guest-themeSymbol" aria-hidden="true">
            <ArchiveIcon class="guest-themeSun" name="sun" />
            <ArchiveIcon class="guest-themeMoon" name="moon" />
          </span>
        </button>
      </StudioTooltip>
    </div>
  </header>
</template>
