<template>
  <Teleport to="body">
    <FluidTransition appear>
    <div class="overlay" @click.self="close">
      <section ref="dialog" class="modal-card modal-card-wide generated-scene-dialog" role="dialog" aria-modal="true" aria-labelledby="generated-scene-title" :aria-busy="saving || loading">
        <header class="modal-head">
          <h2 id="generated-scene-title">{{ savedId ? '场景已加入你的场景库' : '把这张图保存为场景' }}</h2>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="saving" aria-label="关闭保存场景窗口" @click="close"><ArchiveIcon name="close" /></button>
        </header>
        <div class="generated-scene-layout">
          <img class="generated-scene-preview" :src="source.previewUrl" alt="将要保存为场景的成片" />
          <div v-content-motion:fade="savedId || false" class="generated-scene-fields">
            <p class="generated-scene-note">保留这张成片的生成记录。以后选择场景时仍会按当前规则编译，画面可能有所不同。</p>
            <p class="generated-scene-note">角色：{{ characterName }}<span v-if="source.recipe.outfitId"> · 服装：{{ outfitName }}</span> · {{ engineName }}</p>
            <template v-if="!savedId">
              <label class="form-group"><span class="field-label">场景名称</span><input v-model="title" class="input" maxlength="120" :disabled="saving" placeholder="例如：窗边的午后" /></label>
              <label class="form-group"><span class="field-label">画面说明</span><textarea v-model="story" class="input" rows="3" :disabled="saving" placeholder="用自己的话说说这张图的场景，不需要写代码或日文。" /></label>
              <div class="form-group"><StudioSelect v-model="rating" label="确认画面分级" :disabled="saving" :options="ratingOptions" /></div>
              <div v-if="popular" class="form-group"><StudioSelect v-model="composition" label="画面构图" :disabled="saving" :options="compositionOptions" /></div>
              <label class="generated-scene-check"><input v-model="attachImage" type="checkbox" :disabled="saving" />同时把这张图保存为场景样张</label>
            </template>
            <p v-else class="generated-scene-success" role="status">「{{ title }}」已保存。可在内容维护中继续编辑，也可回到创作页选择它。</p>
          </div>
        </div>
        <details class="generated-scene-details">
          <summary>高级：查看这张图的生成记录</summary><div data-disclosure-content>
          <p class="generated-scene-note">来源提示词只读保留，不需要手动填写。</p>
          <label class="form-group"><span class="field-label">实际正向提示词</span><textarea class="input" :value="source.recipe.prompt" rows="4" readonly /></label>
          <label class="form-group"><span class="field-label">实际负向提示词</span><textarea class="input" :value="source.recipe.negative" rows="2" readonly /></label>
          <p class="generated-scene-note">尺寸 {{ source.recipe.size || '未记录' }} · Seed {{ source.recipe.seed ?? '未记录' }} · Steps {{ source.recipe.steps ?? '未记录' }} · CFG {{ source.recipe.cfg ?? '未记录' }}</p></div>
        </details>
        <p v-if="loading" class="generated-scene-note" role="status">正在读取场景库…</p>
        <p v-if="error" class="generated-scene-error" role="alert">{{ error }}</p>
        <p v-if="imageError" class="generated-scene-error" role="alert">{{ imageError }}</p>
        <div v-if="preview && !savedId" class="generated-scene-review" role="status">检查完成：新增 1 个{{ popular ? '角色场景' : '场景' }}，不会修改已有场景。保存后可在内容维护中找到。结构检查不代表已验证再次出图效果。</div>
        <footer class="modal-actions">
          <button v-if="!baseline && !loading && !savedId" class="btn btn-ghost" type="button" @click="load">重新读取</button>
          <button v-if="imageError" class="btn btn-ghost" type="button" :disabled="saving" @click="saveImage">重试保存样张</button>
          <button v-if="savedId" class="btn btn-primary" type="button" :disabled="saving" @click="openMaintenance">去内容维护</button>
          <button v-else-if="preview" class="btn btn-primary" type="button" :disabled="saving" @click="save">{{ saving ? '正在保存…' : '确认保存场景' }}</button>
          <button v-else class="btn btn-primary" type="button" :disabled="!canReview" @click="review">{{ previewing ? '正在检查…' : '检查并继续' }}</button>
          <button class="btn btn-ghost" type="button" :disabled="saving" @click="close">{{ savedId ? '完成' : '取消' }}</button>
        </footer>
      </section>
    </div>
    </FluidTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { confirmAction } from '@/composables/useConfirm'
import { useGeneratedSceneSave } from '@/composables/scene/useGeneratedSceneSave'
import type { GeneratedSceneCapture } from '@/composables/prompt/useGeneratedSceneCapture'
import { useSceneStore } from '@/stores/sceneStore'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
const props = defineProps<{ source: GeneratedSceneCapture }>()
const emit = defineEmits<{ close: [] }>()
const { title, story, rating, composition, compositionEdited, attachImage, popular, loading, saving, previewing, error,
  imageError, savedId, baseline, preview, canReview, load, review, save, saveImage } = useGeneratedSceneSave(props.source)
const dialog = ref<HTMLElement | null>(null)
const router = useRouter(), store = useSceneStore()
const original = JSON.stringify([title.value, story.value, rating.value])
const dirty = () => !savedId.value && (JSON.stringify([title.value, story.value, rating.value]) !== original
  || compositionEdited.value || !attachImage.value)
const releaseMaintenance = registerMaintenanceParticipant(() => {
  if (saving.value || dirty()) throw new Error('UNSAVED_SCENE_FORM')
})
onBeforeUnmount(releaseMaintenance)
async function canClose() {
  if (saving.value) return false
  return !dirty() || await confirmAction({ title: '放弃这次新增场景？', message: '已填写的信息尚未保存，原来的成片不受影响。', confirmLabel: '放弃新增' })
}
async function close() {
  if (await canClose()) emit('close')
}
onBeforeRouteLeave(canClose)
useFocusTrap(dialog, () => true, { onEscape: () => { void close() } })
async function openMaintenance() { const id = savedId.value; emit('close'); await router.push({ path: '/scene-manager', query: { created: id } }) }
const characterName = computed(() => store.popularCharacters.find(item => item.id === props.source.recipe.characterId)?.displayName
  || ({ nene: '绫地宁宁', natsume: '四季夏目', triad: '宁宁与夏目' }[props.source.recipe.character || ''] || props.source.recipe.characterId || '原角色'))
const outfitName = computed(() => store.popularCharacters.find(item => item.id === props.source.recipe.characterId)?.outfits
  .find(item => item.id === props.source.recipe.outfitId)?.name || props.source.recipe.outfitId)
const engineName = ({ anima: 'Anima', krea2: 'Krea 2', sd: 'SD' }[props.source.recipe.engine || 'sd'])
const ratingOptions = [{ value: '', label: '请选择画面分级' }, { value: 'All', label: '全年龄' }, { value: 'R15', label: 'R15' }, { value: 'R18', label: 'R18' }]
const compositionOptions = [{ value: 'single', label: '单人画面' }, { value: 'group', label: '多人同框' }, { value: 'triptych', label: '三格叙事' }]
</script>

<style scoped>
.generated-scene-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: var(--s-5); }
.generated-scene-preview { width: 100%; max-height: 360px; object-fit: contain; border-radius: var(--radius-md); background: var(--bg-deep); }
.generated-scene-fields { display: grid; gap: var(--s-3); min-width: 0; }
.generated-scene-note { color: var(--text-secondary); font-size: var(--fs-body-sm); line-height: 1.7; margin: 0; }
.generated-scene-check { display: flex; gap: var(--s-2); align-items: center; color: var(--text-primary); }
.generated-scene-details { margin-top: var(--s-4); }
.generated-scene-details summary { cursor: pointer; padding-block: var(--s-2); color: var(--text-secondary); }
.generated-scene-details .form-group { margin-block: var(--s-3); }
.generated-scene-review { padding: var(--s-3); margin-top: var(--s-3); background: var(--bg-surface); border: 1px solid var(--border-soft); border-radius: var(--radius-md); color: var(--text-primary); }
.generated-scene-error { color: var(--danger-text); }
.generated-scene-success { color: var(--success-text); line-height: 1.7; }
@media (max-width: 640px) { .generated-scene-layout { grid-template-columns: minmax(0, 1fr); } .generated-scene-preview { max-height: 180px; } }
</style>
