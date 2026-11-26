<template>
  <div class="shell-preferences">
    <ToggleSwitch class="shell-autostart" :model-value="autostart === true"
      :disabled="autostart === null || autostartBusy" @update:model-value="changeAutostart">开机启动</ToggleSwitch>
    <p v-if="autostartFeedback" role="status">{{ autostartFeedback }}</p>
    <label for="desktop-close-behavior">关闭主窗口时</label>
    <StudioSelect id="desktop-close-behavior" label="关闭主窗口时" :model-value="preferences?.closeBehavior"
      :disabled="busy || !preferences" :options="closeModes" @update:model-value="changeCloseBehavior" />
    <fieldset v-if="preferences" class="shell-shortcuts">
      <legend>系统快捷键</legend>
      <div v-for="(shortcut, index) in preferences.shortcuts" :key="shortcutNames[index]" class="shell-shortcut" @focusout="leaveShortcut(index, $event)">
        <ToggleSwitch class="shell-shortcut-enable" :model-value="shortcut.enabled" :disabled="busy"
          @update:model-value="setEnabled(index, $event)">
          {{ shortcutNames[index] }}
        </ToggleSwitch>
        <button class="btn btn-ghost btn-sm shell-record" type="button" :disabled="busy"
          :aria-label="`${recording === index ? '按下组合键…' : displayShortcut(shortcut.accelerator)}，录制${shortcutNames[index]}快捷键`"
          :aria-pressed="recording === index"
          @click="startRecording(index)" @keydown="recordKey(index, $event)">
          {{ recording === index ? '按下组合键…' : displayShortcut(shortcut.accelerator) }}
        </button>
        <div v-if="recording === index" class="shell-shortcut-manual">
          <label :for="`desktop-manual-shortcut-${index}`">手动输入组合键</label>
          <div>
            <input :id="`desktop-manual-shortcut-${index}`" v-model="manualShortcut" class="input"
              autocomplete="off" spellcheck="false" maxlength="48" />
            <button type="button" class="btn btn-ghost btn-sm" :disabled="!manualShortcut.trim()"
              @click="saveShortcut(index, manualShortcut.trim().replace(/\s*\+\s*/g, '+').replace(/(^|\+)Win(?=\+)/i, '$1Super'))">
              应用组合键
            </button>
          </div>
        </div>
        <p v-if="shortcutErrors.get(index)" class="shell-shortcut-error" role="alert">{{ shortcutErrors.get(index) }}</p>
      </div>
      <button class="btn btn-ghost btn-sm shell-defaults" type="button" :disabled="busy" @click="restoreDefaults">恢复默认快捷键</button>
    </fieldset>
    <p v-if="feedback" role="status">{{ feedback }}</p>
    <button v-if="!preferences && !busy" class="btn btn-ghost btn-sm shell-defaults" type="button" @click="readPreferences">重新读取桌面设置</button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { desktopShell, type DesktopShellPreferences } from '@/platform/desktop/shell'

const closeModes = [
  { value: 'tray', label: '隐藏到托盘' },
  { value: 'quit', label: '退出绘遇' },
]
const defaultKeys = ['Ctrl+Shift+P', 'Ctrl+Shift+Space', 'Ctrl+Shift+A', 'Ctrl+Shift+X']
const shortcutNames = ['整身鼠标穿透', '显示或隐藏桌宠', '打开主画室', '显示或隐藏聊天窗']
const preferences = ref<DesktopShellPreferences>()
const shortcutErrors = ref(new Map<number, string>())
const recording = ref<number | null>(null)
const manualShortcut = ref('')
const busy = ref(false)
const feedback = ref('')
const autostart = ref<boolean | null>(null)
const autostartBusy = ref(false)
const autostartFeedback = ref('')
let offAutostart: (() => void) | undefined
let sawAutostartUpdate = false
const displayShortcut = (accelerator: string) => accelerator.replaceAll('Super', 'Win')

async function readPreferences() {
  if (busy.value) return
  busy.value = true
  try {
    const result = await desktopShell.readPreferences()
    preferences.value = result.preferences
    shortcutErrors.value = new Map(result.conflicts.map(({ index, message }) => [index, message]))
    feedback.value = ''
  } catch { feedback.value = '无法读取桌面设置。' }
  finally { busy.value = false }
}

async function savePreferences(next: DesktopShellPreferences) {
  if (busy.value) return
  busy.value = true
  recording.value = null
  try {
    const result = await desktopShell.savePreferences(next)
    if (result.saved) preferences.value = result.preferences
    shortcutErrors.value = new Map(result.conflicts.map(({ index, message }) => [index, message]))
    feedback.value = result.saved ? '桌面设置已保存。' : '快捷键冲突，保留原来的设置。'
  } catch { feedback.value = '未能保存，请重试。' }
  finally { busy.value = false }
}

function setEnabled(index: number, enabled: boolean) {
  const current = preferences.value
  if (!current) return
  void savePreferences({ ...current, shortcuts: current.shortcuts.map((item, slot) => slot === index ? { ...item, enabled } : item) })
}

function changeCloseBehavior(value: string | number) {
  if (!preferences.value || (value !== 'tray' && value !== 'quit') || value === preferences.value.closeBehavior) return
  void savePreferences({ ...preferences.value, closeBehavior: value })
}

function restoreDefaults() {
  if (!preferences.value) return
  void savePreferences({ ...preferences.value, shortcuts: defaultKeys.map(accelerator => ({ accelerator, enabled: true })) })
}

function startRecording(index: number) {
  if (recording.value === index) { recording.value = null; return }
  recording.value = index
  manualShortcut.value = preferences.value ? displayShortcut(preferences.value.shortcuts[index].accelerator) : ''
}

function leaveShortcut(index: number, event: FocusEvent) {
  const row = event.currentTarget as HTMLElement
  if (recording.value === index && !(event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) recording.value = null
}

function saveShortcut(index: number, accelerator: string) {
  if (!preferences.value) return
  const current = preferences.value
  void savePreferences({ ...current, shortcuts: current.shortcuts.map((item, slot) => slot === index ? { enabled: true, accelerator } : item) })
}

function recordKey(index: number, event: KeyboardEvent) {
  if (recording.value !== index || !preferences.value || event.isComposing || event.keyCode === 229 || event.repeat) return
  if (event.key === 'Tab') return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') { recording.value = null; return }
  if (['Control', 'Alt', 'Meta', 'Shift', 'AltGraph'].includes(event.key)) return
  if (!(event.ctrlKey || event.altKey || event.metaKey) || event.getModifierState('AltGraph')
    || !/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown|Insert|Delete)$/.test(event.code)) {
    feedback.value = '请按住 Ctrl、Alt 或 Windows 键，再按字母、数字、空格、方向键或功能键。'
    return
  }
  const key = event.code.replace(/^(Key|Digit)/, '')
  const accelerator = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean).join('+')
  saveShortcut(index, accelerator)
}

async function changeAutostart(desired: boolean) {
  if (autostartBusy.value) return
  autostartBusy.value = true
  try { autostart.value = await desktopShell.saveAutostart(desired); autostartFeedback.value = '' }
  catch { autostartFeedback.value = '未能修改开机启动，请重试。' }
  finally { autostartBusy.value = false }
}

onMounted(() => {
  offAutostart = desktopShell.onAutostart(value => { sawAutostartUpdate = true; autostart.value = value })
  void desktopShell.readAutostart().then(value => { if (!sawAutostartUpdate) autostart.value = value })
    .catch(() => { if (!sawAutostartUpdate) autostartFeedback.value = '暂时无法读取开机启动状态。' })
  void readPreferences()
})
onUnmounted(() => offAutostart?.())
</script>

<style scoped>
.shell-preferences { display: grid; gap: var(--s-3); min-inline-size: 0; }
.shell-autostart, .shell-shortcut-enable { justify-self: start; }
.shell-shortcuts { min-inline-size: 0; margin: 0; padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-md); }
.shell-shortcuts legend { padding-inline: var(--s-2); color: var(--text-primary); }
.shell-shortcut { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--s-2) var(--s-3); margin-block-end: var(--s-2); }
.shell-record { min-inline-size: 8rem; font-variant-numeric: tabular-nums; }
.shell-shortcut-error { grid-column: 1 / -1; }
.shell-shortcut-manual { grid-column: 1 / -1; display: grid; gap: var(--s-1); }
.shell-shortcut-manual > div { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.shell-shortcut-manual .input { flex: 1 1 10rem; min-inline-size: 0; }
.shell-preferences p { margin: 0; color: var(--text-secondary); font-size: var(--fs-label); }
.shell-preferences .shell-shortcut-error { color: var(--danger-text); }
.shell-preferences .btn:disabled { color: var(--text-disabled); }
.shell-defaults { justify-self: start; }
</style>
