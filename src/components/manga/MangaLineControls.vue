<template>
  <section class="manga-line-controls" aria-label="线稿设置">
    <div class="manga-field"><span>线稿来源</span><StudioSelect v-model="mode" label="线稿来源" :disabled="disabled" :options="sources" /></div>
    <template v-if="mode === 'auto'">
      <p v-if="!status?.lineart.available" class="manga-hint">{{ status?.lineart.unavailableReason || '线稿模型尚未就绪' }}</p>
      <RouterLink v-if="status && !status.lineart.available && !disabled" class="btn btn-quiet btn-sm" :to="{ path: '/control', query: { resource: 'manga-line-extraction' }, hash: '#control-setup' }">准备漫画线稿模型</RouterLink>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="disabled || !!extractionIssue" @click="emit('extract')"><ArchiveIcon name="spark" />仅提取线稿</button>
      <p v-if="extractionIssue && status?.lineart.available" class="manga-hint" role="status">{{ extractionIssue }}</p>
    </template>
    <template v-else-if="mode === 'external'">
      <div class="manga-line-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="disabled || !targetSize" @click="picker?.click()"><ArchiveIcon name="upload" />{{ imported ? '更换线稿' : '导入线稿' }}</button>
        <button v-if="imported" class="btn btn-quiet btn-sm" type="button" :disabled="disabled" @click="removeImported">移除</button>
      </div>
      <input ref="picker" type="file" class="manga-file" accept="image/png,image/jpeg,image/webp" @change="pick" />
      <p v-if="!targetSize" class="manga-hint">请先导入漫画原图，再选择对应线稿。</p>
      <p class="manga-hint">支持 PNG/JPEG/WebP（最长边 4096）；暂不与重绘同用。</p>
      <p v-if="imported" class="manga-hint">{{ imported.name }} · {{ imported.width }} × {{ imported.height }}</p>
      <div class="manga-field"><span>原文件黑白极性</span><StudioSelect v-model="polarity" label="线稿黑白极性" :disabled="disabled" :options="polarities" /></div>
      <p class="manga-hint">预览和导出统一为黑线白底；透明区域按所选底色合成。</p>
      <template v-if="imported">
        <template v-if="mismatch">
          <StudioCheckbox v-model:checked="stretch" :disabled="disabled" label="允许缩放对齐处理图">允许缩放对齐处理图</StudioCheckbox>
          <p class="manga-hint">任务中缩放到 {{ targetSize?.width }} × {{ targetSize?.height }}。比例不同时会拉伸，请检查是否错位；导入预览保留原尺寸。</p>
        </template>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="disabled" @click="inputReady ? emit('preview') : emit('retry')">{{ inputReady ? '查看导入线稿' : '重新生成线稿预览' }}</button>
      </template>
    </template>
    <p v-if="redraw" class="manga-hint">关闭 Qwen 重绘后可选择导入线稿。</p>
    <p v-if="issue" class="manga-hint" role="status">{{ issue }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { MangaLinePolarity, MangaStatus } from '@/api/mangaApi'
import type { MangaLineMode } from '@/composables/manga/useMangaLines'
import type { MangaImage } from '@/composables/manga/mangaImage'
const props = defineProps<{ disabled: boolean; redraw: boolean; status: MangaStatus | null; imported: MangaImage | null;
  targetSize: {width:number; height:number} | null; mismatch: boolean; inputReady: boolean; issue: string; extractionIssue: string }>()
const mode = defineModel<MangaLineMode>('mode', {required:true})
const polarity = defineModel<MangaLinePolarity>('polarity', {required:true})
const stretch = defineModel<boolean>('stretch', {required:true})
const emit = defineEmits<{import: [file: File]; remove: []; preview: []; retry: []; extract: []}>()
const picker = ref<HTMLInputElement | null>(null)
const sources = computed(() => [{value:'none',label:'不使用线稿'}, {value:'auto',label:'自动提取线稿'}, {value:'external',label:'导入外部线稿',disabled:props.redraw}])
const polarities = [{value:'black-on-white',label:'黑线白底'}, {value:'white-on-black',label:'白线黑底'}]
function removeImported(event: MouseEvent) {
  const origin = event.currentTarget
  if (origin instanceof HTMLElement && document.activeElement === origin)
    origin.closest('.manga-line-controls')?.querySelector<HTMLButtonElement>('.studio-select-trigger')?.focus({ preventScroll: true })
  emit('remove')
}
function pick(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (file && !props.disabled && !props.redraw && props.targetSize) emit('import', file)
}
</script>
