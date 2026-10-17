<template>
  <form class="speech-settings" :aria-labelledby="titleId" @submit.prevent="save">
    <header class="speech-settings-head">
      <div><span>SPEECH INPUT</span><h3 :id="titleId">语音输入</h3></div>
      <button class="btn btn-quiet btn-icon" type="button" aria-label="关闭语音输入设置" @click="close"><ArchiveIcon name="close" /></button>
    </header>
    <div class="speech-settings-body">
      <p class="speech-storage-note"><ArchiveIcon name="lock" />配置保存在本机</p>
      <template v-if="loadError">
        <p class="speech-test-status" data-state="fail" role="status" aria-label="配置读取状态">
          无法读取语音配置；原配置未被覆盖。请重试读取后再保存应用。
        </p>
      </template>
      <template v-else>
        <ToggleSwitch v-model="draft.enabled" class="speech-toggle-row" label="启用语音输入">
          <span class="speech-toggle-copy">
            <strong>启用语音输入</strong>
          </span>
        </ToggleSwitch>

        <div class="speech-settings-grid">
          <label class="speech-field">
            <span>服务地址</span>
            <input v-model.trim="draft.endpoint" class="input" type="url" maxlength="500" :required="draft.enabled"
              placeholder="http://127.0.0.1:8000/v1" autocomplete="url" />
          </label>
          <label class="speech-field">
            <span>模型</span>
            <input v-model.trim="draft.model" class="input" maxlength="200" aria-label="识别模型"
              placeholder="whisper-1" autocomplete="off" />
          </label>
          <label class="speech-field">
            <span>API Key（本地服务可留空）</span>
            <div class="speech-key-field">
              <input v-model.trim="draft.apiKey" class="input" :type="showApiKey ? 'text' : 'password'"
                maxlength="1000" placeholder="sk-…" autocomplete="off" aria-label="语音输入 API 密钥" spellcheck="false" />
              <button class="btn btn-quiet btn-sm" type="button" :aria-label="showApiKey ? '隐藏密钥' : '显示密钥'" :aria-pressed="showApiKey" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
            </div>
          </label>
          <label class="speech-field">
            <span>语种提示（可留空）</span>
            <input v-model.trim="draft.language" class="input" maxlength="20" aria-label="识别语种"
              placeholder="ja / zh / 留空自动判断" autocomplete="off" />
          </label>
        </div>

        <div class="speech-options">
          <ToggleSwitch v-model="draft.autoSend" class="speech-toggle-row" label="识别后直接发送">
            <span class="speech-toggle-copy">
              <strong>识别后直接发送</strong>
            </span>
          </ToggleSwitch>

          <ToggleSwitch v-model="draft.wakeEnabled" class="speech-toggle-row" label="自动监听唤醒词">
            <span class="speech-toggle-copy">
              <strong>自动监听唤醒词</strong>
              <small>唤醒词开始对话 · 结束词退出</small>
            </span>
          </ToggleSwitch>

          <div v-if="draft.wakeEnabled" v-content-motion="draft.wakeEnabled" class="speech-settings-grid">
            <label class="speech-field">
              <span>唤醒词（逗号分隔）</span>
              <input v-model="wakeWordsInput" class="input" maxlength="200" aria-label="唤醒词（逗号分隔）"
                placeholder="宁宁（留空按角色名）" autocomplete="off" @blur="commitWakeWords" />
            </label>
            <label class="speech-field">
              <span>结束词（逗号分隔）</span>
              <input v-model="endWordsInput" class="input" maxlength="200" aria-label="结束词（逗号分隔）"
                placeholder="结束对话" autocomplete="off" @blur="commitEndWords" />
            </label>
          </div>
        </div>
        <div v-if="saving || saveMessage || testMessage" class="speech-http-hint">
          <p v-if="saving || saveMessage" class="speech-test-status" :data-state="saving ? 'idle' : 'fail'"
            role="status" aria-label="配置保存状态">{{ saving ? '正在保存配置…' : saveMessage }}</p>
          <p v-if="testMessage" class="speech-test-status" :data-state="testState" role="status" aria-label="地址检测状态">{{ testMessage }}</p>
        </div>
      </template>
    </div>
    <footer class="speech-settings-actions">
      <button class="btn btn-quiet" type="button" @click="close">取消</button>
      <button v-if="loadError" class="btn btn-primary" type="button" @click="retryLoad">重试读取</button>
      <template v-else>
        <button class="btn btn-ghost" type="button" :disabled="!canTest" :aria-disabled="testing || saving || undefined" :aria-busy="testing" @click="testConnection">{{ testing ? '检测中…' : '检测地址' }}</button>
        <button class="btn btn-primary" type="submit" :aria-disabled="saving || undefined" :aria-busy="saving">{{ saving ? '保存中…' : '保存' }}</button>
      </template>
    </footer>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch, onUnmounted } from 'vue'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useSpeechInputConfig } from '@/composables/useSpeechInputConfig'
import {
  isSpeechInputReady,
  speechInputEndpointError,
  loadSpeechInputConfig,
  saveSpeechInputConfig,
  type SpeechInputConfig,
} from '@/utils/speechInputConfig'
import { probeSpeechService } from '@/utils/voiceApi'

const emit = defineEmits<{ save: [config: SpeechInputConfig]; close: [] }>()
const titleId = useId()
let disposed = false
onUnmounted(registerMaintenanceParticipant(() => { throw new Error('OPEN_SPEECH_SETTINGS') }))
onUnmounted(() => { disposed = true; invalidateProbe() })

const { config: draft, loadError, reload } = useSpeechInputConfig(false)
const showApiKey = ref(false)
const saving = ref(false)
const saveMessage = ref('')
const testState = ref<'idle' | 'testing' | 'ok' | 'unknown' | 'fail'>('idle')
const testMessage = ref('')
const testing = computed(() => testState.value === 'testing')
let probeGeneration = 0
let probeController: AbortController | null = null
let probeTimer: ReturnType<typeof setTimeout> | undefined

const wakeWordsInput = ref(draft.value.wakeWords.join('，'))
const endWordsInput = ref(draft.value.endWords.join('，'))
watch([draft, wakeWordsInput, endWordsInput], invalidateProbe, { deep: true, flush: 'sync' })

function retryLoad(): void {
  if (disposed) return
  reload()
  wakeWordsInput.value = draft.value.wakeWords.join('，')
  endWordsInput.value = draft.value.endWords.join('，')
}

function splitWords(text: string): string[] {
  return text.split(/[,，、]/).map(word => word.trim()).filter(word => word.length > 0)
}

function commitWakeWords(): void {
  draft.value.wakeWords = splitWords(wakeWordsInput.value)
  wakeWordsInput.value = draft.value.wakeWords.join('，')
}

function commitEndWords(): void {
  draft.value.endWords = splitWords(endWordsInput.value)
  if (draft.value.endWords.length === 0) draft.value.endWords = ['结束对话']
  endWordsInput.value = draft.value.endWords.join('，')
}

const canTest = computed(() => isSpeechInputReady({ ...draft.value, enabled: true }))

function invalidateProbe(): void {
  probeGeneration += 1
  probeController?.abort()
  probeController = null
  clearTimeout(probeTimer)
  probeTimer = undefined
  testState.value = 'idle'
  testMessage.value = ''
}

function close(): void {
  disposed = true
  invalidateProbe()
  emit('close')
}

async function testConnection(): Promise<void> {
  if (loadError.value || !canTest.value || testing.value || saving.value || disposed) return
  const generation = ++probeGeneration
  const controller = new AbortController()
  probeController = controller
  testState.value = 'testing'
  testMessage.value = '正在检测地址响应…'
  probeTimer = setTimeout(() => {
    if (generation !== probeGeneration) return
    invalidateProbe()
    testState.value = 'fail'
    testMessage.value = '地址检测超时（10 秒），请重试。'
  }, 10_000)
  try {
    const result = await probeSpeechService(draft.value, controller.signal)
    if (generation !== probeGeneration || disposed) return
    testState.value = result.state
    testMessage.value = result.message
  } catch (error) {
    if (generation !== probeGeneration || disposed) return
    testState.value = 'fail'
    testMessage.value = error instanceof Error ? error.message : '无法连接语音服务，请检查地址和网络。'
  } finally {
    controller.abort()
    if (generation === probeGeneration) {
      clearTimeout(probeTimer)
      probeTimer = undefined
      probeController = null
    }
  }
}

async function save(): Promise<void> {
  if (loadError.value || saving.value || disposed) return
  if (draft.value.enabled && speechInputEndpointError(draft.value.endpoint)) {
    saveMessage.value = speechInputEndpointError(draft.value.endpoint)
    return
  }
  invalidateProbe()
  saveMessage.value = ''
  saving.value = true
  commitWakeWords()
  commitEndWords()
  const submitted = JSON.stringify([draft.value, wakeWordsInput.value, endWordsInput.value])
  let acknowledged = false
  try {
    saveSpeechInputConfig(draft.value)
    await flushProfileWrites()
    acknowledged = true
    if (disposed) return
    if (JSON.stringify([draft.value, wakeWordsInput.value, endWordsInput.value]) !== submitted) {
      saveMessage.value = '提交时的设置已保存；当前修改尚未保存，请再次保存。'
      return
    }
    // 权威端可能合并其他窗口的字段；读取结果也须成功，才能让父页面应用。
    emit('save', loadSpeechInputConfig())
  } catch {
    if (!disposed) {
      saveMessage.value = acknowledged
        ? '配置已保存，但无法读取应用结果；请保留当前设置并重试。'
        : '配置保存尚未确认，请保留当前设置并重试。'
    }
  } finally { saving.value = false }
}
</script>

<style scoped src="@/assets/css/components/SpeechInputSettings-0.css"></style>

<style>
/* Both room and companion portals share one bounded floating surface. */
.studio-popover.speech-settings-popover { --speech-settings-max-height:calc(var(--reka-popover-content-available-height,100dvh - 32px) - 2px); width:min(520px,calc(100vw - 32px)); padding:0; overflow:hidden; }
.studio-popover.speech-settings-popover > .speech-settings { width:100%; max-width:none; border:0; border-radius:0; }
</style>
