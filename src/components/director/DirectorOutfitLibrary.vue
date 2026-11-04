<template>
  <div class="character-wardrobe">
    <div class="wardrobe-filters">
      <label :for="typeId">类型</label>
      <StudioSelect :id="typeId" v-model="type" label="服装类型" :options="OUTFIT_TYPE_OPTIONS" size="sm" />
      <label :for="sourceId">来源</label>
      <StudioSelect :id="sourceId" v-model="source" label="服装来源" :options="OUTFIT_SOURCE_OPTIONS" size="sm" />
    </div>
    <div ref="results" class="wardrobe-results">
      <p class="wardrobe-description">套装一键装配，词条单独添加；类型按名称和词条归类，可重叠。<template v-if="!canApply">角色套装需先选择单个角色。</template></p>
      <p v-if="pb.outfitOverride?.label" class="wardrobe-description" role="status">已换装：{{ pb.outfitOverride.label }}</p>
      <div v-if="visible.length" class="outfit-preset-list">
        <div v-for="group in visible" :key="group.id" class="wardrobe-entry">
          <StudioTooltip
            :content="group.item.kind === 'tag' ? tagDescription(group.item.tag) : group.item.kind === 'catalog' ? group.item.sourceName + ' · 角色套装' : group.item.description"
            :anchor="group.item.kind === 'catalog' && !canApply">
            <button type="button" class="outfit-preset" :class="{ selected: isSelected(group.item) }"
              :aria-pressed="isSelected(group.item)" :disabled="group.item.kind === 'catalog' && !canApply" @click="select(group.item)">
              <ArchiveIcon name="success" class="tag-option-check" />
              <strong>{{ group.item.kind === 'tag' ? tagMeaning(group.item.tag.en, group.item.tag.cn) : group.item.name }}</strong>
              <small v-if="group.item.kind === 'tag'">词条 · {{ displayTag(group.item.tag.en) }}</small>
              <small v-else>{{ group.item.kind === 'catalog' ? group.item.sourceName + ' · 角色套装' : group.item.sourceName }}</small>
            </button>
          </StudioTooltip>
          <StudioPopover v-if="group.variants.length > 1" :open="openSources === group.id"
            :label="group.item.name + ' · 选择来源'" @update:open="openSources = $event ? group.id : null">
            <template #trigger>
              <button class="btn btn-quiet btn-sm wardrobe-sources-toggle" type="button" :aria-label="'查看 ' + group.item.name + ' 的 ' + group.variants.length + ' 条来源记录'">
                {{ group.variants.length }} 条来源记录 <ArchiveIcon name="chevron-down" />
              </button>
            </template>
            <div class="wardrobe-source-list">
              <strong>内容相同 · 选择来源</strong>
              <button v-for="variant in group.variants" :key="variant.id" class="wardrobe-source-option" type="button" data-control-motion
                :disabled="!canApply" :aria-pressed="pb.outfitOverride?.presetId === variant.id"
                @click="select(variant); openSources = null">
                <span><strong>{{ variant.sourceName }}</strong><small>{{ variant.name }}</small></span>
                <ArchiveIcon v-if="pb.outfitOverride?.presetId === variant.id" name="success" />
              </button>
            </div>
          </StudioPopover>
        </div>
      </div>
      <p v-else class="wardrobe-description" role="status">没有找到匹配的服装，请调整关键词或筛选条件。</p>
      <div v-if="matched.length > visible.length" :key="visible.length" ref="loadSentinel" class="workbench-load-sentinel" aria-hidden="true"></div>
      <div v-if="matched.length" class="wardrobe-more">
        <span>已显示 {{ visible.length }} / {{ matched.length }} 项</span>
        <button v-if="matched.length > 48" class="btn btn-quiet btn-sm" type="button"
          :aria-disabled="matched.length <= visible.length" @click="limit += matched.length > visible.length ? 48 : 0">{{ matched.length > visible.length ? '显示更多' : '已显示全部' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, toRef, useId, watch } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import { OUTFIT_SOURCE_OPTIONS, OUTFIT_TYPE_OPTIONS, useOutfitPresetLibrary } from '@/composables/prompt/useOutfitPresetLibrary'
import type { PromptTagSource } from '@/utils/promptTagDictionary'

const props = defineProps<{
  search: string
  tags: readonly PromptTagSource[]
  tagMeaning: (tag: string, label?: string) => string
  tagDescription: (tag: PromptTagSource) => string
  displayTag: (tag: string) => string
}>()
const search = toRef(props, 'search')
const { pb, limit, type, source, canApply, matched, visible, isSelected, select } = useOutfitPresetLibrary(search, toRef(props, 'tags'), props.tagMeaning)
const typeId = useId(), sourceId = useId(), results = ref<HTMLElement | null>(null), loadSentinel = ref<HTMLElement | null>(null)
const openSources = ref<string | null>(null)
watch([search, type, source], () => { openSources.value = null; if (results.value) results.value.scrollTop = 0 })
useIntersectionObserver(loadSentinel, entries => {
  if (entries.some(entry => entry.target === loadSentinel.value && entry.isIntersecting) && visible.value.length < matched.value.length) limit.value += 48
}, { rootMargin: '160px 0px' })
</script>
