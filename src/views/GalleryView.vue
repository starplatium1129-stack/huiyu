<template>
  <article class="gallery-shell gallery-page" ref="shellEl" :style="{ '--gallery-dock-height': `${selectionDockHeight}px` }">
    <header class="gallery-intro">
      <div class="gallery-heading-copy">
        <p class="gallery-kicker"><ArchiveIcon name="image" />COLLECTION / 我的画集</p>
        <h1 class="gallery-title">我的作品</h1>
        <p class="gallery-invitation">把心动留在画里，让故事慢慢成册。</p>
        <nav v-if="(projectFilter || characterFilter) && !trashMode && !albumsOpen" class="gallery-breadcrumb" aria-label="画册位置">
          <button type="button" @click="showAlbumOverview(projectFilter ? 'albums' : 'characters')">{{ projectFilter ? '返回画册' : '返回角色' }}</button>
          <ArchiveIcon name="chevron-down" />
          <span aria-current="page">{{ collectionTitle }}</span>
        </nav>
      </div>
      <div class="tw:flex tw:items-center tw:flex-wrap tw:gap-s-2">
        <GalleryBackupTools />
        <MangaScreenLauncher @saved="loadGalleryStorage" />
        <RouterLink class="btn btn-ghost" to="/qwen-studio"><ArchiveIcon name="image" />Qwen 生图与编辑</RouterLink>
        <RouterLink class="btn btn-primary gallery-create" to="/prompt-builder">
          <ArchiveIcon name="spark" />新建创作
        </RouterLink>
      </div>
    </header>

    <div class="gallery-toolbar" aria-label="作品筛选" data-reveal>
      <div class="gallery-browse-controls studio-segments" role="group" aria-label="浏览作品">
      <AnimatedSelection />
      <button class="gallery-filter" :class="{ active: !albumsOpen && !favoriteOnly && !trashMode && !projectFilter && !characterFilter }" type="button"
        :aria-pressed="!albumsOpen && !favoriteOnly && !trashMode && !projectFilter && !characterFilter" @click="trashMode && toggleTrashMode(); showAllWorks()">全部作品</button>
      <button class="gallery-filter" type="button" :class="{ active: (albumsOpen && albumSection === 'characters') || (!albumsOpen && !!characterFilter && !projectFilter) }" :aria-pressed="(albumsOpen && albumSection === 'characters') || (!albumsOpen && !!characterFilter && !projectFilter)" @click="showAlbumOverview('characters')"><ArchiveIcon name="character" />按角色 <span>{{ characterAlbums.length }}</span></button>
      <button class="gallery-filter" type="button" :class="{ active: (albumsOpen && albumSection === 'albums') || (!albumsOpen && !!projectFilter) }" :aria-pressed="(albumsOpen && albumSection === 'albums') || (!albumsOpen && !!projectFilter)" @click="showAlbumOverview('albums')"><ArchiveIcon name="book" />按画册 <span>{{ albums.length }}</span></button>
      <button v-show="!albumsOpen" class="gallery-filter" :class="{ active: favoriteOnly && !trashMode }" type="button" :aria-pressed="favoriteOnly && !trashMode" @click="favoriteOnly = trashMode || !favoriteOnly; trashMode && toggleTrashMode()">
        <ArchiveIcon name="love" /> 收藏 {{ favoriteCount }}{{ galleryIndexLoading ? '+' : '' }}
      </button>
      </div>
      <StudioSearch v-show="!albumsOpen && !trashMode" v-model="searchQuery" class="gallery-search-field" label="搜索作品" placeholder="搜场景、角色或关键词…" />
      <GalleryRefinement v-if="!trashMode" v-show="!albumsOpen" ref="refinement"
        :filters="filterSnapshot" :projects="projectOptions" :characters="characterOptions" :tags="tagOptions"
        :generation-options="generationOptions" :smart-rule="currentSmartRule" :character-name="characterName"
        :disabled="galleryLoading || !!galleryError || saving" :project-unavailable="projectUnavailable"
        @apply="applyFilterSnapshot" @reset="resetGalleryFilters" @save="newSmartAlbum" @edit="editSmartAlbum(projectFilter)" />
    </div>
    <div v-show="albumsOpen" v-content-motion:up.defer="albumsOpen && albumSection" ref="albumRoot" class="gallery-album-overview" tabindex="-1">
      <AsyncPanel v-if="visitedPanels.albums" :loader="loadAlbumOverview" label="画册概览" v-slot="{ component }"><component :is="component" :albums="albumSection === 'characters' ? characterAlbums : albums" :selected-id="selection" :characters="albumSection === 'characters'" :loading="galleryLoading" :index-loading="galleryIndexLoading" :error="galleryError" :busy="saving" :has-history="!!history.length" @select="openCollection" @edit="editSmartAlbum" @remove="removeSmartAlbum" @smart="newSmartAlbum" @manual="startAlbumSelection" @retry="loadGalleryStorage" @images="showAllWorks" @visible="visibleAlbumIds = $event" /></AsyncPanel>
    </div>
    <div v-show="!albumsOpen" v-content-motion:fade.defer="!albumsOpen && (trashMode ? 'trash' : 'works')" class="gallery-image-browse">
    <div ref="imageHeading" class="gallery-summary" aria-live="polite" tabindex="-1">
      <span class="gallery-count"><strong>{{ trashMode ? '回收站' : collectionTitle }}</strong>{{ trashMode ? (trashLoading ? '读取中…' : trashError ? '数量待确认' : `${trashItems.length} 幅作品`) : countLabel }}</span>
      <div class="gallery-manage-controls" role="group" aria-label="管理作品">
        <button v-if="!trashMode" ref="selectionToggle" class="gallery-filter gallery-select-toggle" type="button" :class="{ active: selectMode }" :aria-pressed="selectMode" :disabled="!selectMode && !visible.length" @click="toggleSelectMode"><ArchiveIcon name="pin" />{{ selectMode ? '退出选择' : '选择' }}</button>
        <button class="gallery-filter gallery-trash-toggle" type="button" :class="{ active: trashMode }" :aria-pressed="trashMode" @click="selectMode && toggleSelectMode(); toggleTrashMode()"><ArchiveIcon name="trash" />回收站{{ !trashLoading && !trashError && trashItems.length ? `（${trashItems.length}）` : '' }}</button>
      </div>
    </div>

    <div ref="selectionDock" class="gallery-selection-dock" :data-fluid-glass="selectMode ? '' : undefined">
    <div v-if="selectMode" class="gallery-bulkbar" role="region" aria-label="批量操作">
      <span class="gallery-bulk-count" aria-live="polite"><ArchiveIcon name="success" />已选 <strong>{{ selectedIds.size }}</strong><span>/ {{ visible.length }} · Shift 连选</span></span>
      <span class="gallery-bulk-actions">
        <button class="btn btn-primary btn-sm" type="button" :disabled="selectedIds.size < 2 || selectedIds.size > 4" @click="compareSelected">对比挑选（2–4 张）</button>
        <StudioCheckbox :checked="allVisibleSelected" :indeterminate="!allVisibleSelected && visible.some(item => selectedIds.has(item.id))"
          :disabled="!visible.length || galleryIndexLoading || !!galleryError" label="全选当前作品" @update:checked="selectAllVisible">{{ galleryIndexLoading ? '正在读取全部作品…' : '全选当前' }}</StudioCheckbox>
        <!-- Keep the confirmation opener focusable while busy; bulkDelete guards re-entry. -->
        <button class="btn btn-danger btn-sm" type="button" :disabled="!selectedIds.size" :aria-disabled="bulkDeleting || undefined"
          @click="bulkDelete">{{ bulkDeleting ? '处理中…' : `移入回收站（${selectedIds.size}）` }}</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="finishSelection">完成</button>
      </span>
    </div>
    <GalleryOrganization v-if="visitedPanels.organization" :active="selectMode" :ids="[...selectedIds]" :projects="projects" @changed="loadGalleryStorage" />
    </div>

    <AsyncPanel v-if="visitedPanels.comparison" v-show="compareOpen" :loader="loadCandidateCompare" label="作品对比" v-slot="{ component }"><component :is="component" :open="compareOpen" :items="compareItems" :can-mark="canMarkComparison" :mark="saveComparisonMarks" :retry-marks="retryComparisonMarks" :marks-message="comparisonMarksMessage" :marks-reading="comparisonMarksReading" @close="closeComparison" /></AsyncPanel>
    <section aria-live="polite">
      <!-- Keep the trash read slots through close/reopen; deactivation releases queued reads and previews. -->
      <KeepAlive><GalleryTrashWall
        v-if="trashMode"
        :column-count="columnCount"
        :trash-items="trashItems"
        :trash-busy="trashBusy"
        :trash-clearing="trashClearing"
        :trash-loading="trashLoading" :trash-error="trashError" @reload="loadTrash"
        @clear="clearTrash"
        @restore="restoreTrashItem"
      /></KeepAlive>
      <template v-if="!trashMode">
      <ArchiveStatePanel
        v-if="galleryLoading"
        class="gallery-loading-wall"
        kind="loading"
        title="正在读取本地作品档案"
      />
      <ArchiveStatePanel
        v-if="galleryError"
        kind="error"
        :compact="!!history.length"
        title="本地作品档案读取失败"
        :message="galleryError"
      >
        <button class="btn btn-primary" type="button" @click="loadGalleryStorage">重新读取</button>
      </ArchiveStatePanel>
      <ArchiveStatePanel
        v-if="!galleryLoading && !galleryError && !history.length"
        kind="empty"
        title="展墙还在等你的第一幅作品"
      >
        <template #illustration><img class="gallery-empty-art" :src="galleryEmptyArt" width="1774" height="887" alt="" aria-hidden="true" draggable="false" /></template>
        <RouterLink class="btn btn-primary" to="/prompt-builder">开始绘制</RouterLink>
      </ArchiveStatePanel>
      <ArchiveStatePanel
        v-else-if="!galleryLoading && history.length && !visible.length"
        kind="filtered"
        :title="galleryIndexLoading ? '正在查找其余作品…' : '当前筛选下没有作品'"
      >
        <button class="btn btn-primary" type="button" @click="resetGalleryFilters">重置筛选</button>
      </ArchiveStatePanel>
      <div v-else-if="!galleryLoading && visible.length" class="gallery-wall stagger-container" data-route-arrive>
        <template v-for="group in masonryGroups" :key="group.key">
          <div class="gallery-section">{{ group.key }}</div>
          <div class="gallery-columns" :style="{ '--wall-cols': columnCount }">
            <GalleryVirtualColumn
              v-for="(col, colIdx) in group.columns"
              :key="`${group.key}-col-${colIdx}`"
              class="gallery-col"
              :items="col" :ratio-of="ratioOf" :enabled="visible.length >= 200" @rendered="scheduleWallScan"
            >
              <template #default="{ item }">
              <GalleryArtworkCard
                :key="item.id" :item="item"
                :title="cardLabels.get(item.id)!.title" :character="cardLabels.get(item.id)!.character"
                :formatted-date="cardLabels.get(item.id)!.date" :ratio="ratioOf(item)"
                :thumb-url="resolveRuntimeUrl(thumbUrls[item.id] || '')" :image-url="resolveRuntimeUrl(cardUrls[item.id] || '')"
                :cors="runtimeResourceCors()" :missing="missingImageIds.has(item.id)"
                :selection-mode="selectMode" :selected="selectedIds.has(item.id)"
                :confirming-delete="pendingDeleteId === item.id" :deleting="pendingDeleteId === item.id && deleting"
                @select="toggleSelect(item.id, $event)" @open="openFromCard(indexOf(item), $event)"
                @favorite="toggleFavorite(item)" @request-delete="pendingDeleteId = item.id" @cancel-delete="pendingDeleteId = null"
                @delete="confirmDelete(item)" @measure="measure(item, $event)" @load="onHdLoad(item, $event)" @retry="retryCardImage(item)"
              />
              </template>
            </GalleryVirtualColumn>
          </div>
        </template>
        <!-- 分页哨兵：进入视口即追加下一页（作品很多时避免一次性铺满 DOM） -->
        <div v-if="hasMoreToRender" ref="sentinelEl" class="gallery-more" role="status">
          已显示 {{ pagedVisible.length }} / {{ visible.length }} 幅 · 滚动继续加载
        </div>
      </div>
      </template>
    </section>

    </div>
    <AsyncPanel v-if="visitedPanels.editor" v-show="editorOpen" :loader="loadAlbumEditor" label="智能画册编辑" v-slot="{ component }"><component :is="component" v-model:open="editorOpen" v-model:title="editorTitle" v-model:rule="editorRule" :editing="!!editing" :busy="saving" :error="albumError" :count="previewItems.length" :preview-loading="galleryLoading || galleryIndexLoading" :preview-error="galleryError" :characters="characterOptions" :tags="tagOptions" :projects="manualProjects" :covers="previewCovers" @save="saveSmartAlbum" /></AsyncPanel>
    <!-- 沉浸查看器（Teleport 渲染到 body；放在根元素内保持单根，
         否则多根组件不会继承 AppLayout 注入的 route-view class） -->
    <Teleport to="body">
      <FluidTransition :surface="viewerSurface" @before-leave="imageOrigin.leave" @after-leave="finishViewerClose">
        <div
          v-show="viewerIndex >= 0"
          class="art-viewer"
          data-image-transition
          :class="{ open: viewerIndex >= 0, 'info-open': infoOpen }"
          role="dialog"
          aria-modal="true"
          :aria-hidden="viewerIndex >= 0 ? 'false' : 'true'"
          aria-label="作品观赏模式"
          ref="viewerEl"
          @load.capture="imageOrigin.loaded"
          @error.capture="imageOrigin.failed"
        >
      <ArtworkViewerStage :items="visible" :index="displayedIndex" :active="viewerIndex >= 0" :original="originalViewer"
        :src="viewerUrl" :preview-src="imageOrigin.previewSrc.value" :card-urls="cardUrls" :thumb-urls="thumbUrls" :neighbor-urls="neighborPreviews" :load-failed="viewerLoadFailed" :reload="retryViewerImage"
        :title="item => sceneTitle(item.scene, item)" @select="openViewer" @close="closeViewer" @close-button="closeBtn = $event"
        @toggle-original="toggleOriginalViewer" @dismiss-info="closeInfoDrawer" @interact="imageOrigin.cancel">
        <template v-if="(compareMode && hasComparableImage && viewerUrl) || (gestureViewer && current)" #image>
          <div v-if="compareMode && hasComparableImage && viewerUrl" class="viewer-compare-host">
            <ImageCompareSlider
              :before-src="parentImageUrl || thumbUrls[current!.id]"
              :after-src="viewerUrl"
              :before-label="parentImageLabel"
              after-label="当前成片"
            />
            <p v-if="parentImageStatus.message" class="viewer-compare-notice" role="status"><span>{{ parentImageStatus.message }}</span><button v-if="parentImageStatus.failed" class="btn btn-ghost btn-sm" type="button" @click="retryComparisonOriginal">重新读取修改前原图</button></p>
          </div>
          <component :is="PhotoSwipeStage" v-else-if="gestureViewer && current" :items="visible" :index="displayedIndex" @change="viewerIndex >= 0 && openViewer($event)" @error="failGesture" />
        </template>
        <template #tools>
        <StudioTooltip v-if="hasComparableImage && viewerUrl" :content="compareMode ? '退出对比' : '开启对比滑块'">
          <button class="viewer-compare-toggle" :class="{ active: compareMode }" type="button" :aria-pressed="compareMode" @click="compareMode = !compareMode">
            <ArchiveIcon name="spark" /> 对比
          </button>
        </StudioTooltip>
        <button ref="infoToggleBtn" class="viewer-info-toggle" data-fluid-glass type="button" aria-label="作品信息" aria-controls="viewer-info" :aria-expanded="infoOpen" @click="toggleInfoDrawer"><ArchiveIcon name="info" /></button>
        </template>
      </ArtworkViewerStage>

      <aside
        id="viewer-info"
        ref="infoEl"
        class="viewer-info"
        v-if="displayedCurrent"
        :inert="infoDrawerHidden"
        :aria-hidden="infoDrawerHidden ? 'true' : undefined"
        aria-labelledby="viewer-info-title"
      >
        <header class="viewer-info-header">
          <div class="viewer-kicker">Artwork {{ (viewerIndex >= 0 ? viewerIndex : displayedIndex) + 1 }}</div>
          <button ref="infoCloseBtn" class="viewer-info-close" type="button" @click="closeInfoDrawer">
            <ArchiveIcon name="close" /><span>关闭信息</span>
          </button>
        </header>
        <div class="viewer-info-body">
        <h2 id="viewer-info-title" tabindex="-1" v-content-motion="viewerIndex < 0 ? false : displayedCurrent.id" class="viewer-title">{{ sceneTitle(displayedCurrent.scene, displayedCurrent) }}</h2>
        <div class="viewer-meta">
          {{ characterName(displayedCurrent.character, displayedCurrent) }} · {{ formatDate(stamp(displayedCurrent)) }}
        </div>
        <div class="viewer-actions viewer-primary-actions" aria-label="作品操作">
          <StudioFavoriteButton class="btn btn-ghost" :active="!!displayedCurrent.favorite" :label="displayedCurrent.favorite ? '取消收藏' : '收藏这幅'"
            :class="{ 'btn-favorite-on': displayedCurrent.favorite }"
            :aria-pressed="!!displayedCurrent.favorite"
            @click="toggleFavorite(displayedCurrent)">
            <span>{{ displayedCurrent.favorite ? '取消收藏' : '收藏这幅' }}</span>
          </StudioFavoriteButton>
          <button class="btn btn-ghost" type="button" :disabled="downloading" :aria-busy="downloading" @click="downloadCurrent"><ArchiveIcon name="download" />{{ downloading ? '正在准备下载…' : '下载原图' }}</button>
          <MangaScreenLauncher :source-url="viewerUrl" :artwork="displayedCurrent" :disabled="!viewerUrl || viewerLoadFailed" @saved="loadGalleryStorage" />
          <RouterLink v-if="displayedCurrent.engine !== 'manga-screen' && displayedCurrent.engine !== 'qwen-image'" class="btn btn-primary viewer-remix" :to="`/prompt-builder?remix=${encodeURIComponent(displayedCurrent.id || '')}`"><ArchiveIcon name="spark" /> 沿用配方</RouterLink>
          <RouterLink v-if="displayedCurrent.image_id" class="btn btn-ghost" :to="{ path: '/qwen-studio', query: { artwork: displayedCurrent.id } }"><ArchiveIcon name="image" />用 Qwen 编辑</RouterLink>
        </div>
        <section class="viewer-section" aria-label="作品信息">
          <h3>作品信息</h3>
          <p v-if="displayedCurrent.story" class="viewer-story">{{ displayedCurrent.story }}</p>
          <div v-if="artworkTags(displayedCurrent).length" class="viewer-tags" aria-label="作品标签">
            <button v-for="tag in artworkTags(displayedCurrent)" :key="tag" type="button" @click="filterByTag(tag)">{{ tag }}</button>
          </div>
          <dl class="viewer-record">
            <div><dt>尺寸</dt><dd>{{ displayedCurrent.size || (displayedCurrent.width && displayedCurrent.height ? `${displayedCurrent.width} × ${displayedCurrent.height}` : '未记录') }}</dd></div>
            <div><dt>版本</dt><dd>v{{ displayedCurrent.version || 1 }}</dd></div>
          </dl>
        </section>
        <details class="viewer-details" :key="displayedCurrent.id">
          <StudioDisclosureSummary><span class="viewer-disclosure-copy">创作参数与 Prompt<small>查看配方</small></span></StudioDisclosureSummary>
          <div data-disclosure-content>
          <div class="viewer-facts">
          <div class="viewer-fact" v-for="f in facts" :key="f.label">
            <small>{{ f.label }}</small>
            <strong>{{ f.value || '—' }}</strong>
          </div>
          </div>
          <div class="viewer-prompt">{{ displayedCurrent.prompt || '未保存 Prompt' }}</div>
          </div>
        </details>
        <details class="viewer-details viewer-more" :key="`tools-${displayedCurrent.id}`">
          <StudioDisclosureSummary><span class="viewer-disclosure-copy">更多操作<small>重跑、复制与管理</small></span></StudioDisclosureSummary>
          <div class="viewer-actions" data-disclosure-content>
          <RouterLink v-if="displayedCurrent.engine !== 'manga-screen' && displayedCurrent.engine !== 'qwen-image'" class="btn btn-ghost" :to="`/prompt-builder?regen=${encodeURIComponent(displayedCurrent.id || '')}`">原参重跑</RouterLink>
          <RouterLink v-if="displayedCurrent.engine === 'qwen-image' && typeof displayedCurrent.taskId === 'string'" class="btn btn-ghost" :to="{ path: '/qwen-studio', query: { job: displayedCurrent.taskId } }">查看 Qwen 原任务</RouterLink>
          <button data-gesture-toggle class="btn btn-ghost" type="button" :aria-pressed="gestureViewer" :aria-busy="gestureLoading" @click="toggleGesture">{{ gestureLoading ? '取消手势加载' : gestureViewer ? '返回原查看器' : '尝试手势观画' }}</button>
          <p v-if="gestureLoading" class="gallery-gesture-feedback" role="status">正在准备手势观画…</p>
          <div v-if="gestureError" class="gallery-gesture-feedback"><span role="alert">手势观画暂未加载。</span><button class="btn btn-ghost btn-sm" type="button" @click="toggleGesture">重新读取</button></div>
          <StudioCopyButton class="btn btn-ghost" label="复制 Prompt" :action="copyPrompt" :content-key="String(displayedCurrent.id)" :disabled="!displayedCurrent.prompt" />
          <button v-if="pendingDeleteId !== displayedCurrent.id" class="btn btn-ghost btn-danger" type="button"
            @click="pendingDeleteId = displayedCurrent.id">删除这幅</button>
          <template v-else>
            <button class="btn btn-danger" type="button" :disabled="deleting"
              @click="confirmDelete(displayedCurrent)">{{ deleting ? '删除中…' : '移入回收站' }}</button>
            <button class="btn btn-ghost" type="button" :disabled="deleting"
              @click="pendingDeleteId = null">取消</button>
          </template>
          </div>
        </details>
        </div>
      </aside>
        </div>
      </FluidTransition>
    </Teleport>
  </article>

</template>

<script setup lang="ts">
import '@/assets/css/viewer.css'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { contentMotion as vContentMotion } from '@/directives/contentMotion'
import FluidTransition from "@/components/visual/FluidTransition.vue"
import GalleryRefinement from '@/components/gallery/GalleryRefinement.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioFavoriteButton from '@/components/ui/StudioFavoriteButton.vue'
import GalleryArtworkCard from '@/components/gallery/GalleryArtworkCard.vue'
import GalleryVirtualColumn from '@/components/gallery/GalleryVirtualColumn.vue'
import ArtworkViewerStage from '@/components/gallery/ArtworkViewerStage.vue'
import { computed, defineAsyncComponent, nextTick, onActivated, onDeactivated, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { artworkTags } from '@/composables/gallery/artworkTags'
const PhotoSwipeStage = shallowRef<typeof import('@/components/gallery/PhotoSwipeStage.vue')['default'] | null>(null)
const GalleryBackupTools = defineAsyncComponent(() => import('@/components/gallery/GalleryBackupTools.vue'))
const gestureViewer = ref(false)
const gestureLoading = ref(false), gestureError = ref(false)
let gestureRequest = 0
function cancelGesture() { gestureRequest++; gestureViewer.value = false; gestureLoading.value = false; gestureError.value = false }
async function failGesture() {
  const focused = document.activeElement, owned = focused?.closest('.photoswipe-stage')
  cancelGesture(); gestureError.value = true
  const request = gestureRequest
  await nextTick()
  if (owned && request === gestureRequest && viewerIndex.value >= 0 && document.activeElement === document.body)
    closeBtn.value?.focus({ preventScroll: true })
}
async function toggleGesture() {
  if (gestureViewer.value || gestureLoading.value) { cancelGesture(); return }
  if (viewerIndex.value < 0 || !current.value) return
  const request = ++gestureRequest, id = current.value.id
  // A retry removes its own button; the mode toggle survives every loading state.
  if (gestureError.value) viewerEl.value?.querySelector<HTMLElement>('[data-gesture-toggle]')?.focus({ preventScroll: true })
  gestureLoading.value = true; gestureError.value = false; compareMode.value = false
  const currentRequest = () => request === gestureRequest && viewerIndex.value >= 0 && current.value?.id === id
  try {
    const component = PhotoSwipeStage.value || (await import('@/components/gallery/PhotoSwipeStage.vue')).default
    if (currentRequest()) { PhotoSwipeStage.value = component; gestureViewer.value = true }
  } catch { if (currentRequest()) gestureError.value = true }
  finally { if (currentRequest()) gestureLoading.value = false }
}
onScopeDispose(cancelGesture)
const originalViewer = ref(false)
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
const loadCandidateCompare = () => import('@/components/gallery/CandidateCompare.vue')
const GalleryOrganization = defineAsyncComponent(() => import('@/components/gallery/GalleryOrganization.vue'))
import GalleryTrashWall from '@/components/gallery/GalleryTrashWall.vue'
const loadAlbumOverview = () => import('@/components/gallery/GalleryAlbumOverview.vue')
const loadAlbumEditor = () => import('@/components/gallery/GallerySmartAlbumEditor.vue')
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import MangaScreenLauncher from '@/components/manga/MangaScreenLauncher.vue'
import galleryEmptyOriginal from '@/assets/illustrations/atelier-gallery.png'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
const galleryEmptyArt = useThemeIllustration(galleryEmptyOriginal, 'collection')
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ImageCompareSlider from '@/components/visual/ImageCompareSlider.vue'
import { useGalleryWorkspace } from "@/composables/gallery/useGalleryWorkspace"
import { useGalleryCollections } from '@/composables/gallery/useGalleryCollections'
import { useGalleryImageOrigin } from '@/composables/gallery/useGalleryImageOrigin'
import { useArtworkViewerSurface } from '@/composables/useArtworkViewerSurface'
const selectionDock = ref<HTMLElement | null>(null), dockActive = ref(true)
const selectionDockHeight = ref(140)
useResizeObserver(() => dockActive.value ? selectionDock.value : null, ([entry]) => {
  if (entry && dockActive.value) selectionDockHeight.value = entry.borderBoxSize[0].blockSize
}, { box: 'border-box' })
onActivated(() => { dockActive.value = true })
onDeactivated(() => { dockActive.value = false; cancelGesture() })
const workspace = useGalleryWorkspace()
const {
tagFilter, tagOptions, characterFilter, collectionPreviewItems,
generationOptions, filterSnapshot, applyFilterSnapshot, projectOptions, projectUnavailable,
closeBtn,viewerEl,infoEl,infoToggleBtn,infoCloseBtn,sentinelEl,shellEl,countLabel,
searchQuery,
favoriteOnly, favoriteCount, projectFilter, projects,
selectMode,
toggleSelectMode,
trashMode,
toggleTrashMode,
trashItems,
selectedIds,
visible,
compareSelected,
selectAllVisible,
allVisibleSelected,
bulkDeleting,
bulkDelete,
compareOpen,
compareItems, closeComparison,
loadGalleryStorage,
trashBusy,
restoreTrashItem,
clearTrash, trashClearing, trashLoading, trashError, loadTrash,
galleryLoading,
galleryIndexLoading,
galleryError, canMarkComparison, saveComparisonMarks, retryComparisonMarks, comparisonMarksMessage, comparisonMarksReading,
history,
resetGalleryFilters,
masonryGroups,
scheduleWallScan, retryCardImage,
columnCount,
pendingDeleteId,
ratioOf,
deleting,
confirmDelete,
sceneTitle,
toggleFavorite,
toggleSelect,
openViewer,
indexOf,
thumbUrls,
measure,
cardUrls,
onHdLoad,
missingImageIds,
formatDate,
stamp,
hasMoreToRender,
pagedVisible,
viewerIndex,
infoOpen,
infoDrawerHidden,
toggleInfoDrawer,
closeInfoDrawer,
closeViewer,
onViewerClosed,
compareMode,
hasComparableImage,
viewerUrl, viewerLoadFailed, retryViewerImage,
neighborPreviews,
parentImageUrl, parentImageLabel, parentImageStatus, retryParentImage,
current,
characterName,
facts,
downloadCurrent, downloading,
copyPrompt
} = workspace
function retryComparisonOriginal(event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.closest('.viewer-compare-host')?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll:true })
  void retryParentImage()
}
const cardLabels = computed(() => new Map(pagedVisible.value.map(item => [item.id, {
  title: sceneTitle(item.scene, item), character: characterName(item.character, item), date: formatDate(stamp(item)),
}])))
function toggleOriginalViewer() {
  originalViewer.value = !originalViewer.value; cancelGesture(); compareMode.value = false
  void nextTick(() => viewerEl.value?.querySelector<HTMLElement>('.zoomable-image-viewer')?.focus({ preventScroll:true }))
}
watch(viewerIndex, (index, previous) => { if (index < 0 || previous < 0) cancelGesture(); if (index >= 0 && previous < 0) originalViewer.value = false }, { flush:'sync' })
watch(() => current.value?.id, () => { if (gestureLoading.value || gestureError.value) cancelGesture() }, { flush:'sync' })
watch(compareMode, value => { if (value) cancelGesture() }, { flush:'sync' })
const imageOrigin = useGalleryImageOrigin({ viewerEl, shellEl, viewerIndex, viewerUrl, current })
const viewerSurface = useArtworkViewerSurface()
function openFromCard(index: number, event: MouseEvent) {
  imageOrigin.capture(event)
  openViewer(index)
  void imageOrigin.enter()
}
const { albums, characterAlbums, albumSection, visibleAlbumIds, selection, characterOptions, manualProjects, collectionTitle, currentSmartRule,
  albumsOpen, albumRoot, imageHeading, showImages, showOverview, showAllWorks, openCollection, editorOpen, editorTitle, editorRule,
  editing, saving, error: albumError, previewItems, previewCovers, syncPreviews, newSmartAlbum, editSmartAlbum, removeSmartAlbum, save: saveSmartAlbum } = useGalleryCollections(workspace)
// Keep visited panels alive so closing selection or a dialog retains undo and exit state.
const visitedPanels = reactive({ albums: false, organization: false, editor: false, comparison: false })
watch([albumsOpen, selectMode, editorOpen, compareOpen], ([albums, organization, editor, comparison]) => {
  if (albums) visitedPanels.albums = true
  if (organization) visitedPanels.organization = true
  if (editor) visitedPanels.editor = true
  if (comparison) visitedPanels.comparison = true
}, { immediate: true, flush: 'sync' })
watch(syncPreviews, items => { collectionPreviewItems.value = items }, { immediate: true })
function showAlbumOverview(section: 'characters' | 'albums') {
  if (selectMode.value) toggleSelectMode()
  if (trashMode.value) toggleTrashMode()
  void showOverview(section)
}
function startAlbumSelection() {
  resetGalleryFilters()
  if (trashMode.value) toggleTrashMode()
  if (!selectMode.value) toggleSelectMode()
  void showImages()
}
const refinement = ref<InstanceType<typeof GalleryRefinement> | null>(null)
const selectionToggle = ref<HTMLButtonElement | null>(null)
async function finishSelection() {
  toggleSelectMode()
  await nextTick()
  ;(selectionToggle.value?.disabled ? imageHeading.value : selectionToggle.value)?.focus({ preventScroll: true })
}
async function filterByTag(tag: string) {
  closeViewer(); tagFilter.value = tag
  await nextTick(); refinement.value?.focusTag()
}

const displayedCurrent = ref(current.value)
const displayedIndex = ref(viewerIndex.value)
watch(() => current.value?.id, async (id, previous) => {
  if (id == null || id === previous || viewerIndex.value < 0) return
  const focused = infoEl.value?.contains(document.activeElement) ? document.activeElement : null
  await nextTick()
  if (current.value?.id !== id || viewerIndex.value < 0 || !infoEl.value?.isConnected) return
  const body = infoEl.value?.querySelector<HTMLElement>('.viewer-info-body')
  body?.scrollTo(0, 0)
  if (focused && !focused.isConnected && !infoDrawerHidden.value && viewerIndex.value >= 0)
    body?.querySelector<HTMLElement>('.viewer-title')?.focus({ preventScroll: true })
})
watch([current, viewerIndex], ([value, index]) => {
  if (value && index >= 0) {
    displayedCurrent.value = value
    displayedIndex.value = index
  }
}, { flush: 'sync' })
function finishViewerClose() {
  imageOrigin.cancel()
  onViewerClosed()
  if (viewerIndex.value < 0) {
    displayedCurrent.value = null
    displayedIndex.value = -1
  }
}
</script>

<style scoped src="@/assets/css/gallery-view.css"></style>


<style src="@/assets/css/gallery-viewer.css"></style>

<style scoped>
.gallery-gesture-feedback { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); flex-basis:100%; margin:0; color:var(--text-secondary); font:400 var(--fs-label-sm)/var(--lh-body) var(--font-sans); }
</style>
