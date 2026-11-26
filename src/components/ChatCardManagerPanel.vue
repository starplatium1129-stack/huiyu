<template>
  <section class="chat-card-manager room-tool-panel" aria-labelledby="chatCardManagerTitle">
    <header class="room-tool-heading">
      <div>
        <span class="ccm-kicker">CHARACTER CARDS</span>
        <h2 id="chatCardManagerTitle">
          {{ mode === 'list' ? '角色卡工作台' : editingId ? `编辑角色卡 · ${draft.data.name || '未命名'}` : '新建空白角色卡' }}
        </h2>
      </div>
      <div class="ccm-head-actions">
        <button v-if="mode === 'edit'" type="button" class="btn btn-ghost btn-sm" @click="backToList">返回列表</button>
        <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭角色卡工作台" @click="emit('close')">
          <ArchiveIcon name="close" />
        </button>
      </div>
    </header>

    <div v-if="mode === 'list'" class="room-tool-body ccm-body">
      <div class="ccm-toolbar">
        <input
          v-model="search"
          type="search"
          class="input ccm-search"
          placeholder="搜索角色卡名称、绑定ID…"
          aria-label="搜索角色卡"
        />
        <button v-if="canEditCards" type="button" class="btn btn-primary btn-sm" :disabled="Boolean(openingId)" @click="startCreate">新建角色卡</button>
        <button v-if="canEditCards" type="button" class="btn btn-ghost btn-sm" @click="emit('import-file')">导入 PNG/JSON</button>
      </div>

      <p v-if="loading" class="ccm-status" role="status">正在读取本机角色卡目录…</p>
      <p v-else-if="loadError" class="ccm-status is-error" role="alert">{{ loadError }}</p>
      <div v-else-if="!filteredCards.length" class="ccm-empty">
        {{ search.trim() ? '未找到匹配的角色卡。' : '还没有导入或自建的角色卡，点击右上角「新建角色卡」开始创作。' }}
      </div>

      <div v-else class="ccm-card-list">
        <article
          v-for="card in filteredCards"
          :key="card.id"
          class="ccm-card-item"
          :class="{ 'is-active': card.id === activeChar }"
        >
          <div class="ccm-card-avatar">
            <RuntimeImage v-if="card.avatarUrl" :src="card.avatarUrl" alt="" />
            <ArchiveIcon v-else name="character" />
          </div>
          <div class="ccm-card-info">
            <div class="ccm-card-title-row">
              <strong>{{ card.name }}</strong>
              <span v-if="card.id === activeChar" class="ccm-badge is-accent">当前对话</span>
              <span class="ccm-badge">{{ card.source === 'catalog' ? '目录内置' : '用户卡' }}</span>
              <span v-if="card.overridden" class="ccm-badge is-accent">已定制</span>
            </div>
            <p class="ccm-card-desc">{{ card.description || '暂无描述' }}</p>
            <div class="ccm-card-meta">
              <span v-if="card.catalogId">绘图素材：{{ catalogNameOf(card.catalogId) }}</span>
              <span v-if="card.voiceId">语音音色：{{ voiceNameOf(card.voiceId) }}</span>
              <span v-if="card.loreCount">内置世界书：{{ card.loreCount }} 条</span>
            </div>
          </div>
          <div class="ccm-card-actions">
            <button type="button" class="btn btn-primary btn-sm" @click="selectAndClose(card.id)">对话</button>
            <button v-if="canEditCards" type="button" class="btn btn-ghost btn-sm" :disabled="Boolean(openingId)" @click="startEdit(card.id)">
              {{ openingId === card.id ? '载入中…' : '编辑/绑定' }}
            </button>
            <button type="button" class="btn btn-quiet btn-sm" :disabled="Boolean(exporting)" @click="exportCard(card, 'json')">导出 JSON</button>
            <button type="button" class="btn btn-quiet btn-sm" :disabled="Boolean(exporting)" @click="exportCard(card, 'png')">导出 PNG</button>
            <button
              v-if="canEditCards && (card.source !== 'catalog' || card.overridden)"
              type="button"
              class="btn btn-quiet btn-sm"
              :disabled="deletingId === card.id"
              @click="requestDelete(card)"
            >
              {{ card.source === 'catalog' ? '恢复默认' : '删除' }}
            </button>
          </div>
        </article>
      </div>
    </div>

    <form v-else class="room-tool-body ccm-body" @submit.prevent="saveCard">
      <div class="ccm-editor-top">
        <div class="ccm-avatar-preview">
          <img v-if="avatarPreviewUrl.startsWith('blob:')" :src="avatarPreviewUrl" alt="角色卡头像预览" />
          <RuntimeImage v-else-if="avatarPreviewUrl" :src="avatarPreviewUrl" alt="角色卡头像预览">
            <template #fallback><ArchiveIcon name="character" /></template>
          </RuntimeImage>
          <ArchiveIcon v-else name="character" />
        </div>
        <div class="ccm-avatar-controls">
          <input ref="avatarInputRef" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden @change="onPickAvatar" />
          <button type="button" class="btn btn-ghost btn-sm" @click="avatarInputRef?.click()">上传头像 / 封面</button>
          <button v-if="avatarPreviewUrl" type="button" class="btn btn-quiet btn-sm" @click="clearAvatar">清除头像</button>
          <small>支持 PNG / JPEG / WebP；导出 PNG 时将把酒馆 V2 数据写入该图片</small>
        </div>
      </div>

      <section class="ccm-section" aria-label="基础人设">
        <label class="studio-field-label" for="ccm-name">角色名称 *</label>
        <input id="ccm-name" v-model="draft.data.name" class="input" maxlength="80" required placeholder="输入角色名" />

        <label class="studio-field-label" for="ccm-personality">性格关键词（Personality）</label>
        <input id="ccm-personality" v-model="draft.data.personality" class="input" maxlength="2000" placeholder="例如：温柔体贴、偶尔害羞、嘴硬心软" />

        <label class="studio-field-label" for="ccm-desc">角色详细设定（Description）</label>
        <textarea id="ccm-desc" v-model="draft.data.description" class="textarea ccm-autosize" rows="4" maxlength="16000" placeholder="角色外貌、背景故事、行为习惯、隐藏秘密…" />

        <label class="studio-field-label" for="ccm-scenario">当前场景（Scenario）</label>
        <textarea id="ccm-scenario" v-model="draft.data.scenario" class="textarea ccm-autosize" rows="2" maxlength="8000" placeholder="对话所处的环境与关系背景" />

        <label class="studio-field-label" for="ccm-first-mes">主开场白（First Message）</label>
        <textarea id="ccm-first-mes" v-model="draft.data.first_mes" class="textarea ccm-autosize" rows="3" maxlength="16000" placeholder="新建对话时的第一句问候（支持 {{user}} / {{char}}）" />
      </section>

      <section class="ccm-section ccm-binding-box" aria-label="绘遇专属视觉与语音绑定">
        <h3>绘遇独家绑定（立绘 / 生图 / 语音）</h3>
        <div class="ccm-two-col">
          <label class="ccm-field">
            <span>绑定绘图素材库角色（{{ catalogBindingLabel }}）</span>
            <StudioSelect v-model="huiyuCatalogId" label="绑定绘图素材角色" :options="catalogSelectOptions" />
            <small>绑定后可直接使用对应角色的画风、服饰配方与 CG 插画一致化生成。</small>
          </label>
          <label class="ccm-field">
            <span>绑定语音音色（{{ voiceBindingLabel }}）</span>
            <StudioSelect v-model="huiyuVoiceId" label="绑定语音音色" :options="voiceSelectOptions" />
            <small>绑定后在聊天中开启语音朗读时将使用该音色配音。</small>
          </label>
        </div>
      </section>

      <details class="ccm-accordion">
        <summary>备用开场白（{{ draft.data.alternate_greetings.length }} 条）</summary>
        <div class="ccm-accordion-body">
          <div v-for="(_, index) in draft.data.alternate_greetings" :key="index" class="ccm-alt-row">
            <textarea
              v-model="draft.data.alternate_greetings[index]"
              class="textarea ccm-autosize"
              rows="2"
              maxlength="16000"
              :placeholder="`备用开场白 #${index + 1}`"
            />
            <button type="button" class="btn btn-quiet btn-sm" @click="draft.data.alternate_greetings.splice(index, 1)">删除</button>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" @click="draft.data.alternate_greetings.push('')">+ 添加备用开场白</button>
        </div>
      </details>

      <details class="ccm-accordion">
        <summary>高级酒馆提示词（System / Post-History / Depth Prompt / 对话示例）</summary>
        <div class="ccm-accordion-body">
          <label class="studio-field-label" for="ccm-system-prompt" v-pre>System Prompt（支持 {{original}} 与 {{char}}/{{user}}）</label>
          <textarea id="ccm-system-prompt" v-model="draft.data.system_prompt" class="textarea ccm-autosize" rows="2" maxlength="8000" />

          <label class="studio-field-label" for="ccm-post-history">Post-History Instructions（对话末尾加固指令）</label>
          <textarea id="ccm-post-history" v-model="draft.data.post_history_instructions" class="textarea ccm-autosize" rows="2" maxlength="4000" />

          <div class="ccm-two-col">
            <label class="ccm-field">
              <span>深度提示词（Depth Prompt）</span>
              <textarea v-model="depthPromptText" class="textarea ccm-autosize" rows="2" maxlength="2000" />
            </label>
            <label class="ccm-field">
              <span>插入深度（0 = 最新回复前）</span>
              <input v-model.number="depthPromptDepth" type="number" class="input" min="0" max="16" />
            </label>
          </div>

          <label class="studio-field-label" for="ccm-mes-example">对话示例（&lt;START&gt; 分隔）</label>
          <textarea id="ccm-mes-example" v-model="draft.data.mes_example" class="textarea ccm-autosize" rows="3" maxlength="12000" />
        </div>
      </details>

      <details class="ccm-accordion">
        <summary>卡片内置世界书（{{ cardLoreEntries.length }} 条）</summary>
        <div class="ccm-accordion-body">
          <div v-for="(entry, index) in cardLoreEntries" :key="cardLoreKey(entry)" class="ccm-lore-entry">
            <div class="ccm-lore-head">
              <input v-model="entry.comment" class="input" maxlength="48" aria-label="条目标题" placeholder="条目标题（可选）" />
              <StudioSelect v-model="entry.position" class="ccm-pos-select" label="注入位置" :options="positionOptions" />
              <ToggleSwitch :model-value="entry.enabled !== false" label="启用条目" @update:model-value="entry.enabled = $event">启用</ToggleSwitch>
              <ToggleSwitch :model-value="entry.constant === true" label="常驻激活" @update:model-value="entry.constant = $event">常驻激活</ToggleSwitch>
              <button type="button" class="btn btn-quiet btn-sm" @click="removeCardLore(index)">删除</button>
            </div>
            <label v-if="entry.position === 'at_depth'" class="ccm-field">
              <span>插入深度（0–16）</span>
              <input v-model.number="entry.depth" class="input" type="number" min="0" max="16" />
            </label>
            <label class="ccm-field">
              <span>触发关键词（用逗号分隔）</span>
              <ChatLoreKeywordsInput v-model="entry.keys" />
            </label>
            <textarea v-model="entry.content" class="textarea ccm-autosize" rows="2" maxlength="4000" aria-label="条目内容" placeholder="命中关键词后注入的设定内容" />
          </div>
          <button type="button" class="btn btn-ghost btn-sm" @click="addCardLore">+ 添加内置世界书条目</button>
        </div>
      </details>

      <footer class="ccm-footer">
        <p v-if="saveError" class="ccm-status is-error" role="alert">{{ saveError }}</p>
        <button type="button" class="btn btn-ghost" @click="backToList">取消</button>
        <button type="submit" class="btn btn-primary" :disabled="saving || !draft.data.name.trim()">
          {{ saving ? '保存中…' : editingId ? '保存修改' : '创建角色卡' }}
        </button>
      </footer>
    </form>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ChatLoreKeywordsInput from '@/components/ChatLoreKeywordsInput.vue'
import { useChatCardManager } from '@/composables/chat/useChatCardManager'

const props = defineProps<{
  activeChar: string
  canEditCards?: boolean
}>()

const positionOptions = [
  { value: 'before_char', label: '设定前' },
  { value: 'after_char', label: '设定后' },
  { value: 'at_depth', label: '指定深度' },
]

const emit = defineEmits<{
  close: []
  'select-character': [id: string]
  'cards-changed': []
  'import-file': []
  notice: [message: string, kind?: 'info' | 'warning' | 'error']
}>()

const {
  mode, search, loading, loadError, openingId, deletingId, editingId, draft,
  saving, exporting, saveError, avatarInputRef, avatarPreviewUrl, filteredCards,
  catalogSelectOptions, voiceSelectOptions, huiyuCatalogId, huiyuVoiceId,
  catalogBindingLabel, voiceBindingLabel, depthPromptText, depthPromptDepth,
  cardLoreEntries, cardLoreKey, exportCard, catalogNameOf, voiceNameOf,
  addCardLore, removeCardLore, onPickAvatar, clearAvatar, startCreate, startEdit,
  backToList, selectAndClose, saveCard, requestDelete,
} = useChatCardManager(emit, () => props.canEditCards === true)
</script>

<style scoped>
.ccm-kicker { display:block; color:var(--text-secondary); font:600 var(--fs-label-xs)/var(--lh-label) var(--font-mono); letter-spacing:0.08em; }
.ccm-head-actions { display:flex; align-items:center; gap:var(--s-2); }
.ccm-body { display:grid; gap:var(--s-3); align-content:start; }
.ccm-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.ccm-search { flex:1 1 180px; }
.ccm-status { margin:0; color:var(--text-secondary); font:400 var(--fs-label)/var(--lh-body) var(--font-sans); }
.ccm-status.is-error { color:var(--danger-text); }
.ccm-empty { padding:var(--s-5); border:1px dashed var(--border-soft); border-radius:var(--r-lg); color:var(--text-secondary); text-align:center; font:400 var(--fs-label)/var(--lh-body) var(--font-sans); }
.ccm-card-list { display:grid; gap:var(--s-2); }
.ccm-card-item { display:grid; grid-template-columns:56px minmax(0, 1fr); gap:var(--s-3); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.ccm-card-item.is-active { border-color:var(--accent); }
.ccm-card-avatar { width:56px; height:56px; border-radius:var(--r-md); overflow:hidden; background:var(--bg-elevated); display:grid; place-items:center; color:var(--text-secondary); }
.ccm-card-avatar img { width:100%; height:100%; object-fit:cover; }
.ccm-card-info { min-width:0; display:grid; gap:4px; }
.ccm-card-title-row { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-1); }
.ccm-card-title-row strong { font:600 var(--fs-body-sm)/1.3 var(--font-sans); color:var(--text-primary); }
.ccm-badge { padding:1px 6px; border-radius:999px; background:var(--bg-elevated); color:var(--text-secondary); font:500 var(--fs-label-xs)/1.4 var(--font-sans); }
.ccm-badge.is-accent { background:var(--bg-elevated); color:var(--text-primary); }
.ccm-card-desc { margin:0; color:var(--text-secondary); font:400 var(--fs-label-xs)/1.4 var(--font-sans); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ccm-card-meta { display:flex; flex-wrap:wrap; gap:var(--s-2); color:var(--text-secondary); font:400 var(--fs-label-xs)/1.3 var(--font-sans); }
.ccm-card-actions { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:var(--s-1); justify-content:flex-end; border-top:1px solid var(--border-soft); padding-top:var(--s-2); }

.ccm-editor-top { display:flex; align-items:center; gap:var(--s-3); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.ccm-avatar-preview { width:72px; height:72px; flex:none; border-radius:var(--r-md); overflow:hidden; background:var(--bg-elevated); display:grid; place-items:center; color:var(--text-secondary); }
.ccm-avatar-preview img { width:100%; height:100%; object-fit:cover; }
.ccm-avatar-controls { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.ccm-avatar-controls small { flex-basis:100%; color:var(--text-secondary); font:400 var(--fs-label-xs)/1.4 var(--font-sans); }
.ccm-section { display:grid; gap:var(--s-2); }
.ccm-binding-box { padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.ccm-binding-box h3 { margin:0; font:600 var(--fs-body-sm)/1.3 var(--font-sans); color:var(--text-primary); }
.ccm-two-col { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap:var(--s-3); }
.ccm-field { display:grid; gap:var(--s-1); align-content:start; }
.ccm-field > span { color:var(--text-secondary); font:600 var(--fs-label-xs)/1.3 var(--font-sans); }
.ccm-field small { color:var(--text-secondary); font:400 var(--fs-label-xs)/1.4 var(--font-sans); }
.ccm-accordion { border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); padding:var(--s-2) var(--s-3); }
.ccm-accordion > summary { cursor:pointer; font:600 var(--fs-label)/1.5 var(--font-sans); color:var(--text-primary); }
.ccm-accordion-body { display:grid; gap:var(--s-2); margin-top:var(--s-2); }
.ccm-alt-row { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:var(--s-2); align-items:start; }
.ccm-lore-entry { display:grid; gap:var(--s-2); padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); }
.ccm-lore-head { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.ccm-lore-head .input { flex:1 1 140px; }
.ccm-pos-select { flex:0 0 auto; width:auto; }
@supports (field-sizing:content) {
  .ccm-autosize { field-sizing:content; resize:none; min-block-size:2.5lh; max-block-size:14lh; }
}
.ccm-footer { display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:var(--s-2); padding-top:var(--s-2); border-top:1px solid var(--border-soft); }
.ccm-footer .ccm-status { flex-basis:100%; }
</style>
