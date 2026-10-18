<template>
  <div class="manga-parameters">
    <div class="manga-field"><span>处理方式</span><StudioSelect v-model="operation" label="漫画处理方式" :disabled="disabled" :options="operations" /></div>
    <p class="manga-hint">{{ descriptions[operation] }}</p>
    <details v-for="group in groups" :key="group" :open="group === 'finish'" class="manga-parameter-group">
      <StudioDisclosureSummary>{{ groupNames[group] }}</StudioDisclosureSummary>
      <div class="manga-fields" data-disclosure-content>
        <template v-for="field in fields(group)" :key="field.key">
          <div v-if="field.choices" class="manga-field"><span>{{ labels[field.key] }}</span>
            <StudioSelect v-model="parameters[group][field.key]" :label="`${groupNames[group]} · ${labels[field.key]}`" :disabled="disabled"
              :options="field.choices.map(value => ({value, label: choiceLabels[value] || value}))" />
          </div>
          <label v-else class="manga-field manga-number">
            <span>{{ labels[field.key] }}<output>{{ parameters[group][field.key] }}</output></span>
            <input v-model.number="parameters[group][field.key]" type="range" :min="field.min" :max="field.max" :step="field.integer ? 1 : 0.01"
              :disabled="disabled" :aria-label="`${groupNames[group]} · ${labels[field.key]}`" />
          </label>
        </template>
        <p v-if="group === 'panel'" class="manga-hint">选择固定画幅会裁切图片；裁切位置的 0 对应左侧或顶部，1 对应右侧或底部。边框与留白单位为像素。</p>
      </div>
    </details>
    <button class="btn btn-quiet btn-sm" type="button" :disabled="disabled" @click="emit('reset')"><ArchiveIcon name="refresh" />恢复初始参数</button>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { mangaManifest, type MangaOperation, type MangaParameters } from '@/api/mangaApi'
defineProps<{ disabled: boolean }>()
const operation = defineModel<MangaOperation>('operation', { required: true })
const parameters = defineModel<MangaParameters>('parameters', { required: true })
const emit = defineEmits<{ reset: [] }>()
const operations = [{value:'lite',label:'色阶 → 网点 → 纸张'}, {value:'comic',label:'网点 → 纸张'}, {value:'levels',label:'黑白色阶'}, {value:'finish',label:'仅网点与线条'}, {value:'panel',label:'仅画幅与纸张'}]
const descriptions = { lite:'先调整黑白色阶，再生成网点与线条，最后处理纸张；选择此项会关闭 Qwen 重绘。', comic:'直接整理网点与纸张，适合 Qwen 重绘或已有黑白稿。', levels:'仅调整灰度和明暗；选择此项会关闭模型步骤。', finish:'添加网点与边缘线条，可配合上方模型步骤。', panel:'调整裁切、墨色、边框和留白；选择此项会关闭模型步骤。' }
const groupNames = { levels:'黑白色阶', finish:'网点与线条', panel:'画幅与纸张' }
const groups = computed(() => mangaManifest.operations[operation.value] as (keyof MangaParameters)[])
const labels: Record<string,string> = { black:'黑场',white:'白场',gamma:'中间调',screen_lines:'网点线数',white_point:'网点白场',black_point:'网点黑场',light_tone:'亮部网点浓度',dark_tone:'暗部网点浓度',gradation:'网点渐变',pen_threshold:'边缘线条阈值',white_lines:'白线强度',frame:'画幅',crop_x:'横向裁切位置',crop_y:'纵向裁切位置',border:'边框',margin:'留白',paper:'纸色',ink:'墨色强度' }
const choiceLabels: Record<string,string> = { original:'保留完整构图', '4:3 wide':'横幅 4:3', '16:9 wide':'横幅 16:9', '3:4 tall':'竖幅 3:4', '1:1':'方形 1:1', white:'纯白', 'off-white':'米白', cream:'奶油色' }
function fields(group: keyof MangaParameters) {
  return Object.entries(mangaManifest.parameters[group]).map(([key, rule]) => ({ key, ...rule })) as
    { key: string; choices?: string[]; min?: number; max?: number; integer?: boolean }[]
}
</script>
