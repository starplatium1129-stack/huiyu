<template>
  <Teleport to="body">
    <dialog ref="dialog" class="history-reuse-dialog" aria-labelledby="history-reuse-title" @cancel.prevent="cancel" @click="backdropClose">
      <header><div><h2 id="history-reuse-title">沿用作品配方</h2><p>{{ record.sceneTitle || record.id }}</p></div><button class="btn btn-ghost btn-icon" type="button" aria-label="取消沿用配方" :disabled="busy" @click="cancel"><ArchiveIcon name="close" /></button></header>
      <div class="reuse-body">
        <fieldset><legend>沿用范围</legend>
          <label><input v-model="mode" type="radio" value="full" name="recipe-reuse-mode" :disabled="busy">完整配方 <small>恢复已记录的角色、服装、场景与参数</small></label>
          <label><input v-model="mode" type="radio" value="parts" name="recipe-reuse-mode" :disabled="busy">选择沿用 <small>保留当前角色、服装、引擎与画册</small></label>
        </fieldset>
        <fieldset v-show="mode === 'parts'" v-content-motion:down="mode === 'parts'"><legend>选择要替换的创作条件</legend>
          <label><input v-model="parts.style" type="checkbox" :disabled="busy">画风与光色 <small>画师、光照、色调及适用的风格 LoRA</small></label>
          <label><input v-model="parts.camera" type="checkbox" :disabled="busy">镜头与构图</label>
          <label><input v-model="parts.prompts" type="checkbox" :disabled="busy">提示词与场景 <small>仅同角色、同服装沿用；按当前规则重新编译</small></label>
          <label><input v-model="parts.parameters" type="checkbox" :disabled="busy">生成参数 <small>仅同引擎沿用底模、Seed、尺寸与生成设置</small></label>
        </fieldset>
        <p id="history-reuse-help">旧作缺失的字段保持未记录，原底模不可用或编译规则变化会列入配方检查。载入后进入专家模式，按沿用及保留的参数继续创作；不会自动生成图片。</p>
      </div>
      <footer><button class="btn btn-ghost" type="button" :disabled="busy" @click="cancel">取消</button><button class="btn btn-primary" type="button" :disabled="busy || mode === 'parts' && !Object.values(parts).some(Boolean)" aria-describedby="history-reuse-help" @click="apply">{{ busy ? '正在载入…' : '载入所选配方' }}</button></footer>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { contentMotion as vContentMotion } from '@/directives/contentMotion'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import type { ArtworkRecord } from '@/types/artwork'
import type { HistoryRecipeParts, HistoryReuseSelection } from '@/types/historyReuse'
const props = defineProps<{ record: ArtworkRecord; busy: boolean }>()
const emit = defineEmits<{ apply: [selection: HistoryReuseSelection]; cancel: [] }>()
const dialog = ref<HTMLDialogElement | null>(null), mode = ref<'full' | 'parts'>('full')
const parts = reactive<HistoryRecipeParts>({ style: true, camera: true, prompts: false, parameters: false })
const motion = useFluidDialog(dialog)
const shifts = new Set<Animation>()
let revision = 0
function settle() {
  revision++
  for (const animation of shifts) animation.cancel()
  shifts.clear()
}
watch(mode, async () => {
  const token = ++revision
  if (document.hidden || prefersReducedMotion() || !dialog.value?.open) { settle(); return }
  const elements = Array.from(dialog.value.querySelectorAll<HTMLElement>('#history-reuse-help, footer'))
  const before = elements.map(element => element.getBoundingClientRect().top)
  await nextTick()
  if (token !== revision || !dialog.value?.open) return
  const offsets = elements.map((element, index) => before[index] - element.getBoundingClientRect().top)
  settle()
  elements.forEach((element, index) => {
    if (Math.abs(offsets[index]) < 1 || typeof element.animate !== 'function') return
    const offset = Math.max(-8, Math.min(8, offsets[index]))
    const animation = element.animate([{ transform:`translateY(${offset}px)` }, { transform:'none' }], { duration:200, easing:'cubic-bezier(.23,1,.32,1)' })
    shifts.add(animation)
    const release = () => { shifts.delete(animation); animation.cancel() }
    void animation.finished.then(release, release)
  })
})
const stopListening = listenMotionChanges(() => { if (document.hidden || prefersReducedMotion()) settle() })
onBeforeUnmount(() => { settle(); stopListening() })
function cancel() { if (!props.busy) { settle(); motion.close(() => emit('cancel')) } }
function backdropClose(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) cancel() }
function apply() { emit('apply', mode.value === 'full' ? 'full' : { ...parts }) }
onMounted(() => motion.open())
</script>
<style scoped>
.history-reuse-dialog { margin:clamp(var(--s-5),12dvh,100px) auto auto; width:min(620px,calc(100vw - 48px)); max-height:calc(100dvh - 128px); padding:var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); color:var(--text-primary); }
.history-reuse-dialog[open] { display:flex; flex-direction:column; gap:var(--s-4); }
.history-reuse-dialog::backdrop { background:var(--art-scrim); }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s-3); }
h2 { margin:0; font-size:var(--fs-title-xs); }
p { color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); margin:var(--s-2) 0 0; overflow-wrap:anywhere; }
.reuse-body { min-height:0; overflow:auto; }
fieldset { border:1px solid var(--border-soft); border-radius:var(--r-md); padding:var(--s-3); margin:0 0 var(--s-3); }
legend { font-size:var(--fs-label); font-weight:600; padding-inline:var(--s-1); }
label { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); min-height:40px; font-size:var(--fs-label); cursor:pointer; }
small { color:var(--text-secondary); font-size:var(--fs-label-xs); }
input { accent-color:var(--accent); }
input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
input:disabled, button:disabled { color:var(--text-disabled); }
footer { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:var(--s-2); }
</style>
