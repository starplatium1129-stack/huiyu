<template>
  <section class="chat-rp-panel room-tool-panel" aria-labelledby="chatRpTitle">
    <header class="room-tool-heading">
      <div>
        <h2 id="chatRpTitle">RP 预设与参数 · {{ characterName }}</h2>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭 RP 预设面板" @click="emit('close')">
        <ArchiveIcon name="close" />
      </button>
    </header>
    <div class="room-tool-body rp-panel-body">
      <section class="rp-card" aria-labelledby="rpPresetHeading">
        <div class="rp-card-head">
          <h3 id="rpPresetHeading">对话预设</h3>
          <div class="rp-card-actions">
            <button type="button" class="btn btn-ghost btn-sm" @click="startNewPreset">新建</button>
            <button v-if="!activePreset.builtin" type="button" class="btn btn-ghost btn-sm" @click="startEditPreset">编辑</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="presetFile?.click()">导入</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="exportCurrentPreset">导出</button>
            <button v-if="!activePreset.builtin" type="button" class="btn btn-danger btn-sm" @click="removeCustomPreset">删除</button>
          </div>
          <input ref="presetFile" type="file" accept=".json,application/json" hidden @change="onImportPreset" />
        </div>
        <div class="rp-preset-list" role="radiogroup" aria-label="选择对话预设">
          <button
            v-for="preset in allPresets"
            :key="preset.id"
            type="button"
            role="radio"
            class="rp-preset-chip"
            :class="{ active: rpState.activePresetId === preset.id }"
            :aria-checked="rpState.activePresetId === preset.id"
            @click="rp.selectPreset(preset.id)"
          >
            <strong>{{ preset.name }}</strong>
            <span v-if="preset.description">{{ preset.description }}</span>
          </button>
        </div>

        <form v-if="presetEditorOpen" class="rp-preset-form" @submit.prevent="savePresetForm">
          <label class="studio-field-label" for="rp-preset-name">预设名称</label>
          <input id="rp-preset-name" v-model="presetDraft.name" class="input" maxlength="60" placeholder="例如：第三人称轻小说" required />
          <label class="studio-field-label" for="rp-preset-desc">说明（可选）</label>
          <input id="rp-preset-desc" v-model="presetDraft.description" class="input" maxlength="160" placeholder="简述用途或文风" />
          <label class="studio-field-label" for="rp-preset-prefix" v-pre>前置指令（System Prefix，支持 {{user}} / {{char}}）</label>
          <textarea id="rp-preset-prefix" v-model="presetDraft.systemPrefix" class="textarea rp-autosize" maxlength="4000" rows="3" placeholder="置于角色设定之前的叙事或文风规则"></textarea>
          <label class="studio-field-label" for="rp-preset-post" v-pre>末尾强化（Post-History，支持 {{user}} / {{char}}）</label>
          <textarea id="rp-preset-post" v-model="presetDraft.postHistory" class="textarea rp-autosize" maxlength="4000" rows="2" placeholder="插在对话末尾的格式或视角提醒"></textarea>
          <ToggleSwitch v-model="presetDraft.disableBubbleSplit" label="长段直出（不自动拆短气泡）">长段直出（不按手机消息拆分成多条短气泡）</ToggleSwitch>
          <div class="rp-form-actions">
            <button type="submit" class="btn btn-primary btn-sm">保存预设</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="presetEditorOpen = false">取消</button>
          </div>
        </form>
      </section>

      <section class="rp-card" aria-labelledby="rpGrowthHeading">
        <div class="rp-card-head">
          <h3 id="rpGrowthHeading">关系好感、状态栏与房间背景</h3>
          <span v-if="affectionLevel" class="rp-meta">Lv.{{ affectionLevel.level }} {{ affectionLevel.title }} · {{ affectionScore }}/100</span>
        </div>
        <div class="rp-toggle-stack">
          <ToggleSwitch :model-value="rpState.affectionPromptEnabled" label="好感度注入与互动推进" @update:model-value="rp.setAffectionPromptEnabled($event)">
            将好感阶段注入对话上下文，并在每轮互动中推进好感
          </ToggleSwitch>
          <ToggleSwitch :model-value="rpState.statusBarEnabled" label="自动附带状态栏" @update:model-value="rp.setStatusBarEnabled($event)">
            自动附带 &lt;status&gt; 状态栏（实时同步好感、心情、地点与穿着）
          </ToggleSwitch>
        </div>
        <div v-if="affection" class="rp-inline-row">
          <label class="studio-field-label" for="rp-affection-range">手动微调好感（{{ affectionLevel?.description }}）</label>
          <input
            id="rp-affection-range"
            type="range"
            min="0"
            max="100"
            :value="affectionScore"
            @input="onAffectionRange($event)"
          />
        </div>
        <div v-if="sceneState" class="rp-number-grid">
          <label>
            <span>当前地点</span>
            <input class="input" maxlength="80" placeholder="例如：打烊后的咖啡馆"
              :value="currentScene.location" @change="onSceneField('location', $event)" />
          </label>
          <label>
            <span>当前穿着</span>
            <input class="input" maxlength="160" placeholder="例如：黑色宽松居家卫衣"
              :value="currentScene.outfit" @change="onSceneField('outfit', $event)" />
          </label>
        </div>
        <div v-if="roomBackground" class="rp-bg-controls">
          <template v-if="roomBackground.entry.value">
            <div class="rp-inline-row">
              <ToggleSwitch :model-value="roomBackground.entry.value.enabled" label="启用动态房间背景" @update:model-value="roomBackground.setEnabled($event)">
                显示聊天室背景图（{{ roomBackground.entry.value.image.name }}）
              </ToggleSwitch>
              <button type="button" class="btn btn-quiet btn-sm" @click="roomBackground.clearBackground()">恢复默认背景</button>
            </div>
            <label class="rp-inline-row">
              <span class="studio-field-label">背景柔化透明度（{{ Math.round(roomBackground.entry.value.opacity * 100) }}%）</span>
              <input type="range" min="0.12" max="0.45" step="0.02"
                :value="roomBackground.entry.value.opacity"
                @input="roomBackground.setOpacity(Number(($event.target as HTMLInputElement).value))" />
            </label>
          </template>
          <p v-else class="rp-help">提示：点击任意对话图片查看大图，在右上角点「场景」图标即可将其设为当前角色的聊天室背景。</p>
        </div>
      </section>

      <section class="rp-card" aria-labelledby="rpNoteHeading">
        <div class="rp-card-head">
          <h3 id="rpNoteHeading">导演指令（Author's Note）</h3>
          <ToggleSwitch :model-value="noteDraft.enabled" label="启用导演指令" @update:model-value="updateNote({ enabled: $event })">启用</ToggleSwitch>
        </div>
        <p class="rp-help">仅作用于 {{ characterName }}。按指定深度插进最近对话，随时扭转文风、场景氛围或剧情阶段。</p>
        <div class="rp-inline-row">
          <label class="studio-field-label" for="rp-note-depth">注入深度（0 = 紧贴最新回复）</label>
          <input
            id="rp-note-depth"
            type="number"
            class="input rp-depth-input"
            min="0"
            max="24"
            :value="noteDraft.depth"
            @change="onDepthChange($event)"
          />
        </div>
        <label class="sr-only" for="rp-note-text">导演指令内容</label>
        <textarea
          id="rp-note-text"
          :value="noteDraft.text"
          class="textarea rp-autosize"
          maxlength="2000"
          rows="3"
          placeholder="例如：现在是暴雨夜的咖啡店打烊后，灯光昏暗，用细腻心理描写推进。"
          @input="onNoteInput($event)"
        ></textarea>
      </section>

      <section class="rp-card" aria-labelledby="rpBudgetHeading">
        <div class="rp-card-head">
          <h3 id="rpBudgetHeading">上下文窗口预算</h3>
          <span class="rp-meta">{{ rpState.contextBudget.maxMessages }} 条 · {{ Math.round(rpState.contextBudget.maxChars / 1000) }}K 字</span>
        </div>
        <div class="rp-tier-segments studio-segments studio-segments--compact" role="radiogroup" aria-label="上下文窗口档位">
          <AnimatedSelection />
          <button
            v-for="tier in CONTEXT_BUDGET_TIERS"
            :key="tier.id"
            type="button"
            role="radio"
            :aria-checked="isTierActive(tier.maxMessages, tier.maxChars)"
            :class="{ active: isTierActive(tier.maxMessages, tier.maxChars) }"
            @click="rp.setContextBudget({ maxMessages: tier.maxMessages, maxChars: tier.maxChars })"
          >
            {{ tier.label }}
          </button>
        </div>
        <div class="rp-number-grid">
          <label>
            <span>最大消息条数（8–120）</span>
            <input
              type="number"
              class="input"
              min="8"
              max="120"
              :value="rpState.contextBudget.maxMessages"
              @change="onBudgetChange('maxMessages', $event)"
            />
          </label>
          <label>
            <span>最大字符预算（4K–120K）</span>
            <input
              type="number"
              class="input"
              min="4000"
              max="120000"
              step="2000"
              :value="rpState.contextBudget.maxChars"
              @change="onBudgetChange('maxChars', $event)"
            />
          </label>
        </div>
      </section>

      <details class="rp-disclosure">
        <summary class="rp-disclosure-summary">
          <ArchiveIcon class="rp-disclosure-chevron" name="chevron-down" />
          <span>采样参数（Temperature / Top-P / Max Tokens）</span>
        </summary>
        <div class="rp-disclosure-body">
          <p class="rp-help">
            留空表示跟随模型默认（当前模式：{{ provider === 'chatgpt' ? 'ChatGPT 订阅通道将忽略采样参数' : 'API 与 Ollama 生效' }}）。
          </p>
          <div class="rp-number-grid">
            <label>
              <span>Temperature (0–2)</span>
              <input type="number" class="input" min="0" max="2" step="0.05" placeholder="默认"
                :value="rpState.sampling.temperature ?? ''" @change="onSamplingChange('temperature', $event)" />
            </label>
            <label>
              <span>Top P (0–1)</span>
              <input type="number" class="input" min="0" max="1" step="0.05" placeholder="默认"
                :value="rpState.sampling.topP ?? ''" @change="onSamplingChange('topP', $event)" />
            </label>
            <label>
              <span>Max Tokens (64–16384)</span>
              <input type="number" class="input" min="64" max="16384" step="64" placeholder="默认"
                :value="rpState.sampling.maxTokens ?? ''" @change="onSamplingChange('maxTokens', $event)" />
            </label>
            <label>
              <span>Frequency Penalty (-2–2)</span>
              <input type="number" class="input" min="-2" max="2" step="0.05" placeholder="默认"
                :value="rpState.sampling.frequencyPenalty ?? ''" @change="onSamplingChange('frequencyPenalty', $event)" />
            </label>
            <label>
              <span>Presence Penalty (-2–2)</span>
              <input type="number" class="input" min="-2" max="2" step="0.05" placeholder="默认"
                :value="rpState.sampling.presencePenalty ?? ''" @change="onSamplingChange('presencePenalty', $event)" />
            </label>
          </div>
          <div class="rp-form-actions">
            <button type="button" class="btn btn-ghost btn-sm" @click="rp.resetSampling()">恢复全部默认</button>
          </div>
        </div>
      </details>

      <details class="rp-disclosure">
        <summary class="rp-disclosure-summary">
          <ArchiveIcon class="rp-disclosure-chevron" name="chevron-down" />
          <span>显示正则替换（{{ rpState.regexRules.length }} 条）</span>
        </summary>
        <div class="rp-disclosure-body">
          <p class="rp-help">仅在界面渲染阶段替换或清理指定标签（如多余的 OOC/标记），不改动原始聊天存档。</p>
          <div v-if="rpState.regexRules.length" class="rp-regex-list">
            <article v-for="rule in rpState.regexRules" :key="rule.id" class="rp-regex-item">
              <div class="rp-regex-meta">
                <strong>{{ rule.name }}</strong>
                <code>/{{ rule.pattern }}/{{ rule.flags }}</code>
              </div>
              <div class="rp-regex-controls">
                <ToggleSwitch :model-value="rule.enabled" :label="`启用规则 ${rule.name}`" @update:model-value="rp.toggleRegexRule(rule.id, $event)" />
                <button type="button" class="btn btn-quiet btn-sm" @click="rp.deleteRegexRule(rule.id)">删除</button>
              </div>
            </article>
          </div>
          <form class="rp-regex-form" @submit.prevent="addRegexRule">
            <div class="rp-number-grid">
              <label>
                <span>规则名称</span>
                <input v-model="regexDraft.name" class="input" maxlength="60" placeholder="例如：隐藏 OOC 注释" />
              </label>
              <label>
                <span>标志</span>
                <input v-model="regexDraft.flags" class="input" maxlength="8" placeholder="g" />
              </label>
            </div>
            <label class="studio-field-label" for="rp-regex-pattern">匹配正则</label>
            <input id="rp-regex-pattern" v-model="regexDraft.pattern" class="input" maxlength="200" placeholder="例如：\(OOC:[\s\S]*?\)" />
            <label class="studio-field-label" for="rp-regex-replace">替换为（留空即删除匹配内容）</label>
            <input id="rp-regex-replace" v-model="regexDraft.replacement" class="input" maxlength="500" placeholder="留空或填写替换文本" />
            <p v-if="regexError" class="rp-error" role="status">{{ regexError }}</p>
            <div class="rp-form-actions">
              <button type="submit" class="btn btn-ghost btn-sm">添加正则规则</button>
            </div>
          </form>
        </div>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { useChatRpPanel } from '@/composables/chat/useChatRpPanel'
import type { useChatRpSettings } from '@/composables/chat/useChatRpSettings'
import type { useCompanionAffection } from '@/composables/useCompanionAffection'
import type { useChatSceneState } from '@/composables/chat/useChatSceneState'
import type { useChatRoomBackground } from '@/composables/chat/useChatRoomBackground'

const props = defineProps<{
  rp: ReturnType<typeof useChatRpSettings>
  characterId: string
  characterName: string
  provider: string
  affection?: ReturnType<typeof useCompanionAffection>
  sceneState?: ReturnType<typeof useChatSceneState>
  roomBackground?: ReturnType<typeof useChatRoomBackground>
}>()

const emit = defineEmits<{
  close: []
  notice: [message: string, kind?: 'info' | 'warning' | 'error']
}>()

const {
  CONTEXT_BUDGET_TIERS, rpState, allPresets, activePreset, noteDraft,
  affectionScore, affectionLevel, currentScene, onAffectionRange, onSceneField,
  presetFile, presetEditorOpen, presetDraft, startNewPreset, startEditPreset,
  savePresetForm, removeCustomPreset, exportCurrentPreset, onImportPreset,
  updateNote, onNoteInput, onDepthChange, isTierActive, onBudgetChange,
  onSamplingChange, regexDraft, regexError, addRegexRule,
} = useChatRpPanel(props, emit)
</script>

<style scoped>
.rp-panel-body { gap:var(--s-4); }
.rp-card { display:grid; gap:var(--s-3); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.rp-card-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-2); }
.rp-card-head h3 { margin:0; font:600 var(--fs-body-sm)/var(--lh-tight) var(--font-sans); color:var(--text-primary); }
.rp-card-actions { display:flex; flex-wrap:wrap; gap:var(--s-1); }
.rp-meta { color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-label) var(--font-mono); }
.rp-help { margin:0; color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-body) var(--font-sans); }
.rp-preset-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:var(--s-2); }
.rp-preset-chip { display:grid; gap:2px; padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); color:var(--text-primary); text-align:left; cursor:pointer; }
.rp-preset-chip strong { font:600 var(--fs-label)/var(--lh-tight) var(--font-sans); }
.rp-preset-chip span { color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-body) var(--font-sans); }
.rp-preset-chip:hover { background:var(--bg-hover); }
.rp-preset-chip.active { border-color:var(--accent); background:var(--accent-soft); }
.rp-preset-form, .rp-regex-form { display:grid; gap:var(--s-2); padding-top:var(--s-2); border-top:1px solid var(--border-soft); }
.rp-autosize { width:100%; height:auto; min-block-size:3lh; max-block-size:10lh; resize:vertical; }
@supports (field-sizing:content) { .rp-autosize { field-sizing:content; resize:none; } }
.rp-inline-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--s-2); }
.rp-toggle-stack { display:grid; gap:var(--s-2); }
.rp-bg-controls { display:grid; gap:var(--s-2); padding-top:var(--s-2); border-top:1px solid var(--border-soft); }
.rp-depth-input { width:84px; }
.rp-tier-segments { flex-wrap:wrap; }
.rp-number-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:var(--s-2); }
.rp-number-grid > label { display:grid; gap:4px; color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.rp-form-actions { display:flex; gap:var(--s-2); justify-content:flex-end; }
.rp-disclosure { border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); overflow:hidden; }
.rp-disclosure-summary { list-style:none; display:flex; align-items:center; gap:var(--s-2); padding:var(--s-3); font:600 var(--fs-body-sm)/var(--lh-tight) var(--font-sans); color:var(--text-primary); cursor:pointer; user-select:none; }
.rp-disclosure-summary::-webkit-details-marker { display:none; }
.rp-disclosure-summary:hover { background:var(--bg-hover); }
.rp-disclosure-summary:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.rp-disclosure-chevron { width:16px; height:16px; flex:none; transform:rotate(-90deg); transition:transform var(--motion-control) var(--ease-out); }
.rp-disclosure[open] > .rp-disclosure-summary .rp-disclosure-chevron { transform:rotate(0deg); }
.rp-disclosure::details-content { interpolate-size:allow-keywords; overflow:clip; contain:layout; }
.rp-disclosure:not([open])::details-content { block-size:0; }
.rp-disclosure-body { padding:0 var(--s-3) var(--s-3); display:grid; gap:var(--s-3); }
.rp-regex-list { display:grid; gap:var(--s-2); }
.rp-regex-item { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); }
.rp-regex-meta { display:grid; gap:2px; min-width:0; }
.rp-regex-meta strong { font:500 var(--fs-label)/var(--lh-tight) var(--font-sans); }
.rp-regex-meta code { color:var(--text-secondary); font:400 var(--fs-label-xs)/var(--lh-label) var(--font-mono); overflow-wrap:anywhere; }
.rp-regex-controls { display:flex; align-items:center; gap:var(--s-2); flex:none; }
.rp-error { margin:0; color:var(--danger-text); font:400 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
@media (prefers-reduced-motion:no-preference) {
  .rp-disclosure::details-content { transition:block-size var(--motion-route) var(--ease-out), content-visibility var(--motion-route) allow-discrete; }
}
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .rp-disclosure-chevron { transition:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced']) .rp-disclosure-chevron,
:root:is([data-motion='reduce'],[data-motion='reduced']) .rp-disclosure::details-content { transition:none; }
</style>
