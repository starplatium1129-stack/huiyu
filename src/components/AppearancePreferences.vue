<template>
  <button v-if="!hideTriggers" class="appearance-entry" type="button" @click="launch('appearance')"><ArchiveIcon name="palette" />外观与动态效果</button>
  <button v-if="!hideTriggers" class="appearance-entry" type="button" @click="launch('keyboard')"><ArchiveIcon name="gear" />键盘快捷键 <kbd>F1</kbd></button>
  <Teleport v-if="!launcherOnly" to="body">
    <dialog ref="dialog" class="appearance-dialog" aria-labelledby="appearance-title" @close="restoreFocus" @cancel.prevent="fluidDialog.close()" @click="backdropClose">
      <div class="appearance-heading">
        <div><p class="appearance-eyebrow">让画室适合你</p><h2 id="appearance-title">{{ section === 'keyboard' ? '键盘快捷键' : '外观与动态效果' }}</h2></div>
        <button class="appearance-close" type="button" aria-label="关闭" @click="fluidDialog.close()"><ArchiveIcon name="close" /></button>
      </div>
      <div v-if="section === 'appearance'" class="appearance-fields">
        <label>画室主题<select :value="themeMode" @change="setThemeMode(($event.target as HTMLSelectElement).value as 'system' | 'light' | 'dark')"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
        <label>动态效果<select :value="motionMode" @change="setMotionMode(($event.target as HTMLSelectElement).value as 'system' | 'full' | 'reduce')"><option value="system">跟随系统</option><option value="full">完整动效</option><option value="reduce">减少动态效果</option></select></label>
        <GlassMaterialChoice v-if="materialControlsReady" />
        <label v-if="zoomAvailable">界面缩放 · {{ Math.round(zoom * 100) }}%<input type="range" min="75" max="200" step="5" :value="zoom * 100" aria-label="界面缩放" @input="setZoom(Number(($event.target as HTMLInputElement).value) / 100)"><button class="btn btn-ghost" type="button" @click="setZoom(1)">恢复 100%</button></label>
        <p v-if="zoomError" role="status">{{ zoomError }}</p>
        <label class="appearance-check"><input type="checkbox" :checked="reducedGlass" @change="setReducedGlass(($event.target as HTMLInputElement).checked)"><span>降低玻璃效果<small>使用更稳定的底色，减少透光与背景干扰。</small></span></label>
        <p class="appearance-note">偏好自动保存在此设备。系统开启减少透明度或高对比度时，会自动降低玻璃效果。</p>
      </div>
      <dl v-else class="appearance-shortcuts">
        <div><dt><kbd>F6</kbd> / <kbd>Shift F6</kbd></dt><dd>在导航与内容之间切换</dd></div>
        <div><dt><kbd>←</kbd> <kbd>→</kbd> / <kbd>Home</kbd> <kbd>End</kbd></dt><dd>主导航内移动焦点</dd></div>
        <div><dt><kbd>Enter</kbd></dt><dd>打开聚焦的导航页面</dd></div>
        <div><dt><kbd>Ctrl / ⌘ K</kbd></dt><dd>搜索页面、场景与作品</dd></div>
        <div><dt><kbd>Tab</kbd> / <kbd>Shift Tab</kbd></dt><dd>依次访问操作与表单</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>关闭当前弹窗</dd></div>
        <div><dt><kbd>Ctrl + / − / 0</kbd></dt><dd>{{ zoomAvailable ? '界面缩放 / 恢复 100%（自动保存）' : '浏览器缩放 / 恢复 100%' }}</dd></div>
      </dl>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { defineAsyncComponent, nextTick, onMounted, onUnmounted, ref } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
const GlassMaterialChoice = defineAsyncComponent(() => import('./GlassMaterialChoice.vue'))
import { usableFocus, useDesktopPreferences } from '@/composables/useDesktopInteraction'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useDesktopZoom } from '@/composables/useDesktopZoom'
import '@/assets/css/appearance-preferences.css'
const emit = defineEmits<{ open: [] }>()
const props = withDefaults(defineProps<{ launcherOnly?: boolean; hideTriggers?: boolean }>(), { launcherOnly: false, hideTriggers: false })
const { themeMode, motionMode, reducedGlass, setThemeMode, setMotionMode, setReducedGlass } = useDesktopPreferences()
const dialog = ref<HTMLDialogElement | null>(null)
const fluidDialog = useFluidDialog(dialog)
const { available: zoomAvailable, zoom, error: zoomError, setZoom } = useDesktopZoom()
const section = ref<'appearance' | 'keyboard'>('appearance')
const materialControlsReady = ref(false)
let trigger: HTMLElement | null = null
function launch(value: 'appearance' | 'keyboard') {
  // Dispatch synchronously so the sole host captures the trigger before its menu closes.
  window.dispatchEvent(new CustomEvent('atelier:appearance-open', { detail: { section: value } }))
  emit('open')
}
async function open(value: 'appearance' | 'keyboard') {
  if (dialog.value?.open) return
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  section.value = value
  if (value === 'appearance') materialControlsReady.value = true
  await nextTick()
  const summary = document.querySelector<HTMLElement>('.nav-more-trigger')
  const origin = usableFocus(trigger) ? trigger : usableFocus(summary) ? summary : document.querySelector<HTMLElement>('.nav-menu-toggle')
  fluidDialog.open(origin)
}
function restoreFocus() {
  const fallback = document.querySelector<HTMLElement>('.nav-more-trigger')
  ;(usableFocus(trigger) ? trigger : usableFocus(fallback) ? fallback : document.querySelector<HTMLElement>('.nav-menu-toggle'))?.focus()
}
function backdropClose(event: MouseEvent) {
  if (event.target !== dialog.value || !dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) fluidDialog.close()
}
function keyboardHelp() { void open('keyboard') }
function appearanceOpen(event: Event) { void open((event as CustomEvent).detail?.section === 'keyboard' ? 'keyboard' : 'appearance') }
onMounted(() => {
  if (props.launcherOnly) return
  window.addEventListener('atelier:keyboard-help', keyboardHelp)
  window.addEventListener('atelier:appearance-open', appearanceOpen)
})
onUnmounted(() => {
  if (props.launcherOnly) return
  window.removeEventListener('atelier:keyboard-help', keyboardHelp)
  window.removeEventListener('atelier:appearance-open', appearanceOpen)
})
</script>
