<template>
  <div v-if="section === 'appearance'" v-content-motion:up="section" class="appearance-fields">
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
    <fieldset v-if="themeStyle === 'atelier'" class="appearance-choice-field">
      <legend>画室配色</legend>
      <RadioGroupRoot v-model="selectedPalette" class="appearance-segments studio-segments" data-segment-keyboard="managed" aria-label="画室配色">
        <AnimatedSelection />
        <RadioGroupItem v-for="choice in paletteChoices" :key="choice.value" :value="choice.value"
          :data-value="choice.value" @focus="selectedPalette = choice.value">{{ choice.label }}</RadioGroupItem>
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
    <AsyncPanel v-if="themeStyle === 'atelier'" :loader="loadGlassMaterial" label="玻璃材质设置" v-slot="{ component }"><component :is="component" /></AsyncPanel>
    <div v-if="zoomAvailable" class="appearance-range-wrap">
      <StudioSlider
        :id="zoomId"
        :model-value="Math.round(zoom * 100)"
        :min="75"
        :max="200"
        :step="5"
        label="界面缩放"
        unit="%"
        @update:model-value="setZoom($event / 100)"
      >
        <template #actions>
          <button class="btn btn-ghost btn-sm" type="button" @click="setZoom(1)">恢复 100%</button>
        </template>
      </StudioSlider>
    </div>
    <p v-if="zoomError" role="status">{{ zoomError }}</p>
    <ToggleSwitch v-if="themeStyle === 'atelier'" class="appearance-check" :model-value="reducedGlass" label="降低玻璃效果" @update:model-value="setReducedGlass">
      <span>降低玻璃效果</span>
    </ToggleSwitch>
  </div>
  <dl v-else v-content-motion:up="section" class="appearance-shortcuts">
    <div><dt><kbd>F6</kbd> / <kbd>Shift F6</kbd></dt><dd>在导航与内容之间切换</dd></div>
    <div><dt><kbd>←</kbd> <kbd>→</kbd> / <kbd>Home</kbd> <kbd>End</kbd></dt><dd>主导航内移动焦点</dd></div>
    <div><dt><kbd>Enter</kbd></dt><dd>打开聚焦的导航页面</dd></div>
    <div><dt><kbd>Ctrl / ⌘ K</kbd></dt><dd>搜索页面、角色、场景与作品</dd></div>
    <div><dt><kbd>Tab</kbd> / <kbd>Shift Tab</kbd></dt><dd>依次访问操作与表单</dd></div>
    <div><dt><kbd>Esc</kbd></dt><dd>关闭当前弹窗</dd></div>
    <div><dt><kbd>Ctrl + / − / 0</kbd></dt><dd>{{ zoomAvailable ? '界面缩放 / 恢复 100%（自动保存）' : '浏览器缩放 / 恢复 100%' }}</dd></div>
  </dl>
</template>

<script setup lang="ts">
// Load the optional theme tokens and surfaces before a user can select their style.
import '@/assets/css/terraria-theme.css'
import '@/assets/css/terraria-surfaces.css'
import { computed, useId } from 'vue'
import { RadioGroupRoot, RadioGroupItem } from 'reka-ui'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import AnimatedSelection from './visual/AnimatedSelection.vue'
import ToggleSwitch from './visual/ToggleSwitch.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import StudioSlider from '@/components/ui/StudioSlider.vue'
const loadGlassMaterial = () => import('./GlassMaterialChoice.vue')
import { useDesktopPreferences } from '@/composables/useDesktopInteraction'
import { useDesktopZoom } from '@/composables/useDesktopZoom'
defineProps<{ section: 'appearance' | 'keyboard' }>()
const { themeMode, themeStyle, themePalette, motionMode, reducedGlass, setThemeMode, setThemeStyle, setThemePalette, setMotionMode, setReducedGlass } = useDesktopPreferences()
// Select on roving focus so the preference and Tab stop stay aligned even when
// keyup precedes Reka's deferred click after a short arrow-key press.
const selectedTheme = computed({ get: () => themeMode.value, set: setThemeMode })
const selectedStyle = computed({ get: () => themeStyle.value, set: setThemeStyle })
const selectedPalette = computed({ get: () => themePalette.value, set: setThemePalette })
const selectedMotion = computed({ get: () => motionMode.value, set: setMotionMode })
const { available: zoomAvailable, zoom, error: zoomError, setZoom } = useDesktopZoom()
const zoomId = useId()
const themeChoices = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const
const paletteChoices = [
  { value: 'default', label: '暖墨和纸' },
  { value: 'yozakura', label: '夜樱晴空' },
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
</script>
