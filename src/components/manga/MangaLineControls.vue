<template>
  <section class="manga-line-controls" aria-label="线稿设置">
    <div class="manga-field"><span>线稿来源</span><StudioSelect v-model="mode" label="线稿来源" :disabled="disabled" :options="sources" /></div>
    <p class="manga-hint">线稿可单独预览、导出和存入作品库，启用后叠入漫画。待主力机验证。</p>
    <template v-if="mode === 'auto'">
      <p class="manga-hint">处理漫画时，{{ redraw ? '从 Qwen 重绘图' : '从当前处理图' }}提取结构线。使用官方 MangaLineExtraction，CPU 执行。</p>
      <p class="manga-hint">{{ status?.lineart.available ? 'erika.pth 文件已就位，依赖与效果仍待主力机验证。' : status?.lineart.unavailableReason || '尚未读取线稿模型状态' }}</p>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="disabled || !!extractionIssue" @click="emit('extract')"><ArchiveIcon name="spark" />仅提取线稿</button>
      <p class="manga-hint">独立提取只处理原图，按上方缩小设置执行，不运行 Qwen、色阶或网点。完成后自动打开线稿预览。</p>
      <p v-if="extractionIssue && status?.lineart.available" class="manga-hint" role="status">{{ extractionIssue }}</p>
    </template>
    <template v-else-if="mode === 'external'">
      <div class="manga-line-actions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="disabled || !targetSize" @click="picker?.click()"><ArchiveIcon name="upload" />{{ imported ? '更换线稿' : '导入线稿' }}</button>
        <button v-if="imported" class="btn btn-quiet btn-sm" type="button" :disabled="disabled" @click="emit('remove')">移除</button>
      </div>
      <input ref="picker" type="file" class="manga-file" accept="image/png,image/jpeg,image/webp" @change="pick" />
      <p v-if="!targetSize" class="manga-hint">请先导入漫画原图，再选择与其对应的线稿。</p>
      <p class="manga-hint">PNG、JPEG、WebP · 最长边 4096 · 不超过约 200 万像素。外部线稿暂不与 Qwen 重绘同时使用。</p>
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
function pick(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (file && !props.disabled && !props.redraw && props.targetSize) emit('import', file)
}
</script>
