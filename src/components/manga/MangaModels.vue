<template>
  <section class="manga-models" aria-label="漫画模型步骤">
    <StudioCheckbox v-model:checked="redraw" :disabled="disabled || externalLines" label="Qwen 漫画重绘">Qwen 漫画重绘</StudioCheckbox>
    <p v-if="externalLines" class="manga-hint">线稿来源改为「不使用」或「自动提取」后，可启用 Qwen 重绘。</p>
    <p class="manga-hint">先按原图重绘，再制作网点。人物与画面细节可能改变，请预览后保存。</p>
    <div v-if="redraw" class="manga-fields">
      <div class="manga-field"><span>重绘模型</span><StudioSelect v-model="rewrite.modelId" label="漫画重绘模型" :disabled="disabled" :options="models" /></div>
      <p class="manga-hint">{{ selected?.available ? `模型文件已就位 · ${selected.steps} 步 · 待主力机验证` : selected?.unavailableReason || '尚未读取模型状态' }}</p>
      <p class="manga-hint">显存策略沿用控制室：{{ status?.memoryPolicy === 'offload' ? '模型卸载' : '常驻' }}。重绘结束后释放模型。</p>
      <p class="manga-hint">Qwen 权重采用研究许可，商用需另获授权。<a v-if="selected" :href="selected.licenseUrl" target="_blank" rel="noopener noreferrer">查看模型许可</a></p>
      <div class="manga-dimensions">
        <label class="manga-field"><span>重绘宽度</span><input class="input" v-model.number="rewrite.width" type="number" min="512" max="2816" step="32" :disabled="disabled" /></label>
        <label class="manga-field"><span>重绘高度</span><input class="input" v-model.number="rewrite.height" type="number" min="512" max="2816" step="32" :disabled="disabled" /></label>
      </div>
      <p class="manga-hint">按原图比例建议尺寸，按 32 像素对齐；可手动调整。总像素不超过约 200 万，极端长图可能改变比例。</p>
      <details><StudioDisclosureSummary>重绘指令与种子</StudioDisclosureSummary>
        <div class="manga-fields" data-disclosure-content>
          <label class="manga-field"><span>重绘指令</span><textarea class="input" v-model="rewrite.prompt" rows="6" maxlength="12000" :disabled="disabled" /></label>
          <label class="manga-field"><span>随机种子</span><input class="input" v-model.number="rewrite.seed" type="number" min="0" max="2147483647" step="1" :disabled="disabled" /></label>
          <p class="manga-hint">使用模型官方步数与 CFG；此入口暂不提供负向提示词或重绘强度。</p>
        </div>
      </details>
    </div>
    <p v-if="issue" class="manga-error" role="status">{{ issue }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import type { MangaRewrite, MangaStatus } from '@/api/mangaApi'
const props = defineProps<{ disabled: boolean; externalLines: boolean; status: MangaStatus | null; issue: string }>()
const redraw = defineModel<boolean>('redraw', {required:true})
const rewrite = defineModel<MangaRewrite>('rewrite', {required:true})
const models = [{value:'qwen-image-2.1-turbo',label:'Qwen-Image 2.1 Turbo · 8 步'}, {value:'qwen-image-2.1',label:'Qwen-Image 2.1 · 40 步'}]
const selected = computed(() => props.status?.rewrite.find(model => model.id === rewrite.value.modelId))
</script>
