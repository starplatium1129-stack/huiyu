<template>
  <button v-if="!hideTriggers" class="appearance-entry" type="button" @click="launch('appearance')"><ArchiveIcon name="palette" />外观与动态效果</button>
  <button v-if="!hideTriggers" class="appearance-entry" type="button" @click="launch('keyboard')"><ArchiveIcon name="gear" />键盘快捷键 <kbd>F1</kbd></button>
  <Teleport v-if="!launcherOnly" to="body">
    <dialog ref="dialog" class="appearance-dialog" aria-labelledby="appearance-title" @close="restoreFocus" @cancel.prevent="fluidDialog.close()" @click="backdropClose">
      <div class="appearance-heading" data-fluid-glass>
        <div><p class="appearance-eyebrow">让画室适合你</p><h2 id="appearance-title">{{ section === 'keyboard' ? '键盘快捷键' : '外观与动态效果' }}</h2><p v-if="section === 'appearance'" class="appearance-save-note">选择后自动保存在此设备。</p></div>
        <button class="appearance-close" type="button" aria-label="关闭" @click="fluidDialog.close()"><ArchiveIcon name="close" /></button>
      </div>
      <div v-if="section === 'appearance'" v-content-motion:up="section" class="appearance-fields">
        <fieldset class="appearance-choice-field">
          <legend>界面风格</legend>
          <RadioGroupRoot v-model="selectedStyle" class="appearance-style-choices" aria-label="界面风格">
            <RadioGroupItem v-for="choice in styleChoices" :key="choice.value" :value="choice.value" :data-value="choice.value"
              @focus="selectedStyle = choice.value">
              <span class="appearance-style-preview" :class="choice.value" aria-hidden="true"><i></i><i></i><i></i></span>
              <strong>{{ choice.label }}</strong><small>{{ choice.description }}</small>
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
        <GlassMaterialChoice v-if="materialControlsReady && themeStyle === 'atelier'" />
        <p v-if="themeStyle === 'terraria'" class="appearance-note">像素主题使用实色面板与方块边框，浅色与深色分别呈现白昼和夜晚。</p>
        <label v-if="zoomAvailable" class="appearance-range">界面缩放 · {{ Math.round(zoom * 100) }}%<input type="range" min="75" max="200" step="5" :value="zoom * 100" aria-label="界面缩放" @input="setZoom(Number(($event.target as HTMLInputElement).value) / 100)"><button class="btn btn-ghost" type="button" @click="setZoom(1)">恢复 100%</button></label>
        <p v-if="zoomError" role="status">{{ zoomError }}</p>
        <ToggleSwitch v-if="themeStyle === 'atelier'" class="appearance-check" :model-value="reducedGlass" label="降低玻璃效果" @update:model-value="setReducedGlass">
          <span>降低玻璃效果<small>使用更稳定的底色，减少透光与背景干扰。</small></span>
        </ToggleSwitch>
        <p v-if="themeStyle === 'atelier'" class="appearance-note">系统开启减少透明度或高对比度时，会自动降低玻璃效果。</p>
      </div>
      <dl v-else v-content-motion:up="section" class="appearance-shortcuts">
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
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { RadioGroupRoot, RadioGroupItem } from 'reka-ui'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import AnimatedSelection from './visual/AnimatedSelection.vue'
import ToggleSwitch from './visual/ToggleSwitch.vue'
const GlassMaterialChoice = defineAsyncComponent(() => import('./GlassMaterialChoice.vue'))
import { desktopShortcutAllowed, usableFocus, useDesktopPreferences } from '@/composables/useDesktopInteraction'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { useDesktopZoom } from '@/composables/useDesktopZoom'
import '@/assets/css/appearance-preferences.css'
const emit = defineEmits<{ open: [] }>()
const props = withDefaults(defineProps<{ launcherOnly?: boolean; hideTriggers?: boolean }>(), { launcherOnly: false, hideTriggers: false })
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
function runPhase(element: Element, done: () => void, entering: boolean) {
  phaseDone = done
  const finish = () => { if (phaseDone === done) phaseDone = null; done() }
  if (keyboardInput) finishPhase(element)
  else if (entering) surface.enter(element, finish)
  else surface.leave(element, finish)
}
const fluidDialog = useFluidDialog(dialog, {
  enter(element, done) { runPhase(element, done, true) },
  leave(element, done) { runPhase(element, done, false) },
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
  { value: 'atelier', label: '绘遇画室', description: '柔和手绘 · 纸页留白' },
  { value: 'terraria', label: '泰拉瑞亚', description: '像素森林 · 方块边框' },
] as const
const motionChoices = [
  { value: 'system', label: '跟随系统' },
  { value: 'full', label: '完整动效' },
  { value: 'reduce', label: '减少动态' },
] as const
let trigger: HTMLElement | null = null
let opening = 0
function launch(value: 'appearance' | 'keyboard') {
  // Dispatch synchronously so the sole host captures the trigger before its menu closes.
  window.dispatchEvent(new CustomEvent('atelier:appearance-open', { detail: { section: value } }))
  emit('open')
}
async function open(value: 'appearance' | 'keyboard') {
  const version = ++opening, wasOpen = !!dialog.value?.open
  const focusInside = !!dialog.value?.contains(document.activeElement)
  if (!wasOpen) trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  section.value = value
  if (value === 'appearance') materialControlsReady.value = true
  await nextTick()
  if (version !== opening) return
  const summary = document.querySelector<HTMLElement>('.nav-more-trigger')
  const origin = usableFocus(trigger) ? trigger : usableFocus(summary) ? summary : document.querySelector<HTMLElement>('.nav-menu-toggle')
  fluidDialog.open(origin)
  if (wasOpen && focusInside && document.activeElement === document.body) {
    dialog.value?.querySelector<HTMLButtonElement>('.appearance-close')?.focus({ preventScroll: true })
  }
}
function restoreFocus() {
  // A queued close event must not redirect focus after the dialog reopens.
  if (dialog.value?.open) return
  const fallback = document.querySelector<HTMLElement>('.nav-more-trigger')
  ;(usableFocus(trigger) ? trigger : usableFocus(fallback) ? fallback : document.querySelector<HTMLElement>('.nav-menu-toggle'))?.focus({ preventScroll: true })
}
function backdropClose(event: MouseEvent) {
  if (event.target !== dialog.value || !dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) fluidDialog.close()
}
function keyboardHelp() { keyboardInput = true; void open('keyboard') }
function appearanceOpen(event: Event) { void open((event as CustomEvent).detail?.section === 'keyboard' ? 'keyboard' : 'appearance') }
function keyboard(event: KeyboardEvent) {
  keyboardInput = true
  const current = dialog.value
  if (!current?.open) return
  // Global shortcuts defer to an open modal. This one owns its help request,
  // including a keyboard reversal while a pointer close is still settling.
  if (event.key === 'F1' && !event.ctrlKey && !event.shiftKey && desktopShortcutAllowed(event)
    && event.target instanceof Node && current.contains(event.target)) {
    event.preventDefault(); void open('keyboard')
  }
  else finishPhase(current)
}
function pointer() { keyboardInput = false }
onMounted(() => {
  if (props.launcherOnly) return
  window.addEventListener('atelier:keyboard-help', keyboardHelp)
  window.addEventListener('atelier:appearance-open', appearanceOpen)
  window.addEventListener('keydown', keyboard, true)
  window.addEventListener('pointerdown', pointer, true)
})
onUnmounted(() => {
  if (props.launcherOnly) return
  window.removeEventListener('atelier:keyboard-help', keyboardHelp)
  window.removeEventListener('atelier:appearance-open', appearanceOpen)
  window.removeEventListener('keydown', keyboard, true)
  window.removeEventListener('pointerdown', pointer, true)
  opening++
})
</script>
