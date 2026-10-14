<template>
  <section class="character-art-manager" aria-labelledby="character-art-title">
    <header class="character-art-heading">
      <h2 id="character-art-title">角色图片维护</h2>
      <button class="btn btn-ghost" type="button" :disabled="loading || saving" @click="load">重新读取</button>
    </header>
    <p v-if="loading" class="character-art-note" role="status">正在读取角色和当前形象…</p>
    <p v-if="error" class="character-art-error" role="alert">{{ error }}</p>
    <p v-if="feedback" class="character-art-success" role="status">{{ feedback }}</p>
    <template v-if="profiles.length">
      <StudioSelect :model-value="selectedId" label="选择要维护的角色" :options="profiles.map(item => ({ value: item.id, label: item.name }))" :disabled="saving || reading" @update:model-value="value => selectCharacter(String(value))" />
      <div v-content-motion:fade="selectedId" class="character-art-grid">
        <section class="character-art-card">
          <h3>当前形象 <span>{{ custom ? '自定义' : '内置' }}</span></h3>
          <RuntimeImage v-if="originalUrl" class="character-art-image" :src="originalUrl" :alt="`${current?.name || ''}当前立绘`" />
          <ArchiveStatePanel v-else compact kind="empty" title="尚未登记立绘" />
          <p class="character-art-note" v-if="custom">{{ custom.width }} × {{ custom.height }} · {{ custom.hasTransparency ? '透明背景' : '不透明背景' }}</p>
          <button class="btn btn-ghost" type="button" @click="showParticles = !showParticles">{{ showParticles ? '收起粒子预览' : '查看当前粒子形象' }}</button>
        </section>
        <section class="character-art-card">
          <h3>替换预览 <span v-if="file">尚未应用</span></h3>
          <RuntimeImage v-if="previewUrl" class="character-art-image" :src="previewUrl" alt="准备替换的新立绘" />
          <ArchiveStatePanel v-else compact kind="empty" title="尚未选择图片" />
          <p class="character-art-note">PNG / JPEG / WebP · ≤15 MB · 边长 ≤8192 px · ≤3200 万像素</p>
          <p class="character-art-note">建议透明背景 · 仅替换展示立绘</p>
          <input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="onFile" />
          <div class="character-art-actions">
            <button class="btn btn-ghost" type="button" :disabled="!ready || saving || reading || !local" @click="fileInput?.click()"><ArchiveIcon name="image" />{{ reading ? '正在检查图片…' : '选择图片' }}</button>
            <button v-if="file" class="btn btn-ghost" type="button" :disabled="saving" @click="discard">取消替换</button>
          </div>
        </section>
      </div>
      <div v-if="showParticles" v-content-motion:fade="showParticles" class="character-art-particles">
        <SemanticParticleField :shape="particleTheme.shape" :portrait-id="selectedId" :label="`${current?.name || ''}已保存的粒子形象`" density="ambient" />
      </div>
      <footer class="character-art-actions">
        <button class="btn btn-primary" type="button" :disabled="!file || !ready || saving || reading" @click="save">{{ saving ? '正在同步形象…' : '应用立绘并同步粒子' }}</button>
        <button class="btn btn-ghost" type="button" :disabled="!custom || !ready || saving || reading" @click="reset">恢复内置形象</button>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import { characterParticleTheme } from '@/utils/characterParticleTheme'
import { useCharacterArtManager } from '@/composables/scene/useCharacterArtManager'
const props = defineProps<{ initialCharacterId?: string }>()
const { selectedId, previewUrl, feedback, error, loading, saving, reading, ready, file,
  profiles, current, custom, originalUrl, local, load, selectCharacter, pick, discard, save, reset, canLeave } = useCharacterArtManager(() => props.initialCharacterId)
defineExpose({ canLeave })
const SemanticParticleField = defineAsyncComponent(() => import('@/components/visual/SemanticParticleField.vue'))
const fileInput = ref<HTMLInputElement | null>(null), showParticles = ref(false)
const particleTheme = computed(() => characterParticleTheme(selectedId.value))
async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const candidate = input.files?.[0]; input.value = ''
  if (candidate) await pick(candidate)
}
</script>

<style scoped>
.character-art-manager { display: grid; gap: var(--s-4); min-width: 0; }
.character-art-heading { display: flex; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap; align-items: center; }
.character-art-heading h2, .character-art-card h3 { margin: 0; color: var(--text-primary); }
.character-art-note { color: var(--text-secondary); line-height: 1.7; margin: 0; }
.character-art-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); }
.character-art-card { display: flex; flex-direction: column; gap: var(--s-3); min-width: 0; padding: var(--s-4); background: var(--bg-surface); border: 1px solid var(--border-soft); border-radius: var(--r-md); }
.character-art-card h3 span { color: var(--text-secondary); font-size: var(--fs-label); font-weight: 400; }
.character-art-card :deep(.character-art-image) { display: block; width: 100%; height: 320px; object-fit: contain; background: var(--bg-base); border-radius: var(--r-md); }
.character-art-actions { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.character-art-error { color: var(--danger-text); margin: 0; }
.character-art-success { color: var(--success-text); margin: 0; }
.character-art-particles { height: 360px; min-width: 0; }
.character-art-particles :deep(.semantic-particle-field) { height: 100%; }
@media (max-width: 1000px) { .character-art-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
