<template>
  <section class="catalog-media" aria-label="样张与封面">
    <div class="catalog-media-tabs tw:p-s-1 tw:rounded-pill" data-fluid-glass>
      <div class="studio-segments studio-segments--compact" role="group" aria-label="图片用途"><AnimatedSelection />
      <button type="button" :aria-pressed="mode === 'samples'" @click="mode = 'samples'"><ArchiveIcon name="gallery" />场景样张</button>
      <button type="button" :aria-pressed="mode === 'covers'" @click="mode = 'covers'"><ArchiveIcon name="image" />首页封面</button>
      </div>
      <button v-if="mode === 'samples'" class="btn btn-ghost btn-sm catalog-media-refresh" type="button" :disabled="loading || manifestLoading" @click="refresh"><ArchiveIcon name="refresh" />刷新图片</button>
    </div>
    <div v-content-motion:up="mode">
    <template v-if="mode === 'samples'">
      <div class="catalog-media-filters">
        <StudioSearch v-model="search" label="搜索样张" placeholder="搜索场景、蓝图或角色…" />
        <StudioSelect v-model="kind" label="内容类型" :options="[{ value: 'media', label: '全部场景与蓝图' }, { value: 'scene', label: '场景故事' }, { value: 'blueprint', label: '角色蓝图' }]" />
        <StudioSelect v-model="character" label="样张所属角色" :options="[{ value: '', label: '全部角色' }, ...(result?.facets.characters ?? []).map(id => ({ value: id, label: characterNames[id] || id }))]" />
        <StudioSelect v-model="rating" label="样张适用范围" :options="[{ value: '', label: '全部内容' }, { value: 'All', label: '全年龄' }, { value: 'R15', label: '十五岁以上' }, { value: 'R18', label: '成人内容' }]" />
      </div>
      <label class="catalog-media-sensitive-switch"><input v-model="showAdultImages" type="checkbox" />揭示 R18 缩略图遮罩</label>
      <div class="catalog-media-workspace">
        <section ref="mediaLibrary" v-content-motion:fade="listScope" class="catalog-media-library" tabindex="-1" aria-label="样张列表" :aria-busy="loading || manifestLoading">
          <p class="catalog-media-count" role="status">{{ loading ? '正在读取内容…' : (result?.total ?? 0) + ' 个场景与蓝图' }}</p>
          <ArchiveStatePanel v-if="error || manifestError" compact kind="error" title="图片资料暂时没能读出来" :message="error || manifestError"><button class="btn btn-ghost btn-sm" type="button" @click="refresh">再试一次</button></ArchiveStatePanel>
          <ArchiveStatePanel v-if="!result && loading" compact kind="loading" class="catalog-media-loading" title="正在展开样张目录…" />
          <div v-if="result?.items.length" ref="sampleGrid" class="catalog-media-grid">
            <button v-for="item in result.items" :key="item.kind + ':' + item.id" class="catalog-sample-card" type="button" :disabled="loading || !!error" :aria-pressed="selectedImageId === showcaseItem(item).id" :aria-label="'查看样张：' + item.title" @click="selectSample(item)">
              <span class="catalog-sample-image">
                <RuntimeImage v-if="thumbUrl(showcaseItem(item).id)" :src="thumbUrl(showcaseItem(item).id)" v-slot="{ image, loaded, failed }"><img v-if="image.src && !failed" v-bind="image" loading="lazy" alt="" class="catalog-media-image" :class="{ 'is-ready': loaded, 'is-mature': item.rating === 'R18' && !showAdultImages }" /><span v-if="!loaded" class="catalog-sample-empty"><ArchiveIcon name="image" />{{ failed ? '图片暂不可用' : '读取图片…' }}</span></RuntimeImage>
                <span v-else class="catalog-sample-empty"><ArchiveIcon name="image" />{{ manifestLoading ? '读取图片…' : '待补样张' }}</span>
              </span>
              <span class="catalog-sample-copy"><strong>{{ item.title }}</strong><small>{{ characterNames[item.characterId] || '未命名角色' }} · {{ item.kind === 'blueprint' ? '蓝图' : '故事' }}</small></span>
            </button>
          </div>
          <ArchiveStatePanel v-if="!loading && !error && !result?.items.length" compact kind="empty" title="没有匹配的内容" />
          <StudioPagination v-model="page" :pages="totalPages" :disabled="loading" label="样张分页" />
        </section>
        <section ref="previewPane" v-content-motion:fade="selectedImageId" class="catalog-media-detail" aria-label="当前样张">
          <template v-if="selectedImageId">
            <p class="catalog-media-eyebrow">{{ selectedSample?.type === 'popular' ? '角色蓝图' : '场景故事' }} · {{ characterNames[selectedSample?.char ?? ''] || '未命名角色' }}</p>
            <h3>{{ selectedImageTitle }}</h3>
            <div class="catalog-actions"><button class="btn btn-primary" type="button" :disabled="uploadBusy || manifestLoading || !!manifestError" @click="pickShowcase"><ArchiveIcon name="upload" />{{ uploadBusy ? '正在保存图片…' : hasShowcase(selectedImageId) ? '替换这张样张' : '上传第一张样张' }}</button></div>
            <div class="catalog-media-canvas"><RuntimeImage v-if="showcaseUrl" :src="showcaseUrl" v-slot="{ image, loaded, failed }" @error="onShowcaseMissing"><img v-if="image.src && !failed" v-bind="image" :alt="selectedImageTitle" class="catalog-media-image" :class="{ 'is-ready': loaded }" /><span v-if="!loaded" role="status">{{ failed ? '图片暂不可用，可以重新上传' : '正在展开画面…' }}</span></RuntimeImage><span v-else>{{ manifestLoading ? '正在读取样张…' : '还没有样张，选一张图为它补上。' }}</span></div>
            <p class="catalog-note">PNG / JPEG / WebP · ≤15 MB · 自动保存 · 旧图备份</p>
          </template>
          <div v-else class="catalog-media-empty"><ArchiveIcon name="gallery" /><h3>选择样张</h3></div>
          <input ref="showcaseFileEl" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="onShowcasePicked" />
        </section>
      </div>
    </template>
    <template v-else>
      <header class="catalog-media-intro"><h2>首页封面</h2></header>
      <div class="catalog-hero-grid"><button v-for="hero in homeHeroes" :key="hero.id" class="catalog-hero-card" type="button" :aria-pressed="selectedHeroId === hero.id" @click="previewHero(hero)"><span class="catalog-hero-art"><RuntimeImage :src="hero.image" v-slot="{ image, loaded, failed }"><img v-if="image.src && !failed" v-bind="image" :alt="hero.title + '的首页封面'" class="catalog-media-image" :class="{ 'is-ready': loaded }" /><ArchiveIcon v-if="!loaded" name="image" /></RuntimeImage></span><span class="catalog-hero-copy"><strong>{{ hero.title }}</strong><small>{{ hero.updatedAt ? '自定义封面 · ' + hero.updatedAt : '使用内置封面' }}</small></span></button></div>
      <section v-if="selectedHeroId" v-content-motion:fade="selectedHeroId" class="catalog-hero-editor"><div class="catalog-media-canvas"><RuntimeImage :src="heroUrl" v-slot="{ image, loaded, failed }"><img v-if="image.src && !failed" v-bind="image" :alt="selectedHeroTitle + '的首页封面预览'" class="catalog-media-image" :class="{ 'is-ready': loaded }" /><span v-if="!loaded" role="status">{{ failed ? '封面暂不可用，可以重新选择或替换' : '正在展开封面…' }}</span></RuntimeImage></div><div><h3>{{ selectedHeroTitle }}的首页封面</h3><div class="catalog-actions"><button class="btn btn-primary" type="button" :disabled="uploadBusy" @click="pickHero">{{ uploadBusy ? '正在保存图片…' : '替换封面' }}</button><button class="btn btn-ghost" type="button" :disabled="uploadBusy" @click="resetHero">恢复内置图</button></div></div></section>
      <input ref="heroFileEl" hidden type="file" accept="image/png,image/jpeg,image/webp" @change="onHeroPicked" />
    </template>
    </div>
    <p class="catalog-media-feedback" role="status" aria-live="polite" :class="{ 'catalog-error': showcaseError }">{{ showcaseFeedback }}</p>
  </section>
</template>
<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioPagination from '@/components/ui/StudioPagination.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { useSceneShowcaseUpload, type ShowcaseSceneItem } from '@/composables/scene/useSceneShowcaseUpload'
import { useCatalogMedia, showcaseItem } from '@/composables/scene/useCatalogMedia'
import type { CatalogRecord, CatalogSummary } from '@/api/catalogApi'
import { recordTitle } from '@/composables/scene/catalogPresentation'
import { scrollBehavior } from '@/utils/motionPreference'
import '@/assets/css/catalog-media.css'
const props = defineProps<{ record: CatalogRecord | null; characterNames: Record<string, string> }>()
const mode = ref<'samples' | 'covers'>('samples'), previewPane = ref<HTMLElement | null>(null), selectedSample = ref<ShowcaseSceneItem | null>(null)
const mediaLibrary = ref<HTMLElement | null>(null), sampleGrid = ref<HTMLElement | null>(null)
const showAdultImages = ref(false)
const { kind, search, character, rating, page, result, listScope, loading, error, totalPages, load } = useCatalogMedia()
watch(listScope, () => { if (sampleGrid.value) sampleGrid.value.scrollTop = 0 }, { flush: 'post' })
const { showcaseUrl, onShowcaseMissing, uploadBusy, pickShowcase, showcaseFileEl, onShowcasePicked, homeHeroes, selectedHeroId, selectedHeroTitle, previewHero, heroUrl, pickHero, resetHero, heroFileEl, onHeroPicked, showcaseFeedback, showcaseError, previewImage, selectedImageId, selectedImageTitle, thumbUrl, hasShowcase, manifestLoading, manifestError, loadShowcaseManifest } = useSceneShowcaseUpload({ mode: () => mode.value, errorMessage: (e, fallback) => e instanceof Error ? e.message : fallback })
async function selectSample(item: CatalogSummary) {
  const selected = showcaseItem(item)
  selectedSample.value = selected; previewImage(selected)
  await nextTick()
  if (window.innerWidth < 1100 && mode.value === 'samples' && selectedImageId.value === selected.id && previewPane.value?.isConnected) previewPane.value.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
}
function refresh() {
  if (mediaLibrary.value?.contains(document.activeElement)) mediaLibrary.value.focus({ preventScroll: true })
  void load(); void loadShowcaseManifest().catch(() => {})
}
onMounted(() => {
  const record = props.record
  if (record && ['scene', 'blueprint'].includes(record.kind)) {
    const data = record.data as Record<string, unknown>
    const item = showcaseItem({ ...record, title: recordTitle(record), characterId: String(data.char || data.characterId || ''), rating: String(data.rating || (data.adult ? 'R18' : 'All')) })
    selectedSample.value = item; previewImage(item)
  }
})
</script>
