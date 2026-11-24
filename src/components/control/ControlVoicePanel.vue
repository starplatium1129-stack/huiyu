<template>
  <div class="control-panel-stack voice-panel">
    <section class="panel-card voice-summary" aria-label="当前语音状态">
      <div class="voice-summary-head">
        <div>
          <span class="panel-kicker">当前语音方案 · 即时生效</span>
          <h2 class="panel-heading">{{ currentEngineLabel }}</h2>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="setupLoading || saving" @click="refreshSetup">
          <ArchiveIcon name="refresh" />{{ setupLoading ? '检查中…' : '刷新检查' }}
        </button>
      </div>
      <p v-if="notice" class="voice-feedback" role="status">{{ notice }}</p>
      <p v-if="localError || setupError" class="voice-error" role="alert">{{ localError || setupError }}</p>
    </section>

    <section class="panel-card">
      <fieldset class="voice-mode-fieldset">
        <legend class="voice-mode-legend">语音方式</legend>
        <div class="voice-mode-grid">
          <label class="voice-mode-card" :data-selected="activeModeGroup === 'system'">
            <input type="radio" name="voice-mode-group" value="system" :checked="activeModeGroup === 'system'" :disabled="saving" @change="applyEngine('system')" />
            <div class="voice-mode-copy">
              <div class="voice-mode-title"><ArchiveIcon name="sound" /><strong>系统朗读</strong><span class="voice-badge">默认</span></div>
              <p>本机语音 · 零下载 · 零显存</p>
            </div>
          </label>

          <label class="voice-mode-card" :data-selected="activeModeGroup === 'openai-tts'">
            <input type="radio" name="voice-mode-group" value="openai-tts" :checked="activeModeGroup === 'openai-tts'" :disabled="saving" @change="selectedView = 'openai-tts'" />
            <div class="voice-mode-copy">
              <div class="voice-mode-title"><ArchiveIcon name="spark" /><strong>云端语音接口</strong><span class="voice-badge">OpenAI 兼容</span></div>
              <p>硅基流动 · OpenAI TTS · 零显存</p>
            </div>
          </label>

          <label class="voice-mode-card" :data-selected="activeModeGroup === 'local'">
            <input type="radio" name="voice-mode-group" value="local" :checked="activeModeGroup === 'local'" :disabled="saving" @change="selectedView = 'local'" />
            <div class="voice-mode-copy">
              <div class="voice-mode-title"><ArchiveIcon name="folder" /><strong>本机角色语音</strong><span class="voice-badge">本地语音包</span></div>
              <p>GPT-SoVITS · VoxCPM2 专属声线</p>
            </div>
          </label>

          <label class="voice-mode-card" :data-selected="activeModeGroup === 'off'">
            <input type="radio" name="voice-mode-group" value="off" :checked="activeModeGroup === 'off'" :disabled="saving" @change="applyEngine('off')" />
            <div class="voice-mode-copy">
              <div class="voice-mode-title"><ArchiveIcon name="mute" /><strong>关闭语音</strong><span class="voice-badge">纯文字</span></div>
              <p>仅文字回复</p>
            </div>
          </label>
        </div>
      </fieldset>
    </section>

    <section v-if="shownSection === 'system'" class="panel-card voice-detail-card" aria-label="系统朗读设置">
      <div class="voice-card-head">
        <h3 class="panel-heading">系统朗读</h3>
        <button v-if="currentEngine !== 'system'" class="btn btn-primary btn-sm" type="button" :disabled="saving" @click="applyEngine('system')">
          设为当前方式
        </button>
      </div>
      <p v-if="!speechSupported" class="control-section-note" role="status">未检测到系统语音合成接口，建议改用云端语音接口。</p>
      <div class="voice-action-row">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="!speechSupported || systemPreviewBusy === 'nene'" @click="previewSystemCharacter('nene')">
          <ArchiveIcon name="nene" />试听宁宁
        </button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="!speechSupported || systemPreviewBusy === 'natsume'" @click="previewSystemCharacter('natsume')">
          <ArchiveIcon name="natsume" />试听夏目
        </button>
      </div>
    </section>

    <section v-else-if="shownSection === 'openai-tts'" class="panel-card voice-detail-card" aria-label="云端语音接口设置">
      <div class="voice-card-head">
        <h3 class="panel-heading">云端语音接口（OpenAI `/audio/speech` 兼容）</h3>
        <div class="voice-presets" role="group" aria-label="快速填入常用接口">
          <button class="btn btn-quiet btn-sm" type="button" @click="applyApiPreset('siliconflow')">填入硅基流动</button>
          <button class="btn btn-quiet btn-sm" type="button" @click="applyApiPreset('openai')">填入 OpenAI</button>
          <button class="btn btn-quiet btn-sm" type="button" @click="applyApiPreset('custom')">清空自定义</button>
        </div>
      </div>

      <form class="voice-form" @submit.prevent="saveOpenAiTts">
        <div class="voice-form-grid">
          <div class="voice-field">
            <label :for="ids.baseUrl">接口地址（Base URL）</label>
            <input :id="ids.baseUrl" v-model.trim="apiBaseUrl" class="input input-mono" type="url" placeholder="https://api.siliconflow.cn/v1" spellcheck="false" required />
          </div>
          <div class="voice-field">
            <label :for="ids.model">模型名称</label>
            <input :id="ids.model" v-model.trim="apiModel" class="input input-mono" type="text" placeholder="FunAudioLLM/CosyVoice2-0.5B" spellcheck="false" required />
          </div>
          <div class="voice-field voice-field-span">
            <label :for="ids.apiKey">访问密钥（API Key）</label>
            <div class="voice-key-row">
              <input :id="ids.apiKey" v-model.trim="apiKey" class="input input-mono" :type="showApiKey ? 'text' : 'password'"
                :placeholder="hasSavedApiKey && !clearApiKey ? '已安全保存密钥（留空则继续沿用）' : '填写 Bearer 密钥（本地网关接口可留空）'"
                autocomplete="off" spellcheck="false" />
              <button class="btn btn-ghost btn-sm" type="button" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
            </div>
            <label v-if="hasSavedApiKey" class="voice-inline-check">
              <input v-model="clearApiKey" type="checkbox" /><span>清除已保存密钥</span>
            </label>
          </div>
          <div class="voice-field">
            <label :for="ids.voiceNene">绫地宁宁 · Voice ID</label>
            <input :id="ids.voiceNene" v-model.trim="apiVoiceNene" class="input input-mono" type="text" placeholder="FunAudioLLM/CosyVoice2-0.5B:anna" spellcheck="false" />
          </div>
          <div class="voice-field">
            <label :for="ids.voiceNatsume">四季夏目 · Voice ID</label>
            <input :id="ids.voiceNatsume" v-model.trim="apiVoiceNatsume" class="input input-mono" type="text" placeholder="FunAudioLLM/CosyVoice2-0.5B:bella" spellcheck="false" />
          </div>
          <div class="voice-field">
            <label :for="ids.defaultVoice">默认备用音色</label>
            <input :id="ids.defaultVoice" v-model.trim="apiDefaultVoice" class="input input-mono" type="text" placeholder="alloy" spellcheck="false" />
          </div>
          <div class="voice-field">
            <label :for="ids.format">音频格式</label>
            <StudioSelect :id="ids.format" v-model="apiFormat" label="音频格式"
              :options="[{ value: 'mp3', label: 'MP3（通用）' }, { value: 'wav', label: 'WAV（无损）' }, { value: 'opus', label: 'Opus（轻量）' }, { value: 'aac', label: 'AAC' }]" />
          </div>
        </div>

        <div class="voice-action-row">
          <button class="btn btn-primary btn-sm" type="submit" :disabled="saving || apiTesting">
            {{ saving ? '保存中…' : '保存并立即生效' }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="saving || apiTesting" @click="testOpenAiTts">
            {{ apiTesting ? '试听请求中…' : '试听接口' }}
          </button>
        </div>
      </form>

      <div v-if="testAudioUrl" class="voice-preview-player">
        <span class="setup-label">接口试听回放</span>
        <audio controls :src="testAudioUrl" />
      </div>
    </section>

    <section v-else-if="shownSection === 'local'" class="panel-card voice-detail-card" aria-label="本机角色语音设置">
      <div class="voice-card-head">
        <h3 class="panel-heading">本机角色语音</h3>
      </div>

      <div class="voice-form-grid">
        <div class="voice-field">
          <label :for="ids.localEngine">本机引擎类型</label>
          <StudioSelect :id="ids.localEngine" v-model="localEngine" label="本机引擎类型"
            :options="[
              { value: 'gpt-sovits-native', label: 'GPT-SoVITS 本机推理（推荐）' },
              { value: 'gpt-sovits', label: 'GPT-SoVITS 外部接口' },
              { value: 'voxcpm2', label: 'VoxCPM2（流式 PCM）' },
            ]" />
        </div>
        <div class="voice-field">
          <label :for="ids.targetChar">目录归属角色</label>
          <StudioSelect
            :id="ids.targetChar"
            v-model="packTargetChar"
            label="目录归属角色"
            :groups="packTargetGroups"
            searchable
            search-placeholder="搜索角色名或角色 ID…"
            empty-text="没有找到匹配的角色"
          />
        </div>
        <div class="voice-field voice-field-span">
          <label :for="ids.packPath">语音包文件夹（自动识别 .ckpt / .pth 与参考音频）</label>
          <div class="voice-key-row">
            <input :id="ids.packPath" v-model.trim="packFolderPath" class="input input-mono" type="text" placeholder="选择包含 .ckpt / .pth 与参考音频的目录" spellcheck="false" />
            <button v-if="desktop" class="btn btn-ghost btn-sm" type="button" :disabled="packBusy || saving" @click="pickPackFolder">
              <ArchiveIcon name="folder" />选择文件夹
            </button>
          </div>
        </div>
      </div>

      <div class="voice-action-row">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="packBusy || saving" @click="scanOrApplyPack(false)">
          {{ packBusy ? '扫描中…' : '扫描目录文件' }}
        </button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="packBusy || saving" @click="scanOrApplyPack(true)">
          {{ packBusy || saving ? '处理中…' : '导入并启用本机语音' }}
        </button>
        <button v-if="currentEngine !== localEngine" class="btn btn-quiet btn-sm" type="button" :disabled="saving" @click="applyEngine(localEngine)">
          仅切换为{{ localEngine === 'voxcpm2' ? ' VoxCPM2' : localEngine === 'gpt-sovits-native' ? '本机 GPT-SoVITS' : '外部 GPT-SoVITS' }}
        </button>
      </div>

      <div v-if="packPreview" class="voice-pack-preview" role="status">
        <strong>已识别文件（{{ packPreview.detectedFiles.length }}）</strong>
        <ul>
          <li v-for="file in packPreview.detectedFiles" :key="file"><code>{{ file }}</code></li>
        </ul>
        <p v-for="warn in packPreview.warnings" :key="warn" class="voice-warn">{{ warn }}</p>
        <div v-if="packPreview.warnings.length" class="voice-field voice-prompt-override">
          <label :for="ids.packPrompt">参考音频台词（若包内缺少 .txt，可在此补填后直接导入）</label>
          <input :id="ids.packPrompt" v-model.trim="packPromptOverride" class="input" type="text" placeholder="填入参考音频对应的日文/中文原台词" spellcheck="false" />
        </div>
      </div>

      <details class="voice-diagnostics">
        <StudioDisclosureSummary>已配置声线（{{ profileEntries.filter(p => p.ready).length }} / {{ profileEntries.length }} 就绪）与环境检查</StudioDisclosureSummary>
        <div class="voice-diag-body" data-disclosure-content>
          <ul v-if="profileEntries.length" class="voice-check-list">
            <li v-for="entry in profileEntries" :key="entry.id" class="voice-profile-row">
              <div class="voice-profile-main">
                <ArchiveIcon :name="entry.ready ? 'success' : entry.configured ? 'warning' : 'info'" />
                <span>
                  <strong>{{ entry.displayName }}</strong>
                  <code class="voice-profile-id">{{ entry.id }}</code>
                  <span v-if="entry.catalogId" class="voice-profile-meta"> · {{ entry.catalogId }}</span>
                  <span class="voice-profile-meta"> · {{ entry.ready ? '就绪' : entry.configured ? '缺少文件' : '未配置' }}</span>
                </span>
              </div>
              <button
                v-if="!entry.builtin"
                class="btn btn-quiet btn-sm"
                type="button"
                :disabled="removingProfileId === entry.id || saving"
                @click="removeVoiceProfile(entry.id)"
              >
                {{ removingProfileId === entry.id ? '移除中…' : '移除' }}
              </button>
            </li>
          </ul>
          <ul v-if="setupStatus" class="voice-check-list">
            <li><ArchiveIcon :name="setupStatus.checks.gptSovitsEnv ? 'success' : 'warning'" /><span>GPT-SoVITS-env Python：{{ setupStatus.checks.gptSovitsEnv ? '已发现' : '未发现' }}</span></li>
            <li><ArchiveIcon :name="setupStatus.checks.gptSovitsDir ? 'success' : 'warning'" /><span>GPT-SoVITS 源码目录：{{ setupStatus.checks.gptSovitsDir ? '已发现' : '未发现' }}</span></li>
            <li><ArchiveIcon :name="setupStatus.checks.ttsInferConfig ? 'success' : 'warning'" /><span>tts_infer.yaml 配置：{{ setupStatus.checks.ttsInferConfig ? '已发现' : '未发现' }}</span></li>
            <li><ArchiveIcon :name="setupStatus.checks.voxcpmDir ? 'success' : 'info'" /><span>VoxCPM 目录：{{ setupStatus.checks.voxcpmDir ? '已发现' : '未安装（可选）' }}</span></li>
          </ul>
          <p v-if="setupStatus?.packs?.length" class="control-section-note">语音包清单：已登记 {{ setupStatus.packs.length }} 项</p>
        </div>
      </details>
    </section>

    <section v-else class="panel-card voice-detail-card" aria-label="语音已关闭">
      <div class="voice-card-head">
        <h3 class="panel-heading">已关闭语音朗读</h3>
        <button class="btn btn-primary btn-sm" type="button" :disabled="saving" @click="applyEngine('system')">开启系统朗读</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { useVoiceConfigPanel } from '@/composables/useVoiceConfigPanel'

const {
  setupStatus, setupLoading, setupError, notice, localError, saving,
  currentEngine, currentEngineLabel, activeModeGroup, localEngine, speechSupported, systemPreviewBusy,
  apiBaseUrl, apiKey, showApiKey, clearApiKey, apiModel, apiVoiceNene, apiVoiceNatsume, apiDefaultVoice,
  apiFormat, hasSavedApiKey, apiTesting, testAudioUrl, desktop,
  packFolderPath, packTargetChar, packTargetGroups, packPromptOverride, packBusy, packPreview,
  profileEntries, removingProfileId,
  refreshSetup, applyEngine, previewSystemCharacter, applyApiPreset, saveOpenAiTts, testOpenAiTts,
  pickPackFolder, scanOrApplyPack, removeVoiceProfile,
} = useVoiceConfigPanel()

const selectedView = ref<'system' | 'openai-tts' | 'local' | 'off'>(activeModeGroup.value)
watch(activeModeGroup, value => { selectedView.value = value }, { immediate: true })
const shownSection = computed(() => selectedView.value)

const ids = {
  baseUrl: useId(),
  model: useId(),
  apiKey: useId(),
  voiceNene: useId(),
  voiceNatsume: useId(),
  defaultVoice: useId(),
  format: useId(),
  localEngine: useId(),
  targetChar: useId(),
  packPath: useId(),
  packPrompt: useId(),
}
</script>

<style scoped>
.voice-summary-head, .voice-card-head { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:var(--s-3); }
.voice-feedback { margin:var(--s-3) 0 0; color:var(--success-text); font-size:var(--fs-label); }
.voice-error, .voice-warn { margin:var(--s-3) 0 0; color:var(--danger-text); font-size:var(--fs-label); }
.voice-mode-fieldset { margin:0; padding:0; border:0; }
.voice-mode-legend { margin-bottom:var(--s-3); font-size:var(--fs-label); font-weight:600; color:var(--text-primary); }
.voice-mode-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-3); }
.voice-mode-card { display:flex; align-items:flex-start; gap:var(--s-3); padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); cursor:pointer; }
.voice-mode-card[data-selected='true'] { border-color:var(--accent); background:var(--bg-elevated); }
.voice-mode-card input { margin-top:var(--s-1); flex-shrink:0; }
.voice-mode-copy { display:grid; gap:var(--s-2); min-width:0; }
.voice-mode-copy p { margin:0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.voice-mode-title { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.voice-mode-title .archive-icon { width:18px; height:18px; color:var(--accent); flex-shrink:0; }
.voice-badge { padding:2px var(--s-2); border-radius:var(--r-pill); background:var(--bg-surface); border:1px solid var(--border-soft); color:var(--text-secondary); font-size:var(--fs-label-xs); }
.voice-detail-card { display:grid; gap:var(--s-4); }
.voice-presets { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.voice-form { display:grid; gap:var(--s-4); }
.voice-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-4); }
.voice-field { display:grid; gap:var(--s-2); min-width:0; }
.voice-field-span { grid-column:1 / -1; }
.voice-field label { font-size:var(--fs-label-sm); color:var(--text-secondary); }
.voice-key-row { display:flex; gap:var(--s-2); align-items:center; }
.voice-key-row .input { flex:1; min-width:0; }
.voice-inline-check { display:inline-flex; align-items:center; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-xs); }
.voice-action-row { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-3); }
.voice-preview-player { display:grid; gap:var(--s-2); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); }
.voice-preview-player audio { width:100%; }
.voice-pack-preview { padding:var(--s-3); border-radius:var(--r-md); background:var(--bg-base); border:1px solid var(--border-soft); font-size:var(--fs-label-sm); }
.voice-pack-preview ul, .voice-check-list { margin:var(--s-2) 0 0; padding:0; list-style:none; display:grid; gap:var(--s-2); }
.voice-check-list li { display:flex; align-items:center; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.voice-check-list .archive-icon { width:16px; height:16px; flex-shrink:0; }
.voice-diagnostics { border-top:1px solid var(--border-soft); padding-top:var(--s-2); }
.voice-diag-body { display:grid; gap:var(--s-3); padding-top:var(--s-3); }
.voice-prompt-override { margin-top:var(--s-3); }
.voice-profile-row { justify-content:space-between; gap:var(--s-3); }
.voice-profile-main { display:flex; align-items:center; gap:var(--s-2); min-width:0; }
.voice-profile-id { margin-left:var(--s-2); padding:1px var(--s-2); border-radius:var(--r-sm); background:var(--bg-surface); font-size:var(--fs-label-xs); }
.voice-profile-meta { color:var(--text-tertiary); font-size:var(--fs-label-xs); }
@media (max-width:768px) { .voice-mode-grid, .voice-form-grid { grid-template-columns:1fr; } }
</style>
