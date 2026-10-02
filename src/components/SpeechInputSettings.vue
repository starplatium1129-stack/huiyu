<template>
  <form class="speech-settings" @submit.prevent="save">
    <div class="speech-settings-head">
      <div class="speech-title-lockup">
        <span class="speech-mark" aria-hidden="true">◉</span>
        <div>
          <small>SPEECH INPUT</small>
          <strong>语音输入（按住说话）</strong>
          <span>连接 OpenAI 兼容的语音识别服务（whisper.cpp、faster-whisper 等）。</span>
        </div>
      </div>
      <span class="speech-storage-note"><i aria-hidden="true"></i>配置保存在本机浏览器</span>
    </div>

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
      <span class="speech-test-status" :data-state="testState" role="status">{{ statusText }}</span>
      <div class="speech-settings-buttons">
        <button class="btn btn-ghost btn-sm" type="button"
          :disabled="testing || !canTest" @click="testConnection">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn btn-primary btn-sm" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">关闭</button>
      </div>
    </div>
    <p class="speech-http-hint">
      <i aria-hidden="true">i</i> 若提示无法连接，请确认服务已启动，且允许跨域请求（CORS）。
    </p>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import {
  DEFAULT_SPEECH_INPUT_CONFIG,
  isSpeechInputReady,
  loadSpeechInputConfig,
  saveSpeechInputConfig,
  type SpeechInputConfig,
} from '@/utils/speechInputConfig'

const emit = defineEmits<{ save: []; close: [] }>()
let disposed = false
onUnmounted(registerMaintenanceParticipant(() => { throw new Error('OPEN_SPEECH_SETTINGS') }))
onUnmounted(() => { disposed = true })

const draft = ref<SpeechInputConfig>(loadSpeechInputConfig())
const showApiKey = ref(false)
const saving = ref(false)
const testing = ref(false)
const testState = ref<'idle' | 'testing' | 'ok' | 'fail'>('idle')
const testMessage = ref('')

const wakeWordsInput = ref(draft.value.wakeWords.join('，'))
const endWordsInput = ref(draft.value.endWords.join('，'))

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

const statusText = computed(() => {
  if (saving.value) return '正在保存配置…'
  if (testState.value === 'testing') return '正在检测服务可达性…'
  if (testState.value === 'ok') return '连接正常'
  if (testState.value === 'fail') return testMessage.value || '无法连接服务'
  return '先测试连接，再保存配置。'
})

const canTest = computed(() => isSpeechInputReady({ ...draft.value, enabled: true }))

async function testConnection(): Promise<void> {
  if (!canTest.value || testing.value) return
  testing.value = true
  testState.value = 'testing'
  const endpoint = draft.value.endpoint.replace(/\/+$/, '')
  try {
    const response = await fetch(endpoint, { method: 'GET', mode: 'no-cors' })
    if (response.type === 'opaque') {
      testState.value = 'ok'
    } else {
      testState.value = response.ok ? 'ok' : 'fail'
      testMessage.value = response.ok ? '' : `服务返回 ${response.status}`
    }
  } catch (error) {
    testState.value = 'fail'
    testMessage.value = error instanceof Error ? error.message : '无法连接服务'
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  if (saving.value || disposed) return
  saving.value = true
  commitWakeWords()
  commitEndWords()
  const submitted = JSON.stringify([draft.value, wakeWordsInput.value, endWordsInput.value])
  try {
    saveSpeechInputConfig(draft.value)
    await flushProfileWrites()
    if (disposed) return
    if (JSON.stringify([draft.value, wakeWordsInput.value, endWordsInput.value]) !== submitted) {
      testState.value = 'fail'
      testMessage.value = '提交时的设置已保存；当前修改尚未保存，请再次保存。'
      return
    }
    emit('save')
  } catch {
    if (!disposed) {
      testState.value = 'fail'
      testMessage.value = '配置保存尚未确认，请保留当前设置并重试。'
    }
  } finally { saving.value = false }
}
</script>

<style scoped src="@/assets/css/components/SpeechInputSettings-0.css"></style>
