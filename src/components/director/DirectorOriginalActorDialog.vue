<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { useFluidDialog } from '@/composables/useFluidDialog'
import type { CastGender, CastMember } from '@/types/prompt'

type OriginalIdentity = Pick<CastMember, 'name' | 'appearance' | 'gender'>
const emit = defineEmits<{ save: [characterId: string | null, identity: OriginalIdentity] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const nameField = ref<HTMLInputElement | null>(null)
const motion = useFluidDialog(dialog)
const id = useId()
const actorId = ref<string | null>(null)
const name = ref('')
const appearance = ref('')
const gender = ref<CastGender>('girl')
const showError = ref(false)
const genders = [{ value: 'girl', label: '女' }, { value: 'boy', label: '男' }, { value: 'other', label: '其他' }]

function open(source: HTMLElement, member?: CastMember) {
  actorId.value = member?.characterId ?? null
  name.value = member?.name ?? ''
  appearance.value = member?.appearance ?? ''
  gender.value = member?.gender ?? 'girl'
  showError.value = false
  motion.open(source)
}

function setGender(value: string | number) {
  if (value === 'girl' || value === 'boy' || value === 'other') gender.value = value
}

async function save() {
  const actorName = name.value.trim(), actorAppearance = appearance.value.trim()
  if (!actorName && !actorAppearance) {
    showError.value = true
    await nextTick()
    nameField.value?.focus()
    return
  }
  motion.close()
  emit('save', actorId.value, { name: actorName, appearance: actorAppearance, gender: gender.value })
}

defineExpose({ open })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="original-actor-dialog" :aria-labelledby="id + '-title'" @cancel.prevent="motion.close()">
      <form class="original-actor-form" @submit.prevent="save">
        <header>
          <h2 :id="id + '-title'">{{ actorId ? '编辑原创角色' : '添加原创角色' }}</h2>
          <button class="btn btn-quiet btn-icon btn-sm" type="button" aria-label="关闭原创角色编辑" @click="motion.close()">
            <ArchiveIcon name="close" />
          </button>
        </header>
        <p :id="id + '-help'">称呼和外貌特征至少填写一项。</p>
        <div class="original-actor-field">
          <label :for="id + '-name'">角色称呼</label>
          <input :id="id + '-name'" ref="nameField" v-model="name" autofocus class="input" type="text" maxlength="80"
            :aria-describedby="id + '-help'" :aria-invalid="showError && !name.trim() && !appearance.trim() || undefined"
            placeholder="例如小树" />
        </div>
        <div class="original-actor-field">
          <label :for="id + '-appearance'">外貌特征</label>
          <textarea :id="id + '-appearance'" v-model="appearance" class="textarea" rows="3" maxlength="400"
            :aria-describedby="id + '-help'" placeholder="例如黑色短发、绿色眼睛、雀斑" />
        </div>
        <div class="original-actor-field">
          <label :for="id + '-gender'">性别</label>
          <StudioSelect :id="id + '-gender'" :model-value="gender" :options="genders" label="性别" @update:model-value="setGender" />
        </div>
        <p v-if="showError && !name.trim() && !appearance.trim()" class="original-actor-error" role="alert">请填写角色称呼或外貌特征。</p>
        <footer>
          <button class="btn btn-quiet" type="button" @click="motion.close()">取消</button>
          <button class="btn btn-primary" type="submit">{{ actorId ? '保存修改' : '添加角色' }}</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.original-actor-dialog {
  inset: var(--desktop-chrome-height, 0px) 0 0;
  margin: auto;
  inline-size: min(28rem, calc(100vw - 2rem));
  max-block-size: calc(100dvh - var(--desktop-chrome-height, 0px) - 2rem);
  overflow: auto;
  padding: var(--s-5);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-lg);
}
.original-actor-dialog::backdrop { background: var(--art-scrim); }
.original-actor-form, .original-actor-field { display: grid; gap: var(--s-3); min-inline-size: 0; }
.original-actor-field { gap: var(--s-1); }
.original-actor-form header, .original-actor-form footer { display: flex; align-items: center; gap: var(--s-2); }
.original-actor-form header { justify-content: space-between; }
.original-actor-form footer { justify-content: flex-end; }
.original-actor-form h2 { margin: 0; font-size: var(--fs-title-xs); }
.original-actor-form p, .original-actor-form label { margin: 0; color: var(--text-secondary); font-size: var(--fs-label); }
.original-actor-form .original-actor-error { color: var(--danger-text); }
</style>
