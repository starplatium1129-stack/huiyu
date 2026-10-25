<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import QwenEditorContent from './QwenEditorContent.vue'
import { useFluidDialog } from '@/composables/useFluidDialog'
const props = defineProps<{ sourceImage?: File | null; opener: HTMLElement | null }>()
const emit = defineEmits<{ closed: []; sourceConsumed: [] }>()
const dialog = ref<HTMLDialogElement | null>(null), content = ref<InstanceType<typeof QwenEditorContent> | null>(null)
const fluid = useFluidDialog(dialog)
let closing = false
async function close() {
  if (closing) return
  closing = true
  try { if (!content.value || await content.value.mayClose()) fluid.close(() => emit('closed')) }
  finally { closing = false }
}
onBeforeRouteLeave(async () => { if (content.value && !await content.value.mayClose()) return false; fluid.close(() => emit('closed')) })
onMounted(() => fluid.open(props.opener))
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="qwen-editor-dialog" aria-labelledby="qwen-editor-title" aria-describedby="qwen-editor-description" @cancel.prevent="close" @keydown.stop>
    <header><div><h2 id="qwen-editor-title"><ArchiveIcon name="inpaint" />Qwen 图片编辑</h2><p id="qwen-editor-description">按指令修改原图，可添加参考图。绘图画室的内容和参数保留在原处。</p></div><button class="btn btn-quiet btn-icon" type="button" aria-label="关闭图片编辑窗口" @click="close"><ArchiveIcon name="close" /></button></header>
    <div class="qwen-editor-body"><QwenEditorContent ref="content" :source-image="sourceImage" @source-consumed="emit('sourceConsumed')" /></div>
  </dialog></Teleport>
</template>
<style scoped>
.qwen-editor-dialog { position:fixed; inset:var(--desktop-chrome-height,0px) 0 0; width:min(1184px,calc(100vw - 2 * var(--s-4))); height:min(840px,calc(100dvh - var(--desktop-chrome-height,0px) - 2 * var(--s-4))); max-width:none; max-height:none; margin:auto; padding:0; border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-base); color:var(--text-primary); box-shadow:var(--shadow-lg); overflow:hidden; }
.qwen-editor-dialog[open] { display:flex; flex-direction:column; }
.qwen-editor-dialog::backdrop { background:var(--art-scrim); }
header { display:flex; justify-content:space-between; align-items:flex-start; gap:var(--s-4); padding:var(--s-5); border-bottom:1px solid var(--border-soft); flex:none; }
h2 { display:flex; align-items:center; gap:var(--s-2); margin:0; font-size:var(--fs-title-sm); }
header p { margin:var(--s-2) 0 0; color:var(--text-secondary); font-size:var(--fs-label); line-height:var(--lh-body); }
.qwen-editor-body { overflow:auto; min-height:0; overscroll-behavior:contain; }
</style>
