<template>
  <article class="page showcase-page">
    <header class="showcase-heading" data-route-arrive>
      <div class="heading-copy tw:min-w-0">
        <div class="heading-title"><h1 data-screentone-furniture>参考画册</h1><span class="collection-count"><strong>{{ manifestLoading && !entries.length ? '—' : entries.length }}</strong> 幅</span></div>
      </div>
      <div class="hero-actions tw:flex tw:gap-s-2 tw:flex-wrap"><button class="btn btn-primary" type="button" :disabled="manifestLoading || !filtered.length" @click="openRandom"><ArchiveIcon name="spark" /> 随机样张</button><RouterLink to="/scene-explorer" class="btn btn-ghost"><ArchiveIcon name="scene" />场景画廊</RouterLink><button class="btn btn-ghost showcase-refresh" type="button" :disabled="manifestLoading" :aria-label="manifestLoading ? '正在读取画册' : '刷新画册'" @click="loadManifest(true)"><ArchiveIcon name="refresh" /></button></div>
    </header>

    <div class="browse-toolbar showcase-toolbar" aria-label="样张筛选" data-reveal>
      <div class="search-row tw:flex tw:items-center tw:gap-s-3 tw:flex-wrap">
        <div class="showcase-browse-modes studio-segments" role="group" aria-label="画册浏览方式"><AnimatedSelection /><button class="filter-pill" type="button" :class="{ active: !albumsOpen }" :aria-pressed="!albumsOpen" @click="showImages">{{ !selectedAlbum && typeFilter === 'all' ? '全部样张' : '画册样张' }}</button><button class="filter-pill" type="button" :class="{ active: albumsOpen }" :aria-pressed="albumsOpen" @click="showAlbums"><ArchiveIcon name="book" />按画册 <span>{{ albums.length }}</span></button></div>
        <StudioSearch v-show="!albumsOpen" ref="searchInput" v-model="searchQuery" class="search-field" id="showcaseSearch" label="搜索画册" placeholder="搜索样张、角色或场景…" />
        <div v-show="!albumsOpen" class="filter-group studio-segments tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center" data-fluid-glass role="group" aria-label="样张来源">
          <AnimatedSelection />
          <button v-for="opt in SCOPE_OPTS" :key="opt.v" class="filter-pill" :class="{active:scope===opt.v}" type="button" :aria-pressed="scope===opt.v" @click="scope=opt.v">{{ opt.l }}</button>
        </div>
        <button v-if="hasFilters && !albumsOpen" class="btn btn-quiet btn-sm" type="button" @click="resetFromControl">清除筛选</button>
      </div>
      <details v-show="!albumsOpen" class="showcase-filters">
        <StudioDisclosureSummary><span>细选画册</span><span class="filter-summary">{{ filterSummary }}</span></StudioDisclosureSummary>
        <div class="filter-details" data-disclosure-content>
          <div class="filter-group filter-dropdowns tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center">
            <label for="showcaseTypeSelect">作品类型
              <StudioSelect id="showcaseTypeSelect" v-model="typeFilter" label="筛选作品类型"
                :options="typeOptions" /></label>
            <label for="showcaseCharSelect">角色筛选
              <StudioSelect id="showcaseCharSelect" v-model="charFilter" label="筛选角色"
                :options="characterOptions" /></label>
          </div>
          <div class="rating-options"><span>内容分级</span><div class="filter-group studio-segments studio-segments--compact tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center" data-fluid-glass role="group" aria-label="内容分级">
            <AnimatedSelection />
            <button v-for="opt in RATING_OPTS" :key="opt.v" class="filter-pill" :class="{active:ratingFilter===opt.v}" type="button" :aria-pressed="ratingFilter===opt.v" @click="ratingFilter=opt.v">{{ opt.l }}</button>
          </div></div>
        </div>
      </details>
    </div>

    <!-- Cached entries stay in place during background revalidation. -->
    <div v-if="entries.length && reloadError" class="showcase-load-status" role="status"><ArchiveIcon name="warning" /><span>{{ reloadError }}</span><button v-if="!manifestLoading" class="btn btn-quiet btn-sm" type="button" @click="loadManifest(true)">重试</button></div>
    <div v-show="albumsOpen" v-content-motion:up.defer="albumsOpen" ref="albumRoot" class="showcase-album-overview" tabindex="-1">
      <ShowcaseAlbums v-if="albumsOpen && albums.length && !unavailable" :albums="albums" :selected="albumSelection" :thumb-src="thumbSrc" :image-src="entry => assets.imageUrl(entry.id)" :aria-busy="manifestLoading" @select="openAlbum" />
      <ShowcaseLoadingGrid v-if="manifestLoading && !entries.length" albums />
      <ArchiveStatePanel v-else-if="unavailable || (!manifestLoading && !albums.length)" compact heading-level="h3" :character="activeStudioCharacter" :kind="unavailable ? 'error' : 'empty'" :title="unavailable ? '画册读取失败' : '暂未收录画册'"><button class="btn btn-ghost" type="button" @click="showImages">返回样张展墙</button></ArchiveStatePanel>
    </div>
    <div v-show="!albumsOpen" v-content-motion:up.defer="!albumsOpen" class="showcase-image-browse">
    <div ref="imageHeading" class="showcase-results-heading" tabindex="-1"><div class="showcase-result-location"><button v-if="selectedAlbum || typeFilter !== 'all'" type="button" class="showcase-album-back" @click="showAlbums"><ArchiveIcon name="chevron-down" />返回画册</button><h2>{{ selectedAlbum?.title || (typeFilter === 'all' ? '全部样张' : typeLabel(typeFilter)) }}</h2></div><span class="result-meta" id="resultMeta" role="status"><strong>{{ paged.length }}</strong> / {{ filtered.length }}</span></div>
    <ArchiveStatePanel
      v-if="unavailable"
      class="empty empty-block"
      kind="error"
      heading-level="h3"
      :character="activeStudioCharacter"
      title="展示素材暂未连接"
      message="请确认离线素材包已正确导入，或先浏览灵感场景。"
    >
      <button class="btn btn-primary" type="button" @click="loadManifest(true)">重新加载画册</button>
      <RouterLink class="btn btn-ghost" to="/scene-explorer">先逛灵感场景</RouterLink>
    </ArchiveStatePanel>

    <ShowcaseLoadingGrid v-else-if="manifestLoading && !entries.length" />

    <ArchiveStatePanel
      v-else-if="!filtered.length"
      heading-level="h3"
      :character="activeStudioCharacter"
      :kind="entries.length ? 'filtered' : 'empty'"
      :title="entries.length ? '没有匹配的参考样张' : '画册暂未收录样张'"
    >
      <template v-if="activeStudioCharacter" #chibi><AtelierEmptyArt :character="activeStudioCharacter" variant="chibi" /></template>
      <button v-if="hasFilters" class="btn btn-primary" type="button" @click="resetFromControl">重置筛选</button>
      <RouterLink v-else class="btn btn-primary" to="/scene-explorer">去逛灵感场景</RouterLink>
    </ArchiveStatePanel>

    <div v-else ref="listRoot" data-route-arrive class="showcase-grid" :aria-busy="manifestLoading">
      <ShowcaseSampleCard v-for="(entry, index) in paged" :key="entry.id" :entry="entry" :src="thumbSrc(entry)" :full-src="assets.imageUrl(entry.id)" :data-list-key="entry.id" :eager="index < 6"
        :featured="featured.has(entry.id)" :artist-featured="artistFeatureState(entry)"
        :character-label="charLabel(entry.char)" :rating-label="ratingLabel(entry.rating)"
        @open="openViewer" @feature-artist="changeArtistFeature" />
    </div>

    <div ref="loadSentinel" v-show="paged.length < filtered.length" class="load-wrap">
      <button class="btn btn-ghost load-more" type="button" @click="loadMore">加载更多 (+{{ filtered.length - paged.length }})</button>
    </div>
    </div>

    <!-- 查看器 dialog -->
    <Teleport to="body">
      <!-- 必须用 showModal() 打开（见 openViewer）：设 open 属性只是非模态 dialog，
           没有 top layer、没有 ::backdrop，背景不 inert，Tab 能直接跑到下面的网格里 -->
      <dialog ref="dialogEl" class="art-viewer showcase-viewer" :class="{ 'info-open': viewerInfoOpen }" data-image-transition aria-label="样张查看器" @click.self="closeViewer" @cancel.prevent="viewerInfoOpen ? closeViewerInfo() : closeViewer()">
        <template v-if="viewerMounted && currentEntry">
          <ArtworkViewerStage :items="filtered" :index="currentIdx" :active="viewerMounted && !viewerClosing" :original="originalViewer"
            :src="imgSrc(currentEntry)" :preview-src="viewerSurface.previewSrc.value" :thumbnail-for="thumbSrc" :title="entry => entry.title"
            @select="openViewer(filtered[$event].id)" @close="closeViewer" @toggle-original="toggleOriginalViewer" @dismiss-info="closeViewerInfo"
            @error="viewerImageFailed = true" @close-button="viewerClose = $event">
            <template #tools><button ref="viewerInfoToggle" class="viewer-info-toggle" data-fluid-glass type="button" aria-label="作品信息" aria-controls="showcase-viewer-info" :aria-expanded="viewerInfoOpen" @click="openViewerInfo"><ArchiveIcon name="info" /></button></template>
          </ArtworkViewerStage>
          <aside id="showcase-viewer-info" ref="viewerInfoEl" class="viewer-info" :style="viewerCharacterStyle" :inert="narrowViewer && !viewerInfoOpen" :aria-hidden="narrowViewer && !viewerInfoOpen ? true : undefined" aria-labelledby="showcase-viewer-title">
            <header class="viewer-info-header"><span class="viewer-kicker">参考画册</span><button ref="viewerInfoClose" class="viewer-info-close" type="button" @click="closeViewerInfo"><ArchiveIcon name="close" />关闭信息</button></header>
            <div class="viewer-info-body">
            <h2 id="showcase-viewer-title" class="viewer-title">{{ currentEntry.title }}</h2>
            <div class="viewer-meta">
              <span class="viewer-character-badge"><span class="viewer-character-dot" aria-hidden="true" /><span>{{ charLabel(currentEntry.char) }}</span></span>
              <span>{{ ratingLabel(currentEntry.rating) }}</span>
              <span>{{ currentEntry.category }}</span>
            </div>
            <blockquote v-if="viewerStory" class="viewer-story viewer-story-quote">{{ viewerStory }}</blockquote>
            <button v-if="viewerDetailsFailed" type="button" class="btn btn-ghost btn-sm" @click="viewerDetailsAttempt++">重试读取作品详情</button>
            <div class="viewer-actions">
              <template v-if="destinationError">
                <span role="status">{{ destinationError }}</span>
                <button type="button" class="btn btn-ghost" @click="retryDestination">重试</button>
              </template>
              <span v-else-if="!workspaceTarget" role="status">正在读取角色场景…</span>
              <StudioTooltip v-else :content="viewerClosing ? null : workspaceTarget.hint">
                <RouterLink class="btn btn-primary" :to="workspaceTarget.to"><ArchiveIcon name="spark" /> {{ workspaceTarget.label }}</RouterLink>
              </StudioTooltip>
            </div>
            <details v-if="viewerMeta" class="viewer-details"><StudioDisclosureSummary>创作参数</StudioDisclosureSummary><div class="viewer-meta viewer-meta-gen" data-disclosure-content>
              <span v-if="viewerMeta.engine">引擎 {{ viewerMeta.engine }}</span>
              <span v-if="viewerMeta.checkpoint">Checkpoint {{ viewerMeta.checkpoint }}</span>
              <span v-if="viewerMeta.model">模型 {{ viewerMeta.model }}</span>
              <span v-if="viewerMeta.loraId">LoRA {{ viewerMeta.loraId }}<template v-if="viewerMeta.loraVersion"> · v{{ viewerMeta.loraVersion }}</template></span>
              <span v-if="viewerMeta.seed !== undefined">Seed {{ viewerMeta.seed }}</span>
              <span v-if="viewerMeta.steps !== undefined">步数 {{ viewerMeta.steps }}</span>
              <span v-if="viewerMeta.cfg !== undefined">CFG {{ viewerMeta.cfg }}</span>
            </div>
            </details>
            </div>
          </aside>
        </template>
      </dialog>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/viewer.css'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import AtelierEmptyArt from '@/components/visual/AtelierEmptyArt.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ArtworkViewerStage from '@/components/gallery/ArtworkViewerStage.vue'
import ShowcaseAlbums from '@/components/showcase/ShowcaseAlbums.vue'
import ShowcaseSampleCard from '@/components/showcase/ShowcaseSampleCard.vue'
import ShowcaseLoadingGrid from '@/components/showcase/ShowcaseLoadingGrid.vue'
import { useShowcaseView } from '@/composables/useShowcaseView'

const {
  SCOPE_OPTS, RATING_OPTS, assets, entries, manifestLoading, reloadError,
  albums, albumSelection, selectedAlbum, featured, unavailable,
  searchQuery, searchInput, scope, typeFilter, charFilter, ratingFilter,
  albumsOpen, albumRoot, imageHeading, showAlbums, showImages, openAlbum,
  artistFeatureState, changeArtistFeature, activeStudioCharacter, viewerCharacterStyle,
  loadSentinel, loadMore,
  dialogEl, viewerMounted, viewerClosing, originalViewer, viewerInfoOpen,
  viewerInfoEl, viewerInfoClose, viewerInfoToggle, viewerClose,
  narrowViewer, openViewerInfo, closeViewerInfo, viewerSurface, viewerImageFailed,
  ratingLabel, typeLabel, charLabel, filterSummary, hasFilters, thumbSrc, imgSrc,
  typeOptions, characterOptions, filtered, paged, listRoot,
  currentIdx, currentEntry, viewerStory, viewerMeta, viewerDetailsFailed, viewerDetailsAttempt,
  destinationError, retryDestination, workspaceTarget,
  openViewer, toggleOriginalViewer, closeViewer, openRandom, resetFromControl, loadManifest,
} = useShowcaseView()
</script>

<style scoped src="@/assets/css/showcase-view.css"></style>
<style src="@/assets/css/showcase-viewer.css"></style>
