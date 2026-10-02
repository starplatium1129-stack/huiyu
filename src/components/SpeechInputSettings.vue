<template>
  <form class="speech-settings" @submit.prevent="save">
    <div class="speech-settings-head">
      <div class="speech-title-lockup">
        <span class="speech-mark" aria-hidden="true"><ArchiveIcon name="sound" /></span>
        <div>
          <small>SPEECH INPUT</small>
          <strong>语音输入（按住说话）</strong>
          <span>连接 OpenAI 兼容的语音识别服务（whisper.cpp、faster-whisper 等）。</span>
        </div>
      </div>
      <span class="speech-storage-note"><i aria-hidden="true"></i>配置保存在本机浏览器</span>
    </div>

    <template v-if="loadError">
      <p class="speech-test-status" data-state="fail" role="status" aria-label="配置读取状态">
        无法读取语音配置；原配置未被覆盖。请重试读取后再保存应用。
      </p>
      <div class="speech-settings-actions">
        <div class="speech-settings-buttons tw:ml-auto">
          <button class="btn btn-primary btn-sm" type="button" @click="retryLoad">重试读取</button>
          <button class="btn btn-ghost btn-sm" type="button" @click="close">关闭</button>
        </div>
      </div>
    </template>
    <template v-else>
    <ToggleSwitch v-model="draft.enabled" class="speech-toggle-row" label="启用语音输入">
      <span class="speech-toggle-copy">
        <strong>启用语音输入</strong>
        <small>聊天输入框旁显示“按住说话”按钮</small>
      </span>
    </ToggleSwitch>

    <div class="speech-settings-grid">
      <label class="speech-field">
        <span><i aria-hidden="true">01</i> 服务地址</span>
        <input v-model.trim="draft.endpoint" type="url" maxlength="500"
          placeholder="http://127.0.0.1:8000/v1" autocomplete="url" />
        <small>识别接口为 <code>{地址}/audio/transcriptions</code></small>
      </label>
      <label class="speech-field">
        <span><i aria-hidden="true">02</i> 模型</span>
        <input v-model.trim="draft.model" maxlength="200" aria-label="识别模型"
          placeholder="whisper-1" autocomplete="off" />
      </label>
      <label class="speech-field">
        <span><i aria-hidden="true">03</i> API Key（本地服务可留空）</span>
        <div class="speech-key-field">
          <input v-model.trim="draft.apiKey" :type="showApiKey ? 'text' : 'password'"
            maxlength="1000" placeholder="sk-…" autocomplete="off" />
          <button type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
        </div>
      </label>
      <label class="speech-field">
        <span><i aria-hidden="true">04</i> 语种提示（可留空）</span>
        <input v-model.trim="draft.language" maxlength="20" aria-label="识别语种"
          placeholder="ja / zh / 留空自动判断" autocomplete="off" />
      </label>
    </div>

    <ToggleSwitch v-model="draft.autoSend" class="speech-toggle-row speech-toggle-row-sub" label="识别后直接发送">
      <span class="speech-toggle-copy">
        <strong>识别后直接发送</strong>
        <small>不勾选时先填入输入框，确认后再发送</small>
      </span>
    </ToggleSwitch>

    <ToggleSwitch v-model="draft.wakeEnabled" class="speech-toggle-row speech-toggle-row-sub" label="唤醒词连续对话">
      <span class="speech-toggle-copy">
        <strong>唤醒词连续对话</strong>
        <small>空闲时自动监听，说出唤醒词即可对话，说结束词退出</small>
      </span>
    </ToggleSwitch>

    <div v-if="draft.wakeEnabled" class="speech-settings-grid speech-settings-grid-words">
      <label class="speech-field">
        <span><i aria-hidden="true">05</i> 唤醒词（逗号分隔）</span>
        <input v-model="wakeWordsInput" maxlength="200" aria-label="唤醒词（逗号分隔）"
          placeholder="宁宁（留空按角色名）" autocomplete="off" @blur="commitWakeWords" />
      </label>
      <label class="speech-field">
        <span><i aria-hidden="true">06</i> 结束词（逗号分隔）</span>
        <input v-model="endWordsInput" maxlength="200" aria-label="结束词（逗号分隔）"
          placeholder="结束对话" autocomplete="off" @blur="commitEndWords" />
      </label>
    </div>

    <div class="speech-settings-actions">
      <div class="speech-settings-buttons tw:ml-auto">
        <button class="btn btn-ghost btn-sm" type="button"
          :disabled="testing || saving || !canTest" @click="testConnection">
          {{ testing ? '检测中…' : '检测地址' }}
        </button>
        <button class="btn btn-primary btn-sm" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="close">关闭</button>
      </div>
    </div>
    <div class="speech-http-hint">
      <p v-if="saving || saveMessage" class="speech-test-status" :data-state="saving ? 'idle' : 'fail'"
        role="status" aria-label="配置保存状态">{{ saving ? '正在保存配置…' : saveMessage }}</p>
      <p class="speech-test-status" :data-state="testState" role="status" aria-label="地址检测状态">{{ testMessage }}</p>
    </div>
    <p class="speech-http-hint">
      <ArchiveIcon name="info" /> 仅检测地址的 HTTP 响应，未验证语音转写、模型或密钥。若检测失败，请检查地址、服务及跨域（CORS）设置。
    </p>
    </template>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useSpeechInputConfig } from '@/composables/useSpeechInputConfig'
import {
  isSpeechInputReady,
  loadSpeechInputConfig,
  saveSpeechInputConfig,
  type SpeechInputConfig,
} from '@/utils/speechInputConfig'

const emit = defineEmits<{ save: [config: SpeechInputConfig]; close: [] }>()
let disposed = false
onUnmounted(registerMaintenanceParticipant(() => { throw new Error('OPEN_SPEECH_SETTINGS') }))
onUnmounted(() => { disposed = true; invalidateProbe() })

const { config: draft, loadError, reload } = useSpeechInputConfig()
const showApiKey = ref(false)
const saving = ref(false)
const saveMessage = ref('')
const testState = ref<'idle' | 'testing' | 'ok' | 'fail'>('idle')
const testMessage = ref('可直接保存配置，或先检测地址。')
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
  testMessage.value = '可直接保存配置，或先检测地址。'
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
  const endpoint = draft.value.endpoint.replace(/\/+$/, '')
  probeTimer = setTimeout(() => {
    if (generation !== probeGeneration) return
    invalidateProbe()
    testState.value = 'fail'
    testMessage.value = '地址检测超时（10 秒），请重试。'
  }, 10_000)
  try {
    const response = await fetch(endpoint, { method: 'GET', mode: 'cors', signal: controller.signal })
    if (generation !== probeGeneration || disposed) return
    if (response.type === 'opaque' || response.status === 0) {
      testState.value = 'idle'
      testMessage.value = '响应不可读，无法确认 HTTP 状态。'
    } else {
      testState.value = response.ok ? 'ok' : 'fail'
      testMessage.value = `地址返回 HTTP ${response.status}。`
    }
  } catch {
    if (generation !== probeGeneration || disposed) return
    testState.value = 'fail'
    testMessage.value = '未能读取地址响应，请检查地址、服务或跨域设置后重试。'
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
