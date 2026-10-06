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
      <label v-if="adultEnabled" class="catalog-media-sensitive-switch"><input v-model="showAdultImages" type="checkbox" />查看成人样张</label>
      <div class="catalog-media-workspace">
        <section v-content-motion:up="loading ? false : page" class="catalog-media-library" aria-label="样张列表" :aria-busy="loading || manifestLoading">
          <p class="catalog-media-count" role="status">{{ loading ? '正在读取内容…' : (result?.total ?? 0) + ' 个场景与蓝图' }}</p>
          <ArchiveStatePanel v-if="error || manifestError" compact kind="error" title="图片资料暂时没能读出来" :message="error || manifestError"><button class="btn btn-ghost btn-sm" type="button" @click="refresh">再试一次</button></ArchiveStatePanel>
          <div v-else-if="!loading" class="catalog-media-grid">
            <button v-for="item in result?.items ?? []" :key="item.kind + ':' + item.id" class="catalog-sample-card" type="button" :aria-pressed="selectedImageId === showcaseItem(item).id" :aria-label="'查看样张：' + item.title" @click="selectSample(item)">
              <span class="catalog-sample-image">
                <RuntimeImage v-if="thumbUrl(showcaseItem(item).id)" :src="thumbUrl(showcaseItem(item).id)" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" loading="lazy" alt="" :class="{ 'is-mature': item.rating === 'R18' && !(adultEnabled && showAdultImages) }" /><span v-else class="catalog-sample-empty"><ArchiveIcon name="image" />图片暂不可用</span></RuntimeImage>
                <span v-else class="catalog-sample-empty"><ArchiveIcon name="image" />{{ manifestLoading ? '读取图片…' : '待补样张' }}</span>
              </span>
              <span class="catalog-sample-copy"><strong>{{ item.title }}</strong><small>{{ characterNames[item.characterId] || '未命名角色' }} · {{ item.kind === 'blueprint' ? '蓝图' : '故事' }}</small></span>
            </button>
          </div>
          <ArchiveStatePanel v-if="!loading && !error && !result?.items.length" compact kind="empty" title="没有找到匹配的内容" message="换一个关键词或清除筛选试试。" />
          <nav class="catalog-pagination" aria-label="样张分页"><button class="btn btn-ghost btn-sm" type="button" :disabled="loading || page <= 1" @click="page--">上一页</button><span role="status">{{ result?.page ?? page }} / {{ totalPages }}</span><button class="btn btn-ghost btn-sm" type="button" :disabled="loading || page >= totalPages" @click="page++">下一页</button></nav>
        </section>
        <section ref="previewPane" v-content-motion:fade="selectedImageId" class="catalog-media-detail" aria-label="当前样张">
          <template v-if="selectedImageId">
            <p class="catalog-media-eyebrow">{{ selectedSample?.type === 'popular' ? '角色蓝图' : '场景故事' }} · {{ characterNames[selectedSample?.char ?? ''] || '未命名角色' }}</p>
            <h3>{{ selectedImageTitle }}</h3>
            <div class="catalog-actions"><button class="btn btn-primary" type="button" :disabled="uploadBusy || manifestLoading || !!manifestError" @click="pickShowcase"><ArchiveIcon name="upload" />{{ uploadBusy ? '正在保存图片…' : hasShowcase(selectedImageId) ? '替换这张样张' : '上传第一张样张' }}</button></div>
            <div class="catalog-media-canvas"><RuntimeImage v-if="showcaseUrl" :src="showcaseUrl" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" :alt="selectedImageTitle" :class="{ 'is-mature': selectedSample?.rating === 'R18' && !(adultEnabled && showAdultImages) }" @error="onShowcaseMissing" /><span v-else>图片暂不可用，可以重新上传</span></RuntimeImage><span v-else>{{ manifestLoading ? '正在读取样张…' : '还没有样张，选一张图为它补上。' }}</span></div>
            <p class="catalog-note">选择图片后自动保存，支持 PNG、JPEG、WebP，最大 15 MB。原图和缩略图一起更新，旧图自动备份。</p>
          </template>
          <div v-else class="catalog-media-empty"><ArchiveIcon name="gallery" /><h3>选一张样张，看看它的故事</h3><p>从左边选择内容，就能预览或补上图片。</p></div>
          <input ref="showcaseFileEl" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="onShowcasePicked" />
        </section>
      </div>
    </template>
    <template v-else>
      <header class="catalog-media-intro"><div><h2>首页的第一眼</h2><p>宁宁和夏目的首页封面可以分别更换，随时恢复内置图。</p></div></header>
      <div class="catalog-hero-grid"><button v-for="hero in homeHeroes" :key="hero.id" class="catalog-hero-card" type="button" :aria-pressed="selectedHeroId === hero.id" @click="previewHero(hero)"><RuntimeImage :src="hero.image" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" :alt="hero.title + '的首页封面'" /><ArchiveIcon v-else name="image" /></RuntimeImage><span><strong>{{ hero.title }}</strong><small>{{ hero.updatedAt ? '自定义封面 · ' + hero.updatedAt : '使用内置封面' }}</small></span></button></div>
      <section v-if="selectedHeroId" v-content-motion:fade="selectedHeroId" class="catalog-hero-editor"><div class="catalog-media-canvas"><RuntimeImage :src="heroUrl" v-slot="{ image, failed }"><img v-if="image.src && !failed" v-bind="image" :alt="selectedHeroTitle + '的首页封面预览'" /></RuntimeImage></div><div><h3>{{ selectedHeroTitle }}的首页封面</h3><p class="catalog-note">更换后首页即可使用这张图，角色立绘和场景样张分别维护。</p><div class="catalog-actions"><button class="btn btn-primary" type="button" :disabled="uploadBusy" @click="pickHero">{{ uploadBusy ? '正在保存图片…' : '替换封面' }}</button><button class="btn btn-ghost" type="button" :disabled="uploadBusy" @click="resetHero">恢复内置图</button></div></div></section>
      <input ref="heroFileEl" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="onHeroPicked" />
    </template>
    </div>
    <p class="catalog-media-feedback" role="status" aria-live="polite" :class="{ 'catalog-error': showcaseError }">{{ showcaseFeedback }}</p>
  </section>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { useSceneShowcaseUpload, type ShowcaseSceneItem } from '@/composables/scene/useSceneShowcaseUpload'
import { useCatalogMedia, showcaseItem } from '@/composables/scene/useCatalogMedia'
import type { CatalogRecord, CatalogSummary } from '@/api/catalogApi'
import { recordTitle } from '@/composables/scene/catalogPresentation'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import '@/assets/css/catalog-media.css'
const props = defineProps<{ record: CatalogRecord | null; characterNames: Record<string, string> }>()
const mode = ref<'samples' | 'covers'>('samples'), previewPane = ref<HTMLElement | null>(null), selectedSample = ref<ShowcaseSceneItem | null>(null)
const adultEnabled = isLocalStudioHost(), showAdultImages = ref(false)
const { kind, search, character, rating, page, result, loading, error, totalPages, load } = useCatalogMedia()
const { showcaseUrl, onShowcaseMissing, uploadBusy, pickShowcase, showcaseFileEl, onShowcasePicked, homeHeroes, selectedHeroId, selectedHeroTitle, previewHero, heroUrl, pickHero, resetHero, heroFileEl, onHeroPicked, showcaseFeedback, showcaseError, previewImage, selectedImageId, selectedImageTitle, thumbUrl, hasShowcase, manifestLoading, manifestError, loadShowcaseManifest } = useSceneShowcaseUpload({ errorMessage: (e, fallback) => e instanceof Error ? e.message : fallback })
function selectSample(item: CatalogSummary) { selectedSample.value = showcaseItem(item); previewImage(selectedSample.value); if (window.innerWidth < 1100) previewPane.value?.scrollIntoView({ block: 'nearest' }) }
function refresh() { void load(); void loadShowcaseManifest().catch(() => {}) }
onMounted(() => {
  const record = props.record
  if (record && ['scene', 'blueprint'].includes(record.kind)) {
    const data = record.data as Record<string, unknown>
    const item = showcaseItem({ ...record, title: recordTitle(record), characterId: String(data.char || data.characterId || ''), rating: String(data.rating || (data.adult ? 'R18' : 'All')) })
    selectedSample.value = item; previewImage(item)
  }
})
</script>
