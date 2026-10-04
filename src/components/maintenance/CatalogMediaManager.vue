<template>
  <section aria-label="图片维护">
    <template v-if="record && ['scene', 'blueprint'].includes(record.kind)">
      <h3>{{ recordTitle(record) }} · 样张</h3>
      <RuntimeImage :src="showcaseUrl" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" class="catalog-media-preview" :alt="record.id" @error="onShowcaseMissing" /></RuntimeImage>
      <button class="btn btn-ghost" type="button" :disabled="uploadBusy" @click="pickShowcase">上传 / 替换样张</button>
      <input ref="showcaseFileEl" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="onShowcasePicked" />
    </template>
    <h3>首页主视觉</h3>
    <div class="catalog-actions"><button v-for="hero in homeHeroes" :key="hero.id" class="btn btn-ghost" :aria-pressed="selectedHeroId === hero.id" type="button" @click="previewHero(hero)">{{ hero.title }}</button></div>
    <template v-if="selectedHeroId">
      <RuntimeImage :src="heroUrl" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" class="catalog-media-preview" :alt="selectedHeroTitle" /></RuntimeImage>
      <div class="catalog-actions"><button class="btn btn-ghost" type="button" :disabled="uploadBusy" @click="pickHero">上传 / 替换</button><button class="btn btn-ghost" type="button" :disabled="uploadBusy" @click="resetHero">恢复内置图</button></div>
      <input ref="heroFileEl" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="onHeroPicked" />
    </template>
    <p role="status" aria-live="polite" :class="{ 'catalog-error': showcaseError }">{{ showcaseFeedback }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, watch } from 'vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import { useSceneShowcaseUpload } from '@/composables/scene/useSceneShowcaseUpload'
import type { CatalogRecord } from '@/api/catalogApi'
import { recordTitle } from '@/composables/scene/catalogPresentation'
import type { SceneDraft } from '@/types/api'
import type { SceneBlueprint } from '@/types/sceneBlueprint'
const props = defineProps<{ record: CatalogRecord | null }>()
const scenes = computed(() => props.record?.kind === 'scene' ? [props.record.data as SceneDraft] : [])
const blueprints = computed(() => props.record?.kind === 'blueprint' ? [props.record.data as unknown as SceneBlueprint] : [])
const { showcaseUrl, onShowcaseMissing, uploadBusy, pickShowcase, showcaseFileEl, onShowcasePicked, homeHeroes, selectedHeroId, selectedHeroTitle, previewHero, heroUrl, pickHero, resetHero, heroFileEl, onHeroPicked, showcaseFeedback, showcaseError, previewImage } = useSceneShowcaseUpload({ scenes, blueprints, errorMessage: (e, fallback) => e instanceof Error ? e.message : fallback })
watch(() => props.record?.id, () => {
  const r = props.record
  if (r && ['scene', 'blueprint'].includes(r.kind)) previewImage({ id: r.id, title: String((r.data as Record<string, unknown>).title ?? r.id), char: String((r.data as Record<string, unknown>).char ?? (r.data as Record<string, unknown>).characterId ?? ''), type: r.kind === 'scene' ? 'scene' : 'popular' })
}, { immediate: true })
</script>
