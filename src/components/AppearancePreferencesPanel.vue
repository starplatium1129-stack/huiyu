<template>
  <Teleport to="body">
    <dialog ref="dialog" class="appearance-dialog" aria-labelledby="appearance-title" @close="restoreFocus" @cancel.prevent="fluidDialog.close()" @click="backdropClose">
      <header class="appearance-heading">
        <div><h2 id="appearance-title">{{ section === 'keyboard' ? '键盘快捷键' : '外观与动态效果' }}</h2><p v-if="section === 'appearance'" class="appearance-save-note">自动保存</p></div>
        <button class="btn btn-quiet btn-icon appearance-close" type="button" aria-label="关闭" @click="fluidDialog.close()"><ArchiveIcon name="close" /></button>
      </header>
      <div v-if="section === 'appearance'" v-content-motion:up="section" class="appearance-content appearance-fields">
        <fieldset class="appearance-choice-field">
          <legend>界面风格</legend>
          <RadioGroupRoot v-model="selectedStyle" class="appearance-style-choices" aria-label="界面风格">
            <RadioGroupItem v-for="choice in styleChoices" :key="choice.value" :value="choice.value" :data-value="choice.value"
              @focus="selectedStyle = choice.value">
              <span class="appearance-style-preview" :class="choice.value" aria-hidden="true"><i></i><i></i><i></i></span>
              <span class="appearance-style-label"><strong>{{ choice.label }}</strong><ArchiveIcon v-if="selectedStyle === choice.value" name="success" /></span>
            </RadioGroupItem>
          </RadioGroupRoot>
        </fieldset>
        <fieldset class="appearance-choice-field">
          <legend>画室主题</legend>
          <RadioGroupRoot v-model="selectedTheme" class="appearance-segments studio-segments" data-segment-keyboard="managed" aria-label="画室主题">
            <AnimatedSelection />
            <RadioGroupItem v-for="choice in themeChoices" :key="choice.value" :value="choice.value"
              :data-value="choice.value" @focus="selectedTheme = choice.value">{{ choice.label }}</RadioGroupItem>
          </RadioGroupRoot>
        </fieldset>
        <fieldset class="appearance-choice-field">
          <legend>动态效果</legend>
          <RadioGroupRoot v-model="selectedMotion" class="appearance-segments studio-segments" data-segment-keyboard="managed" aria-label="动态效果">
            <AnimatedSelection />
            <RadioGroupItem v-for="choice in motionChoices" :key="choice.value" :value="choice.value"
              :data-value="choice.value" @focus="selectedMotion = choice.value">{{ choice.label }}</RadioGroupItem>
          </RadioGroupRoot>
        </fieldset>
        <AsyncPanel v-if="materialControlsReady && themeStyle === 'atelier'" :loader="loadGlassMaterial" label="玻璃材质设置" v-slot="{ component }"><component :is="component" /></AsyncPanel>
        <label v-if="zoomAvailable" class="appearance-range">界面缩放 · {{ Math.round(zoom * 100) }}%<input type="range" min="75" max="200" step="5" :value="zoom * 100" aria-label="界面缩放" @input="setZoom(Number(($event.target as HTMLInputElement).value) / 100)"><button class="btn btn-ghost" type="button" @click="setZoom(1)">恢复 100%</button></label>
        <p v-if="zoomError" role="status">{{ zoomError }}</p>
        <ToggleSwitch v-if="themeStyle === 'atelier'" class="appearance-check" :model-value="reducedGlass" label="降低玻璃效果" @update:model-value="setReducedGlass">
          <span>降低玻璃效果</span>
        </ToggleSwitch>
        <p v-if="themeStyle === 'atelier'" class="appearance-note">系统开启减少透明度或高对比度时，会自动降低玻璃效果。</p>
      </div>
      <div v-else v-content-motion:up="section" class="appearance-content" tabindex="0" role="region" aria-label="快捷键列表">
        <dl class="appearance-shortcuts">
          <div><dt><kbd>F6</kbd> / <kbd>Shift F6</kbd></dt><dd>在导航与内容之间切换</dd></div>
          <div><dt><kbd>←</kbd> <kbd>→</kbd> / <kbd>Home</kbd> <kbd>End</kbd></dt><dd>主导航内移动焦点</dd></div>
          <div><dt><kbd>Enter</kbd></dt><dd>打开聚焦的导航页面</dd></div>
          <div><dt><kbd>Ctrl / ⌘ K</kbd></dt><dd>搜索页面、场景与作品</dd></div>
          <div><dt><kbd>Tab</kbd> / <kbd>Shift Tab</kbd></dt><dd>依次访问操作与表单</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>关闭当前弹窗</dd></div>
          <div><dt><kbd>Ctrl + / − / 0</kbd></dt><dd>{{ zoomAvailable ? '界面缩放 / 恢复 100%（自动保存）' : '浏览器缩放 / 恢复 100%' }}</dd></div>
        </dl>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
// Load the optional surfaces before a user can select their style.
import '@/assets/css/terraria-surfaces.css'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AppearanceRequest } from './AppearancePreferences.vue'
import { RadioGroupRoot, RadioGroupItem } from 'reka-ui'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import AnimatedSelection from './visual/AnimatedSelection.vue'
import ToggleSwitch from './visual/ToggleSwitch.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
const loadGlassMaterial = () => import('./GlassMaterialChoice.vue')
import { appearanceFocusOrigin, desktopShortcutAllowed, useDesktopPreferences } from '@/composables/useDesktopInteraction'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { useDesktopZoom } from '@/composables/useDesktopZoom'
import '@/assets/css/appearance-preferences.css'
const props = defineProps<{ request: AppearanceRequest }>()
const emit = defineEmits<{ ready: [] }>()
const { themeMode, themeStyle, motionMode, reducedGlass, setThemeMode, setThemeStyle, setMotionMode, setReducedGlass } = useDesktopPreferences()
// Select on roving focus so the preference and Tab stop stay aligned even when
// keyup precedes Reka's deferred click after a short arrow-key press.
const selectedTheme = computed({ get: () => themeMode.value, set: setThemeMode })
const selectedStyle = computed({ get: () => themeStyle.value, set: setThemeStyle })
const selectedMotion = computed({ get: () => motionMode.value, set: setMotionMode })
const dialog = ref<HTMLDialogElement | null>(null)
let keyboardInput = false
const surface = useFluidSurface()
let phaseDone: (() => void) | null = null
function finishPhase(element: Element) {
  const done = phaseDone; phaseDone = null
  surface.dispose(element); done?.()
}
function runPhase(element: Element, done: () => void) {
  phaseDone = done
  const finish = () => { if (phaseDone === done) phaseDone = null; done() }
  if (keyboardInput) finishPhase(element)
  else surface.enter(element, finish)
}
const fluidDialog = useFluidDialog(dialog, {
  enter(element, done) { runPhase(element, done) },
  dispose(element) { phaseDone = null; surface.dispose(element) },
})
const { available: zoomAvailable, zoom, error: zoomError, setZoom } = useDesktopZoom()
const section = ref<'appearance' | 'keyboard'>('appearance')
const materialControlsReady = ref(false)
const themeChoices = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const
const styleChoices = [
  { value: 'atelier', label: '绘遇画室' },
  { value: 'terraria', label: '泰拉瑞亚' },
] as const
const motionChoices = [
  { value: 'system', label: '跟随系统' },
  { value: 'full', label: '完整动效' },
  { value: 'reduce', label: '减少动态' },
] as const
let trigger: HTMLElement | null = null
let opening = 0
async function open(value: 'appearance' | 'keyboard', origin?: HTMLElement | null) {
  const version = ++opening, wasOpen = !!dialog.value?.open
  const focusInside = !!dialog.value?.contains(document.activeElement)
  if (!wasOpen) trigger = origin === undefined ? document.activeElement instanceof HTMLElement ? document.activeElement : null : origin
  section.value = value
  if (value === 'appearance') materialControlsReady.value = true
  await nextTick()
  if (version !== opening) return
  fluidDialog.open(appearanceFocusOrigin(trigger))
  if (wasOpen && focusInside && document.activeElement === document.body) {
    dialog.value?.querySelector<HTMLButtonElement>('.appearance-close')?.focus({ preventScroll: true })
  }
}
function restoreFocus() {
  // A queued close event must not redirect focus after the dialog reopens.
  if (dialog.value?.open) return
  appearanceFocusOrigin(trigger)?.focus({ preventScroll: true })
}
function backdropClose(event: MouseEvent) {
  if (event.target !== dialog.value || !dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) fluidDialog.close()
}
function openRequest() {
  keyboardInput = props.request.keyboard
  void open(props.request.section, props.request.trigger)
}
watch(() => props.request, openRequest, { flush: 'post' })
function keyboard(event: KeyboardEvent) {
  keyboardInput = true
  const current = dialog.value
  if (!current?.open) return
  // This modal owns F1, including while its opening motion is settling.
  if (event.key === 'F1' && !event.ctrlKey && !event.shiftKey && desktopShortcutAllowed(event)
    && event.target instanceof Node && current.contains(event.target)) {
    event.preventDefault(); void open('keyboard')
  }
  else finishPhase(current)
}
function pointer() { keyboardInput = false }
onMounted(() => {
  openRequest()
  window.addEventListener('keydown', keyboard, true)
  window.addEventListener('pointerdown', pointer, true)
  emit('ready')
})
onUnmounted(() => {
  window.removeEventListener('keydown', keyboard, true)
  window.removeEventListener('pointerdown', pointer, true)
  opening++
})
</script>
