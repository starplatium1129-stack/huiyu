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
        <button class="btn btn-primary btn-sm" type="submit">保存</button>
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
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import {
  DEFAULT_SPEECH_INPUT_CONFIG,
  isSpeechInputReady,
  loadSpeechInputConfig,
  saveSpeechInputConfig,
  type SpeechInputConfig,
} from '@/utils/speechInputConfig'

const emit = defineEmits<{ save: []; close: [] }>()
onUnmounted(registerMaintenanceParticipant(() => { throw new Error('OPEN_SPEECH_SETTINGS') }))

const draft = ref<SpeechInputConfig>(loadSpeechInputConfig())
const showApiKey = ref(false)
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

function save(): void {
  commitWakeWords()
  commitEndWords()
  saveSpeechInputConfig(draft.value)
  emit('save')
}
</script>

<style scoped>
.speech-settings {
  background: var(--bg-elevated);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  padding: var(--s-4);
  max-width: 520px;
}

.speech-settings-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}

.speech-title-lockup { display: flex; gap: var(--s-3); align-items: flex-start; }
.speech-mark {
  width: 34px; height: 34px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--character-soft);
  color: var(--character-accent);
  border-radius: var(--r-md);
  font-size: var(--fs-body);
}
.speech-title-lockup small {
  display: block; font-size: var(--fs-mono-xs); letter-spacing: .14em;
  color: var(--text-muted);
  margin-bottom: 2px;
}
.speech-title-lockup strong { display: block; font-size: var(--fs-label-sm); color: var(--text-primary); }
.speech-title-lockup span {
  display: block; font-size: var(--fs-label-xs);
  color: var(--text-muted);
  margin-top: 4px;
}
.speech-storage-note {
  font-size: var(--fs-mono-xs); color: var(--text-muted);
  white-space: nowrap;
}
.speech-storage-note i {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--success); margin-right: 5px; vertical-align: 1px;
}

.speech-toggle-row {
  display: flex; gap: var(--s-3); align-items: flex-start;
  padding: var(--s-3);
  background: var(--bg-deep);
  border-radius: var(--r-md);
  cursor: pointer;
}
.speech-toggle-copy strong { display: block; font-size: var(--fs-label-sm); color: var(--text-primary); }
.speech-toggle-copy small { display: block; font-size: var(--fs-label-xs); color: var(--text-muted); margin-top: 2px; }
.speech-toggle-row-sub { margin-top: var(--s-3); }

.speech-settings-grid-words { margin-top: var(--s-3); }

.speech-settings-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3);
  margin-top: var(--s-3);
}
.speech-field { display: block; }
.speech-field > span { display: block; font-size: var(--fs-label-sm); color: var(--text-primary); margin-bottom: 6px; }
.speech-field > span i {
  font-style: normal; font-size: var(--fs-mono-xs); color: var(--text-muted);
  margin-right: 4px;
}
.speech-field > small { display: block; font-size: var(--fs-label-xs); color: var(--text-muted); margin-top: 5px; }
.speech-field code {
  font-family: var(--font-mono);
  font-size: var(--fs-mono-xs);
  background: var(--border-soft); padding: 1px 5px; border-radius: 5px;
}
.speech-field input {
  width: 100%; padding: var(--s-2) var(--s-3);
  background: var(--bg-deep);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  color: var(--text-primary);
  font-size: var(--fs-label-sm); outline: none;
}
.speech-field input:focus { border-color: var(--accent); }
.speech-key-field { display: flex; gap: 6px; }
.speech-key-field input { flex: 1; }
.speech-key-field button {
  padding: 0 var(--s-3); font-size: var(--fs-label-xs);
  background: var(--border-soft); color: var(--text-muted);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md); cursor: pointer; white-space: nowrap;
}

.speech-settings-actions {
  display: flex; justify-content: space-between; align-items: center;
  gap: var(--s-3); margin-top: var(--s-4);
}
.speech-test-status { font-size: var(--fs-label-xs); color: var(--text-muted); }
.speech-test-status[data-state='ok'] { color: var(--success-text); }
.speech-test-status[data-state='fail'] { color: var(--danger-text); }
.speech-settings-buttons { display: flex; gap: var(--s-2); }

.speech-http-hint {
  margin-top: var(--s-3); font-size: var(--fs-label-xs);
  color: var(--text-muted); line-height: var(--lh-body);
}
.speech-http-hint i {
  font-style: normal; display: inline-block; width: 15px; height: 15px; line-height: 15px;
  text-align: center; border-radius: 50%; font-size: var(--fs-mono-xs);
  background: var(--border-soft); margin-right: 5px;
}

@media (max-width: 600px) {
  .speech-settings-grid { grid-template-columns: 1fr; }
  .speech-settings-actions { flex-direction: column; align-items: stretch; }
  .speech-settings-buttons { justify-content: flex-end; }
}
</style>
