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

<style scoped src="@/assets/css/components/ChatUserProfilePanel-0.css"></style>
