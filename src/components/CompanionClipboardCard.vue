<template>
  <Transition name="layer-fade">
    <div v-if="card" class="companion-clipboard-card" role="status" aria-live="polite">
      <img v-if="card.kind === 'image'" :src="card.previewUrl" alt="" />
      <div>
        <strong>{{ card.kind === 'image' ? '检测到复制的图片' : '检测到复制的文本' }}</strong>
        <p v-if="card.kind === 'text'" class="companion-clipboard-preview">{{ card.text }}</p>
      </div>
      <div class="companion-clipboard-actions">
        <button v-if="card.kind === 'image'" type="button" class="btn btn-secondary btn-sm" @click="emit('inspect')">让{{ characterName }}看看</button>
        <button type="button" class="btn btn-primary btn-sm" @click="emit('accept')">{{ card.kind === 'image' ? '存入作品册' : `发给${characterName}` }}</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="emit('dismiss')">忽略</button>
      </div>
    </div>
  </Transition>
</template>
<script setup lang="ts">
defineProps<{ card: { kind: 'image' | 'text'; previewUrl?: string; text?: string } | null; characterName: string }>()
const emit = defineEmits<{ inspect: []; accept: []; dismiss: [] }>()
</script>
