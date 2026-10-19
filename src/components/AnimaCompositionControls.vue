<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AnimaCompositionRegions from '@/components/AnimaCompositionRegions.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import type { AnimaCompositionSession } from '@/composables/generation/useAnimaComposition'

const props = defineProps<{ session: AnimaCompositionSession }>()
const { sketch, sketchSettings, regions, selectedId, editorOpen, reading, error, locked, baseIssue, sketchIssue,
  draftIssue, canGenerate, aspectRatio, stretched, state, preparing, capabilities } = props.session
const dialog = ref<HTMLDialogElement | null>(null), opener = ref<HTMLButtonElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const modal = useFluidDialog(dialog)
const summary = computed(() => [sketch.value ? '已导入草图' : '', regions.value.length ? `${regions.value.length} 个区域` : ''].filter(Boolean).join(' · ') || '草图引导与区域提示词')
const colors = ['var(--accent)', 'var(--info-text)', 'var(--warning-text)', 'var(--success-text)']
let attached = true
watch(editorOpen, async value => {
  await nextTick()
  if (!attached) return
  if (value && editorOpen.value) modal.open(opener.value)
  else if (!editorOpen.value) modal.close()
}, { immediate: true, flush: 'post' })
function close() { props.session.closeEditor(); modal.close() }
function onNativeClose() { if (!dialog.value?.open) props.session.closeEditor() }
function backdrop(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) close() }
function pick(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (file) void props.session.selectSketch(file, file.name)
}
function drop(event: DragEvent) {
  const file = event.dataTransfer?.files[0]
  if (file && !locked.value && !sketchIssue.value) void props.session.selectSketch(file, file.name)
}
onDeactivated(close)
onBeforeUnmount(() => { attached = false; close() })
</script>

<template>
  <section class="anima-composition-controls" aria-label="构图控制">
    <div class="composition-launcher-copy"><strong><ArchiveIcon name="rule3" />构图控制</strong><span>{{ summary }}</span></div>
    <button ref="opener" class="btn btn-ghost" type="button" aria-haspopup="dialog" :aria-expanded="editorOpen" :disabled="locked" @click="session.openEditor()">编辑构图</button>
    <p v-if="baseIssue" class="composition-help">{{ baseIssue }}</p>
    <Teleport to="body">
      <dialog ref="dialog" class="anima-composition-dialog" aria-labelledby="anima-composition-title" @cancel.prevent="close" @close="onNativeClose" @click="backdrop">
        <header class="composition-dialog-heading"><div><h2 id="anima-composition-title"><ArchiveIcon name="rule3" />构图控制</h2><p>上传草图引导布局，或为不同区域补充描述。</p></div>
          <button class="btn btn-quiet btn-icon" type="button" aria-label="关闭构图编辑" autofocus @click="close"><ArchiveIcon name="close" /></button>
        </header>
        <div class="composition-editor-body">
          <section class="composition-preview-column" aria-label="构图范围预览">
            <div class="composition-preview-meta"><strong>输出画幅 {{ state.width }} × {{ state.height }}</strong><span>{{ regions.length ? '点击矩形选择区域' : '区域会标记在这里' }}</span></div>
            <div class="composition-preview-fit"><div class="composition-preview" :style="{ aspectRatio, '--composition-ratio': state.width / state.height }" @dragover.prevent @drop.prevent="drop">
              <img v-if="sketch" :src="sketch.url" :alt="`草图预览：${sketch.name}`" />
              <span v-else class="composition-empty-preview"><ArchiveIcon name="image" />导入草图或添加区域<br />全局画面描述仍参与生成</span>
              <button v-for="(region, index) in regions" :key="region.id" class="composition-region-outline" type="button"
                :aria-label="`选择区域 ${index + 1}`" :aria-pressed="selectedId === region.id" :disabled="locked"
                :style="{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%`, '--region-color': colors[index] }"
                @click="selectedId = region.id"><span>区域 {{ index + 1 }}{{ selectedId === region.id ? ' · 当前' : '' }}</span></button>
            </div></div>
            <p v-if="stretched" class="composition-help">草图比例与输出不同，将按输出画幅拉伸。请调整画幅或换用相同比例的草图。</p>
            <p class="composition-help">矩形位置按整个输出画幅计算；区域外继续使用全局提示词。</p>
          </section>
          <div class="composition-editor-fields">
            <section class="composition-sketch" aria-labelledby="composition-sketch-title">
              <h3 id="composition-sketch-title">草图 / 线稿</h3>
              <p v-if="sketchIssue" class="composition-help" role="status">{{ sketchIssue }}</p>
              <p v-if="sketchIssue && capabilities?.sketchControlStatus?.file" class="composition-help composition-weight-path">模型位置：{{ capabilities.sketchControlStatus.file }}<br /><a v-if="capabilities.sketchControlStatus.source" :href="capabilities.sketchControlStatus.source" target="_blank" rel="noopener noreferrer">查看指定草图权重</a></p>
              <p v-if="sketch" class="composition-sketch-name">{{ sketch.name }} · {{ sketch.width }} × {{ sketch.height }}</p>
              <div class="composition-sketch-actions">
                <button class="btn btn-ghost btn-sm" type="button" :disabled="locked || !!sketchIssue" @click="fileInput?.click()"><ArchiveIcon name="upload" />{{ reading ? '正在读取…' : sketch ? '替换草图' : '导入草图' }}</button>
                <button v-if="sketch" class="btn btn-quiet btn-sm" type="button" :disabled="locked" @click="session.removeSketch()">移除草图</button>
              </div>
              <input ref="fileInput" class="sr-only" type="file" tabindex="-1" accept="image/png,image/jpeg,image/webp" aria-label="选择草图或线稿" @change="pick" />
              <p class="composition-help">PNG、JPEG、WebP · 每张不超过 16 MiB，也可拖入左侧预览。</p>
              <fieldset v-if="sketch" class="composition-sketch-settings" :disabled="locked || !!sketchIssue">
                <legend class="sr-only">草图引导参数</legend>
                <label class="composition-field"><span>控制强度 <output>{{ Number(sketchSettings.strength).toFixed(2) }}</output></span><input v-model.number="sketchSettings.strength" type="range" min="0" max="2" step="0.05" /></label>
                <div class="composition-proportions">
                  <label class="composition-field"><span>开始比例</span><input v-model.number="sketchSettings.start" type="number" min="0" max="1" step="0.05" /></label>
                  <label class="composition-field"><span>结束比例</span><input v-model.number="sketchSettings.end" type="number" min="0" max="1" step="0.05" /></label>
                </div>
                <p class="composition-help">0 是采样开始，1 是结束；开始比例应小于结束比例。</p>
              </fieldset>
            </section>
            <AnimaCompositionRegions :session="session" />
          </div>
        </div>
        <footer class="composition-dialog-footer">
          <div class="composition-footer-copy"><p>构图生成采用完整采样，关闭特征缓存；暂不支持高清修复。</p><p v-if="error || draftIssue" :role="error ? 'alert' : 'status'">{{ error || draftIssue }}</p><p v-else-if="preparing" role="status">正在准备草图与本次构图，可以取消准备。</p></div>
          <button v-if="preparing" class="btn btn-ghost" type="button" @click="session.cancelPreparation()">取消准备</button>
          <button class="btn btn-primary" type="button" :disabled="!canGenerate && !preparing" :aria-disabled="!canGenerate || undefined" :aria-busy="preparing" @click="session.generate()"><ArchiveIcon name="palette" />{{ preparing ? '准备中…' : '按构图生成' }}</button>
        </footer>
      </dialog>
    </Teleport>
  </section>
</template>

<style scoped>
.anima-composition-controls { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-3); }
.composition-launcher-copy { display:flex; flex:1; flex-direction:column; gap:var(--s-1); min-width:0; }
.composition-launcher-copy strong,.composition-dialog-heading h2 { display:flex; align-items:center; gap:var(--s-2); color:var(--text-primary); }
.composition-launcher-copy strong { font-size:var(--fs-body-sm); }
.composition-launcher-copy span,.composition-help { color:var(--text-secondary); font:400 var(--fs-label-sm)/var(--lh-body) var(--font-sans); }
.composition-help { margin:0; }
.composition-weight-path { overflow-wrap:anywhere; }
.anima-composition-controls > p { flex-basis:100%; }
.anima-composition-dialog { position:fixed; inset:var(--desktop-chrome-height,0px) 0 0; margin:auto; box-sizing:border-box; width:min(1160px,calc(100vw - 2 * var(--s-4))); height:min(860px,calc(100dvh - var(--desktop-chrome-height,0px) - 2 * var(--s-4))); max-width:none; max-height:none; padding:0; overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); color:var(--text-primary); }
.anima-composition-dialog[open] { display:flex; flex-direction:column; }
.anima-composition-dialog::backdrop { background:var(--art-scrim); }
.composition-dialog-heading { display:flex; flex:none; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-4) var(--s-5); border-bottom:1px solid var(--border-soft); }
.composition-dialog-heading h2 { margin:0; font:600 var(--fs-title)/var(--lh-label) var(--font-sans); }
.composition-dialog-heading p { margin:var(--s-1) 0 0; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.composition-dialog-heading > button { flex:none; }
.composition-editor-body { display:grid; flex:1; grid-template-columns:minmax(0,1fr) minmax(300px,360px); min-height:0; }
.composition-preview-column { display:flex; flex-direction:column; gap:var(--s-3); min-width:0; min-height:0; padding:var(--s-5); overflow:auto; }
.composition-preview-meta { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--s-2); font-size:var(--fs-label-sm); }
.composition-preview-meta span { color:var(--text-secondary); }
.composition-preview-fit { display:grid; flex:1; min-height:200px; place-items:center; container-type:size; }
.composition-preview { position:relative; width:min(100cqw,calc(100cqh * var(--composition-ratio))); overflow:hidden; border:1px solid var(--border-strong); border-radius:var(--r-md); background:var(--bg-base); }
.composition-preview > img { position:absolute; inset:0; width:100%; height:100%; object-fit:fill; }
.composition-empty-preview { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--s-2); padding:var(--s-4); color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); text-align:center; }
.composition-empty-preview > .archive-icon { width:32px; height:32px; }
.composition-region-outline { position:absolute; display:block; padding:0; border:2px dashed var(--region-color,var(--accent)); border-radius:0; background:color-mix(in srgb,var(--region-color,var(--accent)) 8%,transparent); cursor:pointer; }
.composition-region-outline[aria-pressed='true'] { border-style:solid; border-width:3px; background:color-mix(in srgb,var(--region-color,var(--accent)) 15%,transparent); }
.composition-region-outline > span { position:absolute; top:var(--s-1); left:var(--s-1); max-width:calc(100% - var(--s-2)); padding:var(--s-1) var(--s-2); border-radius:var(--r-xs); background:var(--art-scrim); color:var(--on-art-primary); font:600 var(--fs-label-xs)/var(--lh-label) var(--font-sans); overflow-wrap:anywhere; text-align:left; }
.composition-region-outline:focus-visible { outline:3px solid var(--text-primary); outline-offset:-6px; }
.composition-region-outline:disabled { cursor:default; }
.composition-editor-fields { display:flex; flex-direction:column; gap:var(--s-5); min-height:0; overflow:auto; padding:var(--s-5); border-left:1px solid var(--border-soft); }
.composition-sketch,.composition-sketch-settings { display:flex; flex-direction:column; gap:var(--s-3); min-width:0; }
.composition-sketch h3 { margin:0; font:600 var(--fs-body)/var(--lh-label) var(--font-sans); }
.composition-sketch-name { margin:0; color:var(--text-primary); font-size:var(--fs-label-sm); overflow-wrap:anywhere; }
.composition-sketch-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.composition-sketch-settings { padding:0; margin:0; border:0; }
.composition-field { display:flex; flex-direction:column; gap:var(--s-2); min-width:0; color:var(--text-primary); font-size:var(--fs-label-sm); }
.composition-field > span { display:flex; justify-content:space-between; gap:var(--s-2); }
.composition-field input { width:100%; }
.composition-proportions { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-3); }
.composition-dialog-footer { display:flex; flex:none; align-items:center; flex-wrap:wrap; gap:var(--s-3); padding:var(--s-4) var(--s-5); border-top:1px solid var(--border-soft); }
.composition-footer-copy { flex:1; min-width:min(100%,280px); }
.composition-footer-copy p { margin:0; color:var(--text-secondary); font:400 var(--fs-label-sm)/var(--lh-body) var(--font-sans); }
.composition-footer-copy p + p { margin-top:var(--s-1); color:var(--text-primary); }
.composition-dialog-footer > .btn { flex:none; }
@media (max-width:800px) { .composition-editor-body { display:flex; flex-direction:column; overflow:auto; } .composition-preview-column { flex:none; overflow:visible; } .composition-preview-fit { flex:none; container-type:normal; } .composition-preview { width:min(100%,380px); } .composition-editor-fields { flex:none; overflow:visible; border-left:0; border-top:1px solid var(--border-soft); } }
</style>
