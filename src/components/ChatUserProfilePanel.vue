<template>
  <section class="chat-user-profile room-tool-panel" aria-labelledby="chatUserProfileTitle">
    <header class="room-tool-heading">
      <div>
        <span>USER PERSONAS</span>
        <h2 id="chatUserProfileTitle">我的马甲与用户档案</h2>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭用户档案" @click="close"><ArchiveIcon name="close" /></button>
    </header>
    <div class="room-tool-body">
      <div class="persona-switcher" role="region" aria-label="多用户马甲切换">
        <div class="persona-chips" role="tablist" aria-label="已保存的用户马甲">
          <button
            v-for="persona in store.personas"
            :key="persona.id"
            type="button"
            role="tab"
            class="persona-chip"
            :class="{
              'is-selected': persona.id === editingPersonaId,
              'is-active': persona.id === store.activeId,
              'is-bound': characterId && store.characterBindings[characterId] === persona.id,
            }"
            :aria-selected="persona.id === editingPersonaId"
            @click="selectPersona(persona.id)"
          >
            <span>{{ persona.label }}</span>
            <small v-if="characterId && store.characterBindings[characterId] === persona.id">专属</small>
            <small v-else-if="persona.id === store.activeId">当前</small>
          </button>
        </div>
        <div class="persona-chip-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="addPersona">+ 新建马甲</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="duplicatePersona">复制</button>
          <button v-if="store.personas.length > 1" type="button" class="btn btn-quiet btn-sm" @click="removeSelectedPersona">删除</button>
        </div>
      </div>

      <div v-if="characterId" class="persona-binding-bar">
        <span>
          <template v-if="boundPersonaName">
            「{{ characterName || characterId }}」当前使用专属马甲：<strong>{{ boundPersonaName }}</strong>
          </template>
          <template v-else>
            「{{ characterName || characterId }}」当前跟随全局默认马甲
          </template>
        </span>
        <button
          v-if="store.characterBindings[characterId] !== editingPersonaId"
          type="button"
          class="btn btn-ghost btn-sm"
          @click="bindCurrentToCharacter"
        >
          设为{{ characterName || '此角色' }}专属
        </button>
        <button
          v-else
          type="button"
          class="btn btn-quiet btn-sm"
          @click="unbindCharacter"
        >
          解除专属绑定
        </button>
      </div>

      <div class="profile-grid">
        <label>
          <span>马甲名称</span>
          <input v-model="draft.label" class="input" maxlength="32" placeholder="例如：工坊主人 / 旅人" />
        </label>
        <label>
          <span>角色对你的称呼</span>
          <input v-model="draft.callName" class="input" maxlength="40" placeholder="留空时仍称呼“你”" />
        </label>
        <label>
          <span>关系定位</span>
          <StudioSelect
            v-model="draft.relationship"
            label="关系定位"
            :options="CHAT_RELATIONSHIPS.map(option => ({ value: option.id, label: option.label }))"
          />
        </label>
        <label class="profile-note">
          <span>身份设定与背景偏好</span>
          <textarea
            v-model="draft.note"
            class="textarea profile-note-textarea"
            maxlength="500"
            rows="3"
            placeholder="例如：我是刚来镇上的炼金术士，习惯夜间工作，说话时喜欢略带吐槽口吻。"
            @focus="revealProfileField"
          ></textarea>
          <small>{{ draft.note.length }} / 500</small>
        </label>
      </div>
    </div>
    <footer class="profile-actions">
      <p v-if="saveMessage" role="status">{{ saveMessage }}</p>
      <button type="button" class="btn btn-ghost" @click="reset">清空当前表单</button>
      <button type="button" class="btn btn-primary" :aria-disabled="saving || undefined" :aria-busy="saving" @click="save">{{ saving ? '保存中…' : '保存并设为当前马甲' }}</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import {
  CHAT_RELATIONSHIPS,
  EMPTY_CHAT_USER_PROFILE,
  normalizeChatUserProfile,
  type ChatUserProfile,
} from '@/utils/chatUserProfile'
import {
  createBlankPersona,
  loadUserPersonaStore,
  saveUserPersonaStore,
  toChatUserProfile,
  type UserPersona,
} from '@/utils/chatUserPersonas'

const props = defineProps<{
  profile: ChatUserProfile
  saveProfile: (profile: ChatUserProfile) => Promise<boolean>
  characterId?: string
  characterName?: string
  onPersonaChanged?: () => void
}>()
const emit = defineEmits<{
  close: []
}>()

const store = reactive(loadUserPersonaStore())
const initialId = (props.characterId && store.characterBindings[props.characterId]) || store.activeId
const editingPersonaId = ref(store.personas.some(p => p.id === initialId) ? initialId : store.personas[0]!.id)

function currentEditingPersona(): UserPersona {
  return store.personas.find(p => p.id === editingPersonaId.value) || store.personas[0]!
}

const draft = reactive<UserPersona>({ ...currentEditingPersona() })
const boundPersonaName = computed(() => {
  if (!props.characterId) return ''
  const id = store.characterBindings[props.characterId]
  return id ? store.personas.find(p => p.id === id)?.label || '' : ''
})

let baseline = { ...draft }
let submittedDraft: UserPersona | null = null
const saving = ref(false)
const saveMessage = ref('')
let disposed = false
onBeforeUnmount(() => { disposed = true })

function loadDraftFromSelected() {
  const target = currentEditingPersona()
  Object.assign(draft, target)
  baseline = { ...target }
  saveMessage.value = ''
}

function syncDraftIntoStore() {
  const index = store.personas.findIndex(p => p.id === editingPersonaId.value)
  if (index < 0) return
  const normalized = normalizeChatUserProfile(draft)
  store.personas[index] = {
    id: editingPersonaId.value,
    label: draft.label.trim().slice(0, 32) || normalized.callName || '未命名马甲',
    ...normalized,
  }
}

function selectPersona(id: string) {
  if (id === editingPersonaId.value) return
  syncDraftIntoStore()
  editingPersonaId.value = id
  loadDraftFromSelected()
}

function addPersona() {
  syncDraftIntoStore()
  const next = createBlankPersona(`马甲 ${store.personas.length + 1}`)
  store.personas.push(next)
  editingPersonaId.value = next.id
  loadDraftFromSelected()
}

function duplicatePersona() {
  syncDraftIntoStore()
  const current = currentEditingPersona()
  const copy: UserPersona = {
    ...current,
    id: createBlankPersona().id,
    label: `${current.label.slice(0, 26)} 副本`,
  }
  store.personas.push(copy)
  editingPersonaId.value = copy.id
  loadDraftFromSelected()
}

function removeSelectedPersona() {
  if (store.personas.length <= 1) return
  const index = store.personas.findIndex(p => p.id === editingPersonaId.value)
  if (index >= 0) store.personas.splice(index, 1)
  editingPersonaId.value = store.personas[0]!.id
  const saved = saveUserPersonaStore(store)
  Object.assign(store, saved)
  loadDraftFromSelected()
  props.onPersonaChanged?.()
}

function bindCurrentToCharacter() {
  if (!props.characterId) return
  syncDraftIntoStore()
  store.characterBindings[props.characterId] = editingPersonaId.value
  const saved = saveUserPersonaStore(store)
  Object.assign(store, saved)
  props.onPersonaChanged?.()
  saveMessage.value = `已将「${draft.label || '当前马甲'}」绑定为 ${props.characterName || '该角色'} 的专属马甲。`
}

function unbindCharacter() {
  if (!props.characterId) return
  delete store.characterBindings[props.characterId]
  const saved = saveUserPersonaStore(store)
  Object.assign(store, saved)
  props.onPersonaChanged?.()
  saveMessage.value = `已取消 ${props.characterName || '该角色'} 的专属马甲绑定。`
}

watch(() => props.profile, profile => {
  if (editingPersonaId.value !== store.activeId) return
  const incoming = normalizeChatUserProfile(profile)
  for (const key of ['callName', 'relationship', 'note'] as const) {
    if (draft[key] === baseline[key] && (!submittedDraft || draft[key] === submittedDraft[key])) {
      Object.assign(draft, { [key]: incoming[key] })
    }
  }
  baseline = { ...baseline, ...incoming }
}, { deep: true })

function close() { disposed = true; emit('close') }
function reset() { Object.assign(draft, { ...EMPTY_CHAT_USER_PROFILE }) }
function revealProfileField(event: FocusEvent) {
  (event.currentTarget as HTMLTextAreaElement).scrollIntoView({ block:'nearest', inline:'nearest', behavior:'instant' })
}

async function save() {
  if (saving.value || disposed) return
  saving.value = true
  saveMessage.value = ''
  syncDraftIntoStore()
  store.activeId = editingPersonaId.value
  const savedStore = saveUserPersonaStore(store)
  Object.assign(store, savedStore)
  const activePersona = savedStore.personas.find(p => p.id === savedStore.activeId) || savedStore.personas[0]!
  submittedDraft = { ...activePersona }
  const submitted = JSON.stringify(toChatUserProfile(submittedDraft))
  try {
    const saved = await props.saveProfile(toChatUserProfile(activePersona))
    props.onPersonaChanged?.()
    if (disposed) return
    if (!saved) { saveMessage.value = '用户档案保存尚未确认，当前修改已保留，请重试。'; return }
    if (JSON.stringify(toChatUserProfile(draft)) !== submitted) {
      saveMessage.value = '提交时的档案已保存；当前修改尚未保存，请再次保存。'
      return
    }
    emit('close')
  } catch {
    if (!disposed) saveMessage.value = '用户档案保存尚未确认，当前修改已保留，请重试。'
  } finally { saving.value = false; submittedDraft = null }
}
</script>

<style scoped src="@/assets/css/components/ChatUserProfilePanel-0.css"></style>
<style scoped>
.persona-switcher { display:grid; gap:var(--s-2); margin-bottom:var(--s-3); padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.persona-chips { display:flex; flex-wrap:wrap; gap:var(--s-1); }
.persona-chip { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border:1px solid var(--border-soft); border-radius:999px; background:var(--bg-surface); color:var(--text-secondary); font:500 var(--fs-label-xs)/1.4 var(--font-sans); cursor:pointer; }
.persona-chip.is-selected { border-color:var(--accent); color:var(--text-primary); background:color-mix(in srgb, var(--accent) 12%, var(--bg-surface)); }
.persona-chip small { color:var(--accent); font-size:10px; }
.persona-chip-actions { display:flex; flex-wrap:wrap; gap:var(--s-1); }
.persona-binding-bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); margin-bottom:var(--s-3); padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); font:400 var(--fs-label-xs)/1.4 var(--font-sans); color:var(--text-secondary); }
.persona-binding-bar strong { color:var(--text-primary); }
@supports (field-sizing:content) {
  .profile-note-textarea { field-sizing:content; resize:none; min-block-size:3lh; max-block-size:12lh; }
}
</style>
