<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'

withDefaults(defineProps<{
  label: string
  tabs: readonly { id: string; label: string; count?: number }[]
  stacked?: boolean
  idPrefix?: string
  as?: 'div' | 'aside' | 'section'
  listClass?: string
  contentClass?: string
  panelClass?: string
}>(), { stacked:false, as:'div' })
const selected = defineModel<string>({ required:true })
const generatedId = useId()
const scrollArea = ref<HTMLElement | null>(null)
watch(selected, async () => { await nextTick(); if (scrollArea.value) scrollArea.value.scrollTop = 0 })
</script>

<template>
  <TabsRoot v-model="selected" :as="as" :unmount-on-hide="false" class="studio-tabs-root tw:min-w-0">
    <slot name="heading" />
    <TabsList v-show="!stacked" :aria-label="label" class="studio-tabs-list tw:relative tw:isolate tw:flex tw:gap-s-1 tw:p-s-1 tw:mt-0 tw:mx-s-3 tw:mb-s-3 tw:border tw:border-solid tw:border-soft tw:rounded-lg tw:bg-base" :class="listClass">
      <AnimatedSelection target="[aria-selected='true']" />
      <TabsTrigger v-for="tab in tabs" :key="tab.id" :value="tab.id" as-child>
      <button type="button"
        :id="`${idPrefix || generatedId}-tab-${tab.id}`" :aria-controls="`${idPrefix || generatedId}-${tab.id}`"
        class="studio-tabs-trigger tw:relative tw:[z-index:var(--z-raised)] tw:flex tw:justify-center tw:items-center tw:flex-1 tw:gap-s-1 tw:min-w-0 tw:min-h-[40px] tw:p-s-2 tw:border tw:border-solid tw:border-transparent tw:rounded-md tw:bg-transparent tw:text-secondary tw:[font:600_var(--fs-label)/var(--lh-label)_var(--font-sans)] tw:cursor-pointer">
        {{ tab.label }}<span v-if="tab.count" class="studio-tabs-count tw:min-w-[18px] tw:py-0 tw:px-s-1 tw:rounded-pill tw:bg-accent-soft tw:text-accent tw:text-label-xs">{{ tab.count }}</span>
      </button>
      </TabsTrigger>
    </TabsList>
    <div ref="scrollArea" class="studio-tabs-panels tw:min-h-0 tw:min-w-0" :class="contentClass">
      <TabsContent v-for="tab in tabs" :key="tab.id" :value="tab.id" force-mount as-child>
      <section
        v-show="stacked || selected === tab.id" v-content-motion="!stacked && selected === tab.id" :id="`${idPrefix || generatedId}-${tab.id}`"
        :data-panel="tab.id" :class="panelClass" :role="stacked ? 'region' : 'tabpanel'"
        :aria-labelledby="stacked ? undefined : `${idPrefix || generatedId}-tab-${tab.id}`"
        :aria-label="stacked ? tab.label : undefined" :tabindex="stacked ? undefined : 0">
        <slot :name="tab.id" :active="selected === tab.id" />
      </section>
      </TabsContent>
    </div>
  </TabsRoot>
</template>

<style>
.studio-tabs-trigger:hover { background:var(--bg-hover); color:var(--text-primary); }
.studio-tabs-trigger[data-state='active'] { color:var(--accent); }
.studio-tabs-trigger:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
@media(max-width:600px) { .studio-tabs-trigger { min-height:44px; } }
@media(forced-colors:active) { .studio-tabs-trigger[data-state='active'] { border-color:Highlight; color:Highlight; } }
</style>
