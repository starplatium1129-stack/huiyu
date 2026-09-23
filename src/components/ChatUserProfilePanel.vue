<template>
  <section class="chat-user-profile" aria-labelledby="chatUserProfileTitle">
    <header>
      <div>
        <span>USER PROFILE</span>
        <strong id="chatUserProfileTitle">她该怎样认识你</strong>
      </div>
      <button type="button" class="profile-close" aria-label="关闭用户档案" @click="$emit('close')">×</button>
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
    <div class="profile-actions">
      <button type="button" class="btn btn-ghost" @click="reset">恢复默认</button>
      <button type="button" class="btn btn-primary" @click="save">保存档案</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import {
  CHAT_RELATIONSHIPS,
  EMPTY_CHAT_USER_PROFILE,
  normalizeChatUserProfile,
  type ChatUserProfile,
} from '@/utils/chatUserProfile'

const props = defineProps<{ profile: ChatUserProfile }>()
const emit = defineEmits<{
  save: [profile: ChatUserProfile]
  close: []
}>()

const draft = reactive<ChatUserProfile>(normalizeChatUserProfile(props.profile))

watch(() => props.profile, profile => Object.assign(draft, normalizeChatUserProfile(profile)), { deep: true })

function reset() {
  Object.assign(draft, EMPTY_CHAT_USER_PROFILE)
}

function save() {
  emit('save', normalizeChatUserProfile(draft))
}
</script>

<style scoped>
.chat-user-profile {
  margin: 0 0 var(--s-4);
  padding: var(--s-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--glass-fill);
  box-shadow: var(--shadow-md);
}
.chat-user-profile header,
.profile-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
}
.chat-user-profile header div { display: grid; gap: 2px; }
.chat-user-profile header span,
.profile-grid label > span { color: var(--text-muted); font-size: var(--fs-label-xs); font-weight: 700; letter-spacing: .08em; }
.chat-user-profile header strong { color: var(--text-primary); font-size: var(--fs-title-xs); }
.chat-user-profile > p { margin: var(--s-2) 0 var(--s-4); color: var(--text-secondary); font-size: var(--fs-label); }
.profile-close { border: 0; background: transparent; color: var(--text-muted); font-size: var(--fs-title); cursor: pointer; }
.profile-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, .5fr); gap: var(--s-3); }
.profile-grid label { display: grid; gap: 6px; }
.profile-grid input,
.profile-grid textarea {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-deep);
  color: var(--text-primary);
  font: inherit;
}
.profile-grid select {
  width: 100%;
  min-height: 40px;
  padding: 9px var(--s-7) 9px 11px;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background-color: var(--bg-deep);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
    linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
  background-repeat: no-repeat;
  background-position:
    calc(100% - 14px) calc(50% - 1px),
    calc(100% - 10px) calc(50% - 1px);
  background-size: 5px 5px;
  transition: border-color var(--motion-hover) var(--ease-out);
}
.profile-grid select:is(:hover, :focus-visible) {
  border-color: var(--accent);
}
.profile-note { grid-column: 1 / -1; }
.profile-note small { justify-self: end; color: var(--text-muted); font-size: var(--fs-mono-sm); }
.profile-actions { justify-content: flex-end; margin-top: var(--s-3); }
@media (max-width: 600px) {
  .profile-grid { grid-template-columns: 1fr; }
  .profile-note { grid-column: auto; }
}
</style>
