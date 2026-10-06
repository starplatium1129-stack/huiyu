<template>
  <section class="chat-user-profile" aria-labelledby="chatUserProfileTitle">
    <header>
      <div>
        <span>USER PROFILE</span>
        <strong id="chatUserProfileTitle">她该怎样认识你</strong>
      </div>
      <button type="button" class="btn btn-ghost btn-sm btn-icon profile-close" aria-label="关闭用户档案" @click="close"><ArchiveIcon name="close" /></button>
    </header>
    <p>这些资料只用于称呼和关系连续性，保存在本机，不会覆盖角色设定。</p>
    <div class="profile-grid">
      <label>
        <span>希望她怎样称呼你</span>
        <input v-model="draft.callName" maxlength="40" placeholder="留空时仍称呼“你”" />
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
        <span>希望她记住的背景</span>
        <textarea v-model="draft.note" maxlength="200" rows="3" placeholder="例如：我习惯夜间工作，聊到压力时希望先听我说完。"></textarea>
        <small>{{ draft.note.length }} / 200</small>
      </label>
    </div>
    <p v-if="saveMessage" role="status">{{ saveMessage }}</p>
    <div class="profile-actions">
      <button type="button" class="btn btn-ghost" @click="reset">恢复默认</button>
      <button type="button" class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存档案' }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import {
  CHAT_RELATIONSHIPS,
  EMPTY_CHAT_USER_PROFILE,
  normalizeChatUserProfile,
  type ChatUserProfile,
} from '@/utils/chatUserProfile'

const props = defineProps<{ profile: ChatUserProfile; saveProfile: (profile: ChatUserProfile) => Promise<boolean> }>()
const emit = defineEmits<{
  close: []
}>()

const draft = reactive<ChatUserProfile>(normalizeChatUserProfile(props.profile))

let baseline = { ...draft }
let submittedDraft: ChatUserProfile | null = null
const saving = ref(false)
const saveMessage = ref('')
let disposed = false
onBeforeUnmount(() => { disposed = true })

watch(() => props.profile, profile => {
  // Merge untouched fields so saving a local edit cannot replay stale remote data.
  const incoming = normalizeChatUserProfile(profile)
  for (const key of ['callName', 'relationship', 'note'] as const) {
    // A revert to the old baseline is still a newer edit while its save is pending.
    if (draft[key] === baseline[key] && (!submittedDraft || draft[key] === submittedDraft[key])) {
      Object.assign(draft, { [key]: incoming[key] })
    }
  }
  baseline = incoming
}, { deep: true })

function close() { disposed = true; emit('close') }
function reset() { Object.assign(draft, EMPTY_CHAT_USER_PROFILE) }

async function save() {
  if (saving.value || disposed) return
  saving.value = true
  saveMessage.value = ''
  submittedDraft = { ...draft }
  const submitted = JSON.stringify(submittedDraft)
  try {
    const saved = await props.saveProfile(normalizeChatUserProfile(submittedDraft))
    if (disposed) return
    if (!saved) { saveMessage.value = '用户档案保存尚未确认，当前修改已保留，请重试。'; return }
    if (JSON.stringify(draft) !== submitted) {
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
