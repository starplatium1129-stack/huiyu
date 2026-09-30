<template>
  <div v-if="pb.historyRestoreReport" class="restore-notice">
    <button class="btn btn-ghost btn-sm" type="button" aria-label="查看配方变化" @click="motion.open()"><ArchiveIcon name="compare" />配方检查<span v-if="changedCount"> · {{ changedCount }}</span></button>
  </div>
  <Teleport v-if="pb.historyRestoreReport" to="body">
    <dialog ref="dialog" class="recipe-review-dialog" aria-labelledby="recipe-review-title" @cancel.prevent="motion.close()" @click="backdropClose">
      <header><div><h2 id="recipe-review-title">{{ pb.historyRestoreReport.title }}</h2><p>核对原作与当前参数；关闭后继续在画布创作。</p></div><button class="btn btn-ghost btn-icon" type="button" aria-label="关闭配方对比" @click="motion.close()"><ArchiveIcon name="close" /></button></header>
      <div class="recipe-review-body">
        <ul class="recipe-restore-notes"><li v-for="note in pb.historyRestoreReport.notes" :key="note">{{ note }}</li></ul>
        <template v-if="rows.length">
          <div class="recipe-diff-heading"><strong>{{ mode === 'pro' ? '原作记录与当前提交参数' : '原作记录与当前编译草稿' }}</strong><label><input v-model="differencesOnly" type="checkbox">仅看变化与缺失</label></div>
          <p v-if="mode !== 'pro'" class="recipe-diff-note">场景模式在提交时会采用推荐设置。<button type="button" class="btn btn-ghost btn-sm" @click="useCurrentParams">按当前参数进入专家模式</button></p>
          <p v-if="!current" class="recipe-diff-note" role="status">当前请求尚未就绪，请先核对底模与角色设置。</p>
          <div class="recipe-diff-table"><table><thead><tr><th scope="col">参数</th><th scope="col">原作记录</th><th scope="col">{{ mode === 'pro' ? '当前提交' : '当前编译草稿' }}</th></tr></thead><tbody>
            <tr v-for="row in shownRows" :key="row.key" :data-parameter="row.key" :data-status="row.status"><th scope="row">{{ row.label }}<small>{{ statusText[row.status] }}</small></th><td><pre>{{ row.before }}</pre></td><td><pre>{{ row.after }}</pre></td></tr>
          </tbody></table></div>
          <p v-if="!shownRows.length" class="recipe-diff-note">已记录参数一致。仍可展开完整参数核对。</p>
          <p class="recipe-diff-note">未记录的信息保持未知；随机种子与底模默认项在生成完成后才能核实。提示词继续按当前角色和分级规则编译。</p>
        </template>
      </div>
      <footer><button class="btn btn-ghost" type="button" @click="dismiss">收起配方检查</button><button class="btn btn-primary" type="button" @click="motion.close()">返回画布</button></footer>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import { computed, onDeactivated, ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { compareRecipes } from '@/utils/recipeComparison'
import { previewRecipeSubmission, type RecipePreviewContext } from '@/composables/prompt/recipeSubmissionPreview'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
const props = defineProps<{ context: RecipePreviewContext; mode: string }>()
const emit = defineEmits<{ expert: [] }>()
const pb = usePromptBuilderStore(), dialog = ref<HTMLDialogElement | null>(null), differencesOnly = ref(true)
const motion = useFluidDialog(dialog)
const current = computed(() => previewRecipeSubmission(props.context))
const rows = computed(() => pb.historyRestoreReport?.original ? compareRecipes(pb.historyRestoreReport.original, current.value) : [])
const shownRows = computed(() => differencesOnly.value ? rows.value.filter(row => row.status !== 'same') : rows.value)
const changedCount = computed(() => rows.value.filter(row => row.status !== 'same').length)
const statusText = { same: '一致', changed: '已变化', missing: '原作未记录', unavailable: '当前未就绪' }
function backdropClose(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) motion.close() }
function dismiss() { motion.close(() => { pb.historyRestoreReport = null }) }
function useCurrentParams() { motion.close(() => emit('expert')) }
onDeactivated(() => dialog.value?.close())
</script>
<style scoped>
.restore-notice { display:inline-flex; }
.recipe-review-dialog { margin:auto; width:min(1080px,calc(100vw - 48px)); max-height:calc(100dvh - 64px); padding:var(--s-5); border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); color:var(--text-primary); }
.recipe-review-dialog[open] { display:flex; flex-direction:column; gap:var(--s-4); }
.recipe-review-dialog::backdrop { background:var(--art-scrim); }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s-4); }
h2 { margin:0; font-size:var(--fs-title-xs); }
header p { margin:var(--s-2) 0 0; color:var(--text-secondary); font-size:var(--fs-label); }
.recipe-review-body { min-height:0; overflow:auto; scrollbar-gutter:stable; }
.recipe-restore-notes { margin:0 0 var(--s-4); padding-left:var(--s-4); color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); }
.recipe-diff-heading { display:flex; justify-content:space-between; align-items:center; gap:var(--s-3); flex-wrap:wrap; margin-block:var(--s-3); font-size:var(--fs-label); }
.recipe-diff-heading label { display:flex; align-items:center; gap:var(--s-2); min-height:32px; color:var(--text-secondary); }
.recipe-diff-table { overflow-x:auto; }
table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:var(--fs-label); }
th,td { padding:var(--s-2); border:1px solid var(--border-soft); vertical-align:top; text-align:left; }
th:first-child { width:140px; }
th { color:var(--text-primary); font-weight:600; }
th small { display:block; margin-top:var(--s-1); color:var(--text-secondary); font-weight:400; }
tr[data-status='changed'] { background:var(--accent-soft); }
pre { margin:0; max-height:180px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; color:var(--text-primary); }
.recipe-diff-note { color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); margin-bottom:0; }
input { accent-color:var(--accent); }
input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
footer { display:flex; justify-content:flex-end; gap:var(--s-2); flex-shrink:0; }
</style>
