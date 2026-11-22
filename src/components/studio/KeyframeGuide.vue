<template>
  <fieldset ref="section" class="studio-keyframe-guide" tabindex="-1" :disabled="locked">
    <legend class="sr-only">点选创作</legend>
    <div class="studio-guide-modes" role="group" aria-label="创作方式">
      <button
        v-for="mode in modes"
        :key="mode.value"
        type="button"
        class="studio-guide-mode"
        :aria-pressed="guide.mode === mode.value"
        data-spring-button
        @click="tools.update({ mode: mode.value })"
      >
        <ArchiveIcon :name="mode.icon" />
        <span>{{ mode.label }}</span>
        <ArchiveIcon name="success" class="studio-guide-check" />
      </button>
    </div>
    <div class="studio-guide-selection">
      <StudioAssetThumb v-if="character" :version="character" />
      <div>
        <label :for="prefix + '-character'">角色</label>
        <StudioSelect
          :id="prefix + '-character'"
          :model-value="guide.characterVersionId"
          :options="characters"
          :disabled="locked || !characters.length"
          placeholder="选一张角色立绘"
          searchable
          @update:model-value="tools.update({ characterVersionId: String($event) })"
        />
      </div>
      <button v-if="!characters.length" type="button" class="btn btn-ghost btn-sm" :disabled="importing" @click="$emit('import', 'character')">
        导入角色立绘
      </button>
    </div>
    <template v-if="character && guide.mode === 'outfit'">
      <KeyframeTagChoices
        v-if="characterOutfits.length"
        label="角色衣柜"
        :tags="characterOutfits"
        :selected="guide.outfitIds"
        :limit="4"
        :disabled="locked"
        @toggle="toggle('outfitIds', $event)"
      />
      <div v-if="wardrobeError" class="studio-actions">
        <p class="studio-caption" role="status">{{ wardrobeError }}</p>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="wardrobeLoading" @click="tools.loadWardrobe">重读角色衣柜</button>
      </div>
      <KeyframeTagChoices label="通用衣柜" :tags="universal" :selected="guide.outfitIds" :limit="4" :disabled="locked" @toggle="toggle('outfitIds', $event)" />
      <details class="studio-guide-parts">
        <StudioDisclosureSummary>搭配服装部件</StudioDisclosureSummary>
        <div data-disclosure-content>
          <KeyframeTagChoices label="服装部件" :tags="clothingParts" :selected="guide.partIds" :limit="4" :disabled="locked" @toggle="toggle('partIds', $event)" />
        </div>
      </details>
    </template>
    <div v-if="character && (guide.mode === 'difference' || guide.mode === 'scene')" class="studio-guide-selection">
      <StudioAssetThumb v-if="look" :version="look" />
      <div>
        <label :for="prefix + '-look'">当前造型</label>
        <StudioSelect
          :id="prefix + '-look'"
          :model-value="guide.lookVersionId"
          :options="looks"
          :disabled="locked"
          searchable
          @update:model-value="tools.update({ lookVersionId: String($event) })"
        />
      </div>
    </div>
    <template v-if="character && guide.mode === 'difference'">
      <div class="studio-segments studio-segments--compact" role="group" aria-label="差分类型">
        <AnimatedSelection />
        <button type="button" :aria-pressed="guide.difference === 'expression'" @click="setDifference('expression')">表情</button>
        <button type="button" :aria-pressed="guide.difference === 'pose'" @click="setDifference('pose')">动作</button>
      </div>
      <KeyframeTagChoices :label="guide.difference === 'expression' ? '表情' : '动作'" :tags="differences"
        :selected="guide.differenceIds" :limit="4" :disabled="locked" @toggle="toggle('differenceIds', $event)" />
    </template>
    <template v-if="character && guide.mode === 'scene'">
      <div class="studio-guide-selection">
        <div>
          <label :for="prefix + '-scene'">场景</label>
          <StudioSelect :id="prefix + '-scene'" :model-value="guide.scene" :groups="sceneGroups" :disabled="locked"
            placeholder="选场景预设或项目空镜" searchable @update:model-value="tools.update({ scene: String($event) })" />
        </div>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="importing" @click="$emit('import', 'scene')">导入空镜</button>
      </div>
      <KeyframeTagChoices label="构图与氛围" :tags="framingTags" :selected="guide.framingIds" :limit="4" :disabled="locked" @toggle="toggle('framingIds', $event)" />
    </template>
    <div v-if="character && guide.mode === 'neutral' && anchor" class="studio-guide-selection">
      <StudioAssetThumb :version="anchor" />
      <button type="button" class="btn btn-ghost btn-sm" @click="tools.update({ mode: 'outfit' })">开始换装</button>
    </div>
  </fieldset>
</template>

<script setup lang="ts">
import { ref, useId } from 'vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioAssetThumb from './StudioAssetThumb.vue'
import KeyframeTagChoices from './KeyframeTagChoices.vue'
import { clothingParts, framingTags } from './keyframePresets'
import type { KeyframeGuideDraft } from './keyframeDraft'
import type { useGuidedKeyframes } from './useGuidedKeyframes'

const props = defineProps<{
  tools: ReturnType<typeof useGuidedKeyframes>
  locked: boolean
  importing: boolean
}>()
defineEmits<{ import: [kind: 'character' | 'scene'] }>()
const { guide, characters, character, anchor, looks, look, sceneGroups, differences, universal, characterOutfits, wardrobeLoading, wardrobeError } = props.tools
const prefix = useId()
const section = ref<HTMLFieldSetElement>()
const modes = [
  { value: 'outfit', label: '换装', icon: 'wardrobe' },
  { value: 'difference', label: '表情 / 动作', icon: 'happy' },
  { value: 'scene', label: '拍场景套图', icon: 'scene' },
  { value: 'neutral', label: '整理立绘', icon: 'broom' },
] as const

function setDifference(difference: KeyframeGuideDraft['difference']) {
  if (difference !== guide.value.difference) props.tools.update({ difference, differenceIds: [] })
}
function toggle(key: 'outfitIds' | 'partIds' | 'differenceIds' | 'framingIds', id: string) {
  const current = guide.value[key]
  if (current.includes(id)) props.tools.update({ [key]: current.filter(choice => choice !== id) })
  else if (current.length < 4) props.tools.update({ [key]: [...current, id] })
}
defineExpose({ focus: () => section.value?.focus() })
</script>
