<template>
  <section class="manga-models" aria-label="漫画模型步骤">
    <StudioCheckbox v-model:checked="redraw" :disabled="disabled || externalLines" label="Qwen 漫画重绘">Qwen 漫画重绘</StudioCheckbox>
    <p v-if="externalLines" class="manga-hint">线稿来源改为「不使用」或「自动提取」后，可启用 Qwen 重绘。</p>
    <p v-if="redraw" class="manga-hint">重绘可能改变细节，请预览后保存。</p>
    <div v-if="redraw" class="manga-fields">
      <div class="manga-field"><span>重绘模型</span><StudioSelect v-model="rewrite.modelId" label="漫画重绘模型" :disabled="disabled" :options="models" /></div>
      <p v-if="selected && !selected.available && !issue" class="manga-error" role="status">{{ selected.unavailableReason }}</p>
      <RouterLink v-if="selected && !selected.available && !disabled" class="btn btn-quiet btn-sm" :to="{ path: '/control', query: { engine: 'native', model: rewrite.modelId }, hash: '#control-setup' }">准备 Qwen 重绘模型</RouterLink>
      <details><StudioDisclosureSummary>尺寸与重绘指令</StudioDisclosureSummary>
        <div class="manga-fields" data-disclosure-content>
          <div class="manga-dimensions">
            <label class="manga-field"><span>重绘宽度</span><input class="input" v-model.number="rewrite.width" type="number" min="512" max="2816" step="32" :disabled="disabled" /></label>
            <label class="manga-field"><span>重绘高度</span><input class="input" v-model.number="rewrite.height" type="number" min="512" max="2816" step="32" :disabled="disabled" /></label>
          </div>
          <p class="manga-hint">默认按原图比例接近 200 万像素，尺寸为 32 的倍数；极端长图可能改变比例。</p>
          <label class="manga-field"><span>重绘指令</span><textarea class="input" v-model="rewrite.prompt" rows="6" maxlength="12000" :disabled="disabled" spellcheck="false" autocorrect="off" autocapitalize="off" /></label>
          <StudioCheckbox v-model:checked="randomSeed" :disabled="disabled" label="每次随机种子">每次随机种子</StudioCheckbox>
          <label v-if="!randomSeed" class="manga-field"><span>种子</span><input class="input" v-model.number="rewrite.seed" type="number" min="0" max="2147483647" step="1" :disabled="disabled" spellcheck="false" autocorrect="off" autocapitalize="off" /></label>
        </div>
      </details>
      <details><StudioDisclosureSummary>模型许可</StudioDisclosureSummary><p class="manga-hint" data-disclosure-content>Qwen 采用研究许可。<a v-if="selected" :href="selected.licenseUrl" target="_blank" rel="noopener noreferrer">查看许可条款</a></p></details>
    </div>
    <p v-if="issue" class="manga-error" role="status">{{ issue }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { MangaRewrite, MangaStatus } from '@/api/mangaApi'
const props = defineProps<{ disabled: boolean; externalLines: boolean; status: MangaStatus | null; issue: string }>()
const redraw = defineModel<boolean>('redraw', {required:true})
const randomSeed = defineModel<boolean>('randomSeed', {required:true})
const rewrite = defineModel<MangaRewrite>('rewrite', {required:true})
const models = [{value:'qwen-image-2.1-turbo',label:'Qwen-Image 2.1 Turbo · 8 步'}, {value:'qwen-image-2.1',label:'Qwen-Image 2.1 · 40 步'}]
const selected = computed(() => props.status?.rewrite.find(model => model.id === rewrite.value.modelId))
</script>
