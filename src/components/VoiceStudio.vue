<template>
  <section class="voice-studio" aria-label="成片配音">
    <div class="voice-head">
      <div>
        <div class="voice-title">成片配音</div>
        <div class="voice-sub">中文字幕可单独保留；日文配音稿用于 GPT-SoVITS。</div>
      </div>
      <div class="voice-head-actions">
        <span class="voice-state" :class="voiceStateKind">{{ voiceStateLabel }}</span>
        <StudioTooltip :content="collapsed ? '展开配音面板' : '收起配音面板'">
          <button class="voice-collapse" type="button"
            :aria-expanded="!collapsed"
            :aria-label="collapsed ? '展开配音面板' : '收起配音面板'"
            @click="collapsed = !collapsed">
            <ArchiveIcon :name="collapsed ? 'expand' : 'compress'" />
          </button>
        </StudioTooltip>
      </div>
    </div>
    <div v-show="!collapsed" class="voice-body">
        <div class="voice-controls">
          <label class="voice-field">角色
            <StudioSelect v-model="voiceChar" label="角色" :options="[{ value: 'nene', label: '宁宁' }, { value: 'natsume', label: '夏目' }]" />
          </label>
          <label class="voice-field">语言
            <StudioSelect v-model="voiceLang" label="语言" :options="[{ value: 'ja', label: '日语配音' }, { value: 'zh', label: '中文配音' }]" />
          </label>
          <label class="voice-field">情绪
            <StudioSelect v-model="voiceEmotion" label="情绪" :options="VOICE_EMOTIONS.map(e => ({ value: e.id, label: e.label }))" />
          </label>
          <label class="voice-field">语速
            <StudioSelect v-model.number="voiceSpeed" label="语速" :options="[{ value: 0.85, label: '慢 0.85×' }, { value: 1, label: '正常 1.0×' }, { value: 1.15, label: '快 1.15×' }]" />
          </label>
        </div>
        <div class="voice-copy">
          <div class="voice-copy-head">
            <span class="voice-copy-title">中文字幕</span>
            <span class="voice-copy-note">画面旁白 / 台词</span>
          </div>
          <textarea class="voice-text voice-caption-text" v-model="voiceCaption" rows="3" placeholder="写下要配的中文台词或旁白…"></textarea>
        </div>
        <details class="voice-script-details" :open="voiceLang === 'ja'">
          <summary>日文 / 实际配音稿</summary>
          <textarea class="voice-text" v-model="voiceScript" rows="3" placeholder="日文配音稿；可从中文一键翻译"></textarea>
        </details>
        <div class="voice-actions">
          <button class="btn btn-ghost" type="button" :disabled="voiceBusy || !voiceCaption.trim() || voiceLang !== 'ja'" @click="translateVoice">翻译成日文</button>
          <button class="btn btn-ghost" type="button" :disabled="!voicePlayText" @click="previewVoice">系统试听</button>
          <button class="btn btn-primary" type="button" :disabled="voiceBusy || !voicePlayText" @click="generateVoice">
            {{ voiceBusy ? '生成中…' : '生成 AI 声线' }}
          </button>
          <button v-if="!voiceOnline" class="btn btn-ghost" type="button" :disabled="voiceBusy" @click="refreshVoiceStatus">重新检测</button>
        </div>
        <div class="voice-status">{{ voiceStatus }}</div>
        <RouterLink v-if="!voiceOnline" class="voice-recovery" to="/control">→ 到控制面板启动语音服务</RouterLink>
        <StudioMediaPlayer v-if="voiceAudioUrl" class="voice-audio show" kind="audio" :src="voiceAudioUrl" label="AI 声线试听" />
        <a v-if="voiceAudioUrl" class="btn btn-ghost voice-download show" :href="voiceAudioUrl" :download="voiceDownloadName">下载 WAV</a>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { useToast } from '@/composables/useToast'
import { voiceApi, type VoiceSynthesisPayload } from '@/api/voiceApi'
import '@/assets/css/director/components/VoiceStudio.css'

const props = defineProps<{
  /** 导演台角色切换时同步默认声线；用户仍可在本组件内手动改回来。 */
  initialVoice: 'nene' | 'natsume'
  /** 只在字幕为空时填入，绝不覆盖用户已经写好的配音稿。 */
  suggestedCaption?: string
}>()

const toast = useToast()
// 2026-08-30：配音使用频率低，默认折叠以省纵向空间；状态记忆在 localStorage（点击标题栏按钮展开/收起）。
// 无记录时默认折叠（用户从未点过 = 折叠），immediate 写入确保任意重挂载都读回一致状态。
const COLLAPSED_KEY = 'aics-voice-studio-collapsed'
const storedCollapsed = localStorage.getItem(COLLAPSED_KEY)
const collapsed = ref(storedCollapsed === null ? true : storedCollapsed === '1')
watch(collapsed, value => localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0'), { immediate: true })
const voiceChar = ref<'nene' | 'natsume'>(props.initialVoice)
const voiceLang = ref<'ja' | 'zh'>('ja')
const voiceCaption = ref('')
const lastSuggestedCaption = ref('')
const voiceScript = ref('')
const voiceStatus = ref('选择角色并写下中文字幕后，可翻译或直接生成声线。')
const voiceBusy = ref(false)
const voiceOnline = ref(false)
const voiceConfigured = ref(false)
const voiceAudioUrl = ref('')
let voiceObjectUrl = ''
const lifecycle = new AbortController()
const callOptions = { signal: lifecycle.signal }
let statusRequest = 0

const voiceEmotion = ref('neutral')
const voiceSpeed = ref(1)
const VOICE_EMOTIONS = [
  { id: 'neutral', label: '平静' }, { id: 'gentle', label: '温柔' },
  { id: 'happy', label: '开心' }, { id: 'shy', label: '害羞' },
  { id: 'serious', label: '认真' }, { id: 'sad', label: '难过' },
]

const voicePlayText = computed(() => (voiceLang.value === 'ja' ? voiceScript.value : voiceCaption.value).trim())
const voiceStateKind = computed(() => voiceBusy.value ? 'warn' : (voiceOnline.value && voiceConfigured.value ? 'ready' : 'warn'))
const voiceStateLabel = computed(() => {
  if (voiceBusy.value) return '生成中'
  if (voiceOnline.value && voiceConfigured.value) return 'AI 声线就绪'
  if (voiceOnline.value) return '声线未配置'
  return '语音未启动'
})
const voiceDownloadName = ref('')

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? '').trim() || fallback
}

async function refreshVoiceStatus() {
  const request = ++statusRequest
  const voice = voiceChar.value
  try {
    const data = await voiceApi.getStatus(callOptions)
    if (lifecycle.signal.aborted || request !== statusRequest) return
    voiceOnline.value = data.online
    voiceConfigured.value = Boolean(data.voices[voice])
    if (voiceBusy.value) return
    if (voiceOnline.value && voiceConfigured.value) {
      voiceStatus.value = 'GPT-SoVITS 已连接；可翻译或生成角色声线。'
      // 预热是 best-effort：失败只让首次合成稍慢，真实错误会在生成时展示。
      void voiceApi.prepare({ voice, translation: voiceLang.value === 'ja' }, callOptions).catch(() => {})
    } else if (voiceOnline.value) {
      voiceStatus.value = '语音服务在线，但当前角色参考音频尚未配置。'
    } else {
      voiceStatus.value = '语音服务未启动。可到控制面板启动 GPT-SoVITS。'
    }
  } catch {
    if (lifecycle.signal.aborted || request !== statusRequest || voiceBusy.value) return
    voiceOnline.value = false
    voiceConfigured.value = false
    voiceStatus.value = '无法读取语音状态。'
  }
}

function clearVoiceAudio() {
  if (voiceObjectUrl) { URL.revokeObjectURL(voiceObjectUrl); voiceObjectUrl = '' }
  voiceAudioUrl.value = ''
}

async function translateVoice() {
  if (voiceBusy.value) return
  const text = voiceCaption.value.trim()
  if (!text) { toast.warning('请先写下中文字幕'); return }
  voiceBusy.value = true
  voiceStatus.value = '正在本机翻译成日语…'
  try {
    const data = await voiceApi.translate(text, callOptions)
    if (lifecycle.signal.aborted) return
    if (voiceCaption.value.trim() !== text) { voiceStatus.value = '字幕已修改，请重新翻译。'; return }
    const translation = data.translation.trim()
    if (!translation) throw new Error('没有得到可用的日语译文')
    voiceScript.value = translation
    voiceStatus.value = '已生成日语配音稿；可直接生成角色语音，也可以先微调。'
  } catch (error) {
    if (lifecycle.signal.aborted) return
    voiceStatus.value = errorMessage(error, '翻译失败')
    toast.error(voiceStatus.value)
  } finally { voiceBusy.value = false }
}

function previewVoice() {
  if (!voicePlayText.value) { toast.warning('请先准备配音文本'); return }
  if (!('speechSynthesis' in window)) { voiceStatus.value = '当前浏览器没有系统语音朗读能力'; return }
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(voicePlayText.value)
  utterance.lang = voiceLang.value === 'ja' ? 'ja-JP' : 'zh-CN'
  utterance.rate = 1
  utterance.pitch = voiceChar.value === 'nene' ? 1.08 : 0.95
  utterance.onstart = () => { voiceStatus.value = '正在用本机系统声音试听（仅检查语速与文本）' }
  utterance.onend = () => { voiceStatus.value = '试听结束。满意后可生成 AI 角色声线。' }
  window.speechSynthesis.speak(utterance)
}

async function generateVoice() {
  if (voiceBusy.value) return
  const text = voicePlayText.value
  if (!text) { toast.warning('请先准备配音文本'); return }
  clearVoiceAudio()
  voiceBusy.value = true
  voiceStatus.value = '正在生成 AI 角色声线…'
  const payload: VoiceSynthesisPayload = {
    voice: voiceChar.value, text, language: voiceLang.value, emotion: voiceEmotion.value,
    // 平静使用当前角色主参考音频；不静默替换为温柔声线。
    referenceEmotion: voiceEmotion.value, consistency: 'locked', speed: voiceSpeed.value,
  }
  try {
    const status = await voiceApi.getStatus(callOptions)
    if (lifecycle.signal.aborted) return
    voiceOnline.value = status.online
    voiceConfigured.value = Boolean(status.voices[voiceChar.value])
    if (!status.voices[payload.voice]) throw new Error('当前角色还没配置参考音频，请到控制面板的「角色声线配置」填写。')
    // 预热失败不阻断合成；合成接口会返回可读的真实失败原因。
    await voiceApi.prepare({ voice: payload.voice, translation: payload.language === 'ja' }, callOptions).catch(() => {})
    if (lifecycle.signal.aborted) return
    const { blob, queueWaitMs } = await voiceApi.synthesize(payload, callOptions)
    if (lifecycle.signal.aborted) return
    voiceObjectUrl = URL.createObjectURL(blob)
    voiceAudioUrl.value = voiceObjectUrl
    voiceDownloadName.value = `aics_voice_${payload.voice}_${payload.language}_${Date.now()}.wav`
    voiceStatus.value = 'AI 声线已生成，可试听或下载 WAV。' + (queueWaitMs > 0 ? `（排队 ${Math.round(queueWaitMs / 100) / 10}s）` : '')
    toast.success('配音已生成')
  } catch (error) {
    if (lifecycle.signal.aborted) return
    voiceStatus.value = errorMessage(error, '语音生成失败')
    toast.error(voiceStatus.value)
  } finally { voiceBusy.value = false }
}

watch(() => props.initialVoice, voice => { voiceChar.value = voice })
watch(() => props.suggestedCaption, caption => {
  const nextCaption = caption?.trim() || ''
  // 场景切换时，若当前字幕仍是上一个场景自动填入的内容，就替换成新场景；
  // 用户手动改过字幕后则保留，避免“切场景”覆盖正在编辑的台词。
  const canReplace = !voiceCaption.value.trim() || voiceCaption.value.trim() === lastSuggestedCaption.value
  if (canReplace && nextCaption !== voiceCaption.value.trim()) {
    voiceCaption.value = nextCaption
    voiceScript.value = ''
    clearVoiceAudio()
  }
  lastSuggestedCaption.value = nextCaption
}, { immediate: true })
watch(voiceChar, () => { void refreshVoiceStatus() })
onMounted(() => { void refreshVoiceStatus() })
onUnmounted(() => { lifecycle.abort(); clearVoiceAudio() })

function setSuggestedCaption(caption: string) {
  const nextCaption = caption.trim()
  voiceCaption.value = nextCaption
  lastSuggestedCaption.value = nextCaption
  voiceScript.value = ''
  clearVoiceAudio()
}

defineExpose({ setSuggestedCaption })
</script>
