<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'

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
  <TabsRoot v-model="selected" :as="as" :unmount-on-hide="false" class="studio-tabs-root">
    <slot name="heading" />
    <TabsList v-show="!stacked" :aria-label="label" class="studio-tabs-list" :class="listClass">
      <TabsTrigger v-for="tab in tabs" :key="tab.id" :value="tab.id" as-child>
      <button type="button"
        :id="`${idPrefix || generatedId}-tab-${tab.id}`" :aria-controls="`${idPrefix || generatedId}-${tab.id}`"
        class="studio-tabs-trigger">
        {{ tab.label }}<span v-if="tab.count" class="studio-tabs-count">{{ tab.count }}</span>
      </button>
      </TabsTrigger>
    </TabsList>
    <div ref="scrollArea" class="studio-tabs-panels" :class="contentClass">
      <TabsContent v-for="tab in tabs" :key="tab.id" :value="tab.id" force-mount as-child>
      <section
        v-show="stacked || selected === tab.id" :id="`${idPrefix || generatedId}-${tab.id}`"
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
.studio-tabs-root { min-width:0; }
.studio-tabs-list { display:flex; gap:var(--s-1); padding:var(--s-1); margin:0 var(--s-3) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.studio-tabs-trigger { display:flex; justify-content:center; align-items:center; flex:1; gap:var(--s-1); min-width:0; min-height:40px; padding:var(--s-2); border:1px solid transparent; border-radius:var(--r-md); background:transparent; color:var(--text-secondary); font:600 var(--fs-label)/var(--lh-label) var(--font-sans); cursor:pointer; }
.studio-tabs-trigger:hover { background:var(--bg-hover); color:var(--text-primary); }
.studio-tabs-trigger[data-state='active'] { border-color:var(--border-soft); background:var(--bg-surface); color:var(--accent); box-shadow:var(--shadow-sm); }
.studio-tabs-trigger:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.studio-tabs-count { min-width:18px; padding:0 var(--s-1); border-radius:var(--r-pill); background:var(--accent-soft); color:var(--accent); font-size:var(--fs-label-xs); }
.studio-tabs-panels { min-height:0; min-width:0; }
@media(max-width:600px) { .studio-tabs-trigger { min-height:44px; } }
@media(forced-colors:active) { .studio-tabs-trigger[data-state='active'] { border-color:Highlight; color:Highlight; } }
</style>
