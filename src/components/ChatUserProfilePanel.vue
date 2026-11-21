<template>
  <section class="chat-user-profile room-tool-panel" aria-labelledby="chatUserProfileTitle">
    <header class="room-tool-heading">
      <div>
        <span class="profile-note-kicker">关系便签卡</span>
        <h2 id="chatUserProfileTitle">我的称呼与相处便签</h2>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭关系便签卡" @click="close"><ArchiveIcon name="close" /></button>
    </header>
    <div class="room-tool-body">
      <p class="profile-note-intro">告诉她怎么称呼你、你们的关系与日常小习惯；所有内容仅保存在本机。</p>
      <div class="profile-grid">
        <label>
          <span>她怎么称呼你</span>
          <input v-model="draft.callName" class="input" maxlength="40" placeholder="留空时仍轻声称呼“你”" />
        </label>
        <label>
          <span>你们的关系</span>
          <StudioSelect
            v-model="draft.relationship"
            label="你们的关系"
            :options="CHAT_RELATIONSHIPS.map(option => ({ value: option.id, label: option.label }))"
          />
        </label>
        <label class="profile-note">
          <span>相处小备注</span>
          <textarea v-model="draft.note" class="textarea" maxlength="200" rows="3" placeholder="例如：我习惯夜间工作，聊到压力时希望先听我说完。" @focus="revealProfileField"></textarea>
          <small>{{ draft.note.length }} / 200</small>
        </label>
      </div>
    </div>
    <footer class="profile-actions">
      <p v-if="saveMessage" role="status">{{ saveMessage }}</p>
      <button type="button" class="btn btn-ghost" @click="reset">恢复默认</button>
      <button type="button" class="btn btn-primary" :aria-disabled="saving || undefined" :aria-busy="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
    </footer>
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
function revealProfileField(event: FocusEvent) {
  // Native caret scrolling can leave the editor behind the fixed action footer.
  (event.currentTarget as HTMLTextAreaElement).scrollIntoView({ block:'nearest', inline:'nearest', behavior:'instant' })
}

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
