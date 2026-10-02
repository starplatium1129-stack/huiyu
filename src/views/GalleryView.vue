<template>
  <article class="gallery-shell gallery-page" ref="shellEl">
    <header class="gallery-intro">
      <div>
        <div class="gallery-kicker">HUIYU / PRIVATE COLLECTION</div>
        <h1 class="gallery-title">我的作品</h1>
        <nav v-if="(projectFilter || characterFilter) && !trashMode && !albumsOpen" class="gallery-breadcrumb" aria-label="画册位置">
          <button type="button" @click="showAlbumOverview(projectFilter ? 'albums' : 'characters')">{{ projectFilter ? '返回画册' : '返回角色' }}</button>
          <ArchiveIcon name="chevron-down" />
          <span aria-current="page">{{ collectionTitle }}</span>
        </nav>
        <p class="gallery-subtitle">收藏每一次心动，让灵感从这里继续。</p>
      </div>
      <RouterLink class="btn btn-primary gallery-create" to="/prompt-builder">
        <ArchiveIcon name="spark" />新建创作
      </RouterLink>
    </header>

    <div class="gallery-toolbar sticky-toolbar" aria-label="作品筛选" data-reveal>
      <div class="gallery-browse-controls" role="group" aria-label="浏览作品">
      <AnimatedSelection />
      <button class="gallery-filter" :class="{ active: !albumsOpen && !favoriteOnly && !trashMode && !projectFilter && !characterFilter }" type="button"
        :aria-pressed="!albumsOpen && !favoriteOnly && !trashMode && !projectFilter && !characterFilter" @click="trashMode && toggleTrashMode(); showAllWorks()">全部作品</button>
      <button class="gallery-filter" type="button" :class="{ active: (albumsOpen && albumSection === 'characters') || (!albumsOpen && !!characterFilter && !projectFilter) }" :aria-pressed="(albumsOpen && albumSection === 'characters') || (!albumsOpen && !!characterFilter && !projectFilter)" @click="showAlbumOverview('characters')"><ArchiveIcon name="character" />按角色 <span>{{ characterAlbums.length }}</span></button>
      <button class="gallery-filter" type="button" :class="{ active: (albumsOpen && albumSection === 'albums') || (!albumsOpen && !!projectFilter) }" :aria-pressed="(albumsOpen && albumSection === 'albums') || (!albumsOpen && !!projectFilter)" @click="showAlbumOverview('albums')"><ArchiveIcon name="book" />按画册 <span>{{ albums.length }}</span></button>
      <button v-show="!albumsOpen" class="gallery-filter" :class="{ active: favoriteOnly && !trashMode }" type="button" :aria-pressed="favoriteOnly && !trashMode" @click="favoriteOnly = trashMode || !favoriteOnly; trashMode && toggleTrashMode()">
        <ArchiveIcon name="love" /> 收藏 {{ favoriteCount }}
      </button>
      </div>
      <!--
        展墙搜索（2026-08-30 UX 审计 P1）：攒到几百张之后，「找某一张旧作」是
        最高频也最痛苦的动作，此前只能靠翻。检索范围含场景名、角色、当时写的
        故事与完整 prompt——很多旧作只记得里面出现过某个词。
      -->
      <StudioSearch v-show="!albumsOpen" v-model="searchQuery" class="gallery-search-field" label="搜索作品" placeholder="搜场景、角色或关键词…" />
      <StudioSelect v-show="!albumsOpen" v-model="projectFilter" class="gallery-project" label="按画册筛选" :options="projectOptions" />
      <!--
        多选（2026-08-30 UX 审计 P1）：清 500 张废稿原本要点约 1500 次（每张进大图
        → 点删除 → 再确认）。删除已改软删可撤销，批量删的风险随之降到可接受。
      -->
      <div v-show="!albumsOpen" class="gallery-manage-controls" role="group" aria-label="管理作品">
      <button v-if="!trashMode" class="gallery-filter" type="button" :class="{ active: selectMode }"
        :aria-pressed="selectMode" @click="toggleSelectMode">
        <ArchiveIcon name="pin" />{{ selectMode ? '退出选择' : '选择' }}
      </button>
      <!-- 回收站（2026-08-31）：查看/恢复软删作品，30 天保留 -->
      <button class="gallery-filter" type="button" :class="{ active: trashMode }"
        :aria-pressed="trashMode" @click="selectMode && toggleSelectMode(); toggleTrashMode()">
        <ArchiveIcon name="trash" />回收站{{ trashItems.length ? `（${trashItems.length}）` : '' }}
      </button>
      </div>
    </div>
    <div v-show="albumsOpen" ref="albumRoot" class="gallery-album-overview" tabindex="-1">
      <GalleryAlbumOverview :albums="albumSection === 'characters' ? characterAlbums : albums" :selected-id="selection" :characters="albumSection === 'characters'" :loading="galleryLoading" :error="galleryError" :busy="saving" :has-history="!!history.length" @select="openCollection" @edit="editSmartAlbum" @remove="removeSmartAlbum" @smart="newSmartAlbum" @manual="startAlbumSelection" @images="showAllWorks" @visible="visibleAlbumIds = $event" />
    </div>
    <div v-show="!albumsOpen" class="gallery-image-browse">
    <GalleryGenerationFilters v-if="!trashMode" v-model:conditions="generationConditions" :options="generationOptions" :filter-count="generationFilterCount" :snapshot="filterSnapshot" :has-active="hasActiveFilters" :project-unavailable="projectUnavailable" @apply="applyFilterSnapshot" @reset="resetGalleryFilters" @clear="clearGenerationConditions" />
    <div v-if="!trashMode && history.length" ref="tagControls"><GalleryCollectionFilters v-model:character="characterFilter" v-model:tag="tagFilter" :characters="characterOptions" :tags="tagOptions" :smart-rule="currentSmartRule" :character-name="characterName" :disabled="galleryLoading || !!galleryError || saving" @save="newSmartAlbum" @edit="editSmartAlbum(projectFilter)" /></div>
    <div ref="imageHeading" class="gallery-summary" aria-live="polite" tabindex="-1">
      <span class="gallery-count"><strong>{{ trashMode ? '回收站' : collectionTitle }}</strong>{{ trashMode ? `${trashItems.length} 幅作品` : countLabel }}</span>
      <span class="gallery-toolbar-note">{{ trashMode ? '删除的作品保留 30 天，可随时恢复' : selectMode ? '选择作品后，可整理画册与标签、对比挑选或移入回收站' : '点作品欣赏原图，或沿用配方继续创作' }}</span>
    </div>

    <div v-if="selectMode" class="gallery-bulkbar" role="region" aria-label="批量操作">
      <span class="gallery-bulk-count" aria-live="polite">已选 {{ selectedIds.size }} / {{ visible.length }}</span>
      <span class="gallery-bulk-actions tw:flex tw:flex-wrap tw:items-center tw:gap-s-2 tw:ml-auto">
        <button class="btn btn-primary btn-sm" type="button" :disabled="selectedIds.size < 2 || selectedIds.size > 4" @click="compareSelected">对比挑选（2–4 张）</button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="!visible.length"
          @click="selectAllVisible">{{ allVisibleSelected ? '取消全选' : '全选当前' }}</button>
        <button class="btn btn-danger btn-sm" type="button" :disabled="!selectedIds.size || bulkDeleting"
          @click="bulkDelete">{{ bulkDeleting ? '处理中…' : `移入回收站（${selectedIds.size}）` }}</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="toggleSelectMode">完成</button>
      </span>
    </div>
    <GalleryOrganization :active="selectMode" :ids="[...selectedIds]" :projects="projects" @changed="loadGalleryStorage" />

    <CandidateCompare :open="compareOpen" :items="compareItems" @close="compareOpen = false" @changed="loadGalleryStorage" />
    <section v-content-motion="`${trashMode}:${projectFilter}:${characterFilter}:${favoriteOnly}:${tagFilter}`" aria-live="polite" data-reveal data-reveal-delay="1">
      <!-- 回收站视图（2026-08-31）：列出软删条目，可逐条恢复；30 天超期自动清理 -->
      <GalleryTrashWall
        v-if="trashMode"
        :column-count="columnCount"
        :trash-items="trashItems"
        :trash-thumbs="trashThumbs"
        :trash-busy="trashBusy"
        :trash-clearing="trashClearing"
        @clear="clearTrash"
        @restore="restoreTrashItem"
      />
      <template v-else>
      <ArchiveStatePanel
        v-if="galleryLoading"
        class="gallery-loading-wall"
        kind="loading"
        title="正在读取本地作品档案"
        message="先建立展墙结构，再逐张解码原图。"
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
        message="画好之后，它会按自己的横竖比例住进来。作品只存在这台电脑，参数不挡画面。"
      >
        <RouterLink class="btn btn-primary" to="/prompt-builder">开始绘制</RouterLink>
      </ArchiveStatePanel>
      <ArchiveStatePanel
        v-else-if="!galleryLoading && history.length && !visible.length"
        kind="filtered"
        title="当前筛选下没有作品"
        message="作品仍在本地档案中，重置角色、文本、标签、收藏、画册及生成条件即可重新查找。"
      >
        <button class="btn btn-primary" type="button" @click="resetGalleryFilters">重置筛选</button>
      </ArchiveStatePanel>
      <div v-else-if="!galleryLoading && visible.length" class="gallery-wall stagger-container">
        <template v-for="group in masonryGroups" :key="group.key">
          <div class="gallery-section">{{ group.key }}</div>
          <div class="gallery-columns" :style="{ '--wall-cols': columnCount }">
            <div
              v-for="(col, colIdx) in group.columns"
              :key="`${group.key}-col-${colIdx}`"
              class="gallery-col"
            >
              <article
                v-for="item in col"
                :key="item.id"
                class="artwork"
                :class="{ 'artwork-pending': pendingDeleteId === item.id, 'artwork-selected': selectMode && selectedIds.has(item.id) }"
                :data-card-id="String(item.id)"
                :style="{ '--art-ratio': String(ratioOf(item)) }"
              >
                <!-- 多选勾选标记：只在选择模式出现，纯视觉，状态由按钮的 aria-pressed 承载 -->
                <span v-if="selectMode" class="artwork-check" aria-hidden="true">
                  <ArchiveIcon v-if="selectedIds.has(item.id)" name="success" />
                </span>
                <!--
                  快捷工具条：选择模式下让位给右上角的勾选标记。此时点卡片是勾选而非
                  进大图，把收藏/沿用配方/删除留在原位会与勾选标记叠在一起，且容易误触。
                -->
                <div v-if="!selectMode" class="artwork-tools">
                  <template v-if="pendingDeleteId === item.id">
                    <button class="artwork-tool danger" type="button" :disabled="deleting"
                      @click="confirmDelete(item)">{{ deleting ? '删除中…' : '确认删除' }}</button>
                    <button class="artwork-tool" type="button" :disabled="deleting"
                      @click="pendingDeleteId = null">取消</button>
                  </template>
                  <template v-else>
                    <StudioTooltip content="收藏后可在顶部按「收藏」筛选">
                      <button class="artwork-tool" type="button"
                        :class="{ 'artwork-tool-on': item.favorite }"
                        :aria-pressed="!!item.favorite"
                        :aria-label="`${item.favorite ? '取消收藏' : '收藏'}：${sceneTitle(item.scene, item)}`"
                        @click="toggleFavorite(item)">
                        <ArchiveIcon name="love" /><span>{{ item.favorite ? '已收藏' : '收藏' }}</span>
                      </button>
                    </StudioTooltip>
                    <StudioTooltip content="以此作品配方回填创作台">
                      <RouterLink class="artwork-tool" :to="`/prompt-builder?remix=${encodeURIComponent(item.id || '')}`">
                        <ArchiveIcon name="spark" /><span>沿用配方</span>
                      </RouterLink>
                    </StudioTooltip>
                    <StudioTooltip content="删除作品">
                      <button class="artwork-tool danger" type="button"
                        :aria-label="`删除作品：${sceneTitle(item.scene, item)}`"
                        @click="pendingDeleteId = item.id">
                        <ArchiveIcon name="close" /><span>删除</span>
                      </button>
                    </StudioTooltip>
                  </template>
                </div>
                <button
                  class="artwork-button"
                  type="button"
                  :aria-pressed="selectMode ? selectedIds.has(item.id) : undefined"
                  :aria-label="selectMode
                    ? `${selectedIds.has(item.id) ? '取消选择' : '选择'}作品：${sceneTitle(item.scene, item)}`
                    : `欣赏作品：${sceneTitle(item.scene, item)}`"
                  @click="selectMode ? toggleSelect(item.id) : openFromCard(indexOf(item), $event)"
                >
                  <div class="artwork-media" :style="{ '--art-ratio': String(ratioOf(item)) }">
                    <!-- 底层：缩略图垫底（HD 就绪前先出图，也避免 LRU 淘汰 HD 后回退成骨架屏） -->
                    <img :crossorigin="runtimeResourceCors()"
                      v-if="thumbUrls[item.id]"
                      class="artwork-image"
                      :src="resolveRuntimeUrl(thumbUrls[item.id])"
                      :alt="sceneTitle(item.scene, item)"
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      @load="measure(item, $event)"
                    />
                    <!-- 上层：HD 原图，解码完成后淡入覆盖缩略图，消除「闪一下变高清」的硬切 -->
                    <img :crossorigin="runtimeResourceCors()"
                      v-if="cardUrls[item.id]"
                      class="artwork-image artwork-image-hd"
                      :src="resolveRuntimeUrl(cardUrls[item.id])"
                      :alt="sceneTitle(item.scene, item)"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      @load="onHdLoad(item, $event)"
                    />
                    <div v-if="!cardUrls[item.id] && !thumbUrls[item.id] && missingImageIds.has(item.id)" class="artwork-placeholder"><ArchiveIcon name="image" /></div>
                    <div v-else-if="!cardUrls[item.id] && !thumbUrls[item.id]" class="artwork-skeleton" aria-hidden="true"></div>
                  </div>
                    <div class="artwork-caption">
                      <span class="artwork-caption-copy tw:min-w-0">
                        <span class="artwork-name">{{ sceneTitle(item.scene, item) }}</span>
                        <span class="artwork-date">{{ characterName(item.character, item) }} · {{ formatDate(stamp(item)) }}</span>
                      </span>
                      <span v-if="item.favorite" class="artwork-mark"><ArchiveIcon name="love" /></span>
                    </div>
                </button>
              </article>
            </div>
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
    <GallerySmartAlbumEditor v-model:open="editorOpen" v-model:title="editorTitle" v-model:rule="editorRule" :editing="!!editing" :busy="saving" :error="albumError" :count="previewItems.length" :characters="characterOptions" :tags="tagOptions" :projects="manualProjects" :covers="previewCovers" @save="saveSmartAlbum" />
    <!-- 沉浸查看器（Teleport 渲染到 body；放在根元素内保持单根，
         否则多根组件不会继承 AppLayout 注入的 route-view class） -->
    <Teleport to="body">
      <FluidTransition @before-leave="imageOrigin.leave" @after-leave="finishViewerClose">
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
      <section class="viewer-stage" @click.self="closeInfoDrawer">
        <button class="viewer-close" type="button" aria-label="关闭" @click="closeViewer" ref="closeBtn"><ArchiveIcon name="close" /></button>
        <button class="viewer-nav viewer-prev" type="button" aria-label="上一幅" :disabled="viewerIndex <= 0" @click="step(-1)"><ArchiveIcon name="chevron-down" /></button>
        <template v-if="compareMode && hasComparableImage && viewerUrl">
          <div class="viewer-compare-host">
            <ImageCompareSlider
              :before-src="parentImageUrl || thumbUrls[current!.id]"
              :after-src="viewerUrl"
              :before-label="parentImageUrl ? '修改前原图' : '缩略图预览'"
              after-label="当前成片"
            />
          </div>
        </template>
        <PhotoSwipeStage v-else-if="gestureViewer && current" :items="visible" :index="displayedIndex" @change="viewerIndex >= 0 && openViewer($event)" @error="gestureViewer = false" />
        <ZoomableImageViewer
          v-else-if="viewerUrl || imageOrigin.previewSrc.value"
          :src="resolveRuntimeUrl(viewerUrl || imageOrigin.previewSrc.value)"
          :preview-src="imageOrigin.previewSrc.value"
          :alt="current ? sceneTitle(current.scene, current) : ''"
        >
          <template #fallback>
            <div class="viewer-fallback"><ArchiveIcon name="image" /></div>
          </template>
        </ZoomableImageViewer>
        <div v-else class="viewer-fallback"><ArchiveIcon name="image" /></div>
        <button class="viewer-nav viewer-next" type="button" aria-label="下一幅" :disabled="viewerIndex >= visible.length - 1" @click="step(1)"><ArchiveIcon name="chevron-down" /></button>
        <StudioTooltip v-if="hasComparableImage && viewerUrl" :content="compareMode ? '退出对比' : '开启对比滑块'">
          <button class="viewer-compare-toggle" :class="{ active: compareMode }" type="button" :aria-pressed="compareMode" @click="compareMode = !compareMode">
            <ArchiveIcon name="spark" /> 对比
          </button>
        </StudioTooltip>
        <button ref="infoToggleBtn" class="viewer-info-toggle" type="button" aria-label="作品信息" aria-controls="viewer-info" :aria-expanded="infoOpen" @click="toggleInfoDrawer"><ArchiveIcon name="info" /></button>
        <div class="viewer-position">{{ displayedIndex + 1 }} / {{ visible.length }}</div>
      </section>

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
        <h2 id="viewer-info-title" class="viewer-title">{{ sceneTitle(displayedCurrent.scene, displayedCurrent) }}</h2>
        <div class="viewer-meta">
          {{ characterName(displayedCurrent.character, displayedCurrent) }} · {{ formatDate(stamp(displayedCurrent)) }}
        </div>
        <section class="viewer-section" aria-label="作品信息">
          <h3>作品信息</h3>
          <p class="viewer-story">{{ displayedCurrent.story || '这幅作品还没有附加文字。' }}</p>
          <div v-if="artworkTags(displayedCurrent).length" class="viewer-tags" aria-label="作品标签">
            <button v-for="tag in artworkTags(displayedCurrent)" :key="tag" type="button" @click="filterByTag(tag)">{{ tag }}</button>
          </div>
          <dl class="viewer-record">
            <div><dt>尺寸</dt><dd>{{ displayedCurrent.size || (displayedCurrent.width && displayedCurrent.height ? `${displayedCurrent.width} × ${displayedCurrent.height}` : '未记录') }}</dd></div>
            <div><dt>版本</dt><dd>v{{ displayedCurrent.version || 1 }}</dd></div>
          </dl>
        </section>
        <details class="viewer-details" :key="displayedCurrent.id">
          <summary>创作参数与 Prompt <ArchiveIcon name="chevron-down" /><span>查看配方</span></summary>
          <div class="viewer-facts">
          <div class="viewer-fact" v-for="f in facts" :key="f.label">
            <small>{{ f.label }}</small>
            <StudioTooltip :content="f.value || '—'">
              <strong>{{ f.value || '—' }}</strong>
            </StudioTooltip>
          </div>
          </div>
          <div class="viewer-prompt">{{ displayedCurrent.prompt || '未保存 Prompt' }}</div>
        </details>
        <div class="viewer-actions viewer-primary-actions" aria-label="作品操作">
          <button class="btn btn-ghost" type="button"
            :class="{ 'btn-favorite-on': displayedCurrent.favorite }"
            :aria-pressed="!!displayedCurrent.favorite"
            @click="toggleFavorite(displayedCurrent)">
            <ArchiveIcon name="love" /><span>{{ displayedCurrent.favorite ? '取消收藏' : '收藏这幅' }}</span>
          </button>
          <button class="btn btn-ghost" type="button" @click="downloadCurrent"><ArchiveIcon name="download" />下载原图</button>
          <RouterLink class="btn btn-primary viewer-remix" :to="`/prompt-builder?remix=${encodeURIComponent(displayedCurrent.id || '')}`"><ArchiveIcon name="spark" /> 沿用配方</RouterLink>
        </div>
        <details class="viewer-details viewer-more" :key="`tools-${displayedCurrent.id}`">
          <summary>更多操作 <ArchiveIcon name="chevron-down" /><span>重跑、复制与管理</span></summary>
          <div class="viewer-actions">
          <RouterLink class="btn btn-ghost" :to="`/prompt-builder?regen=${encodeURIComponent(displayedCurrent.id || '')}`">原参重跑</RouterLink>
          <button class="btn btn-ghost" type="button" :aria-pressed="gestureViewer" @click="gestureViewer = !gestureViewer">{{ gestureViewer ? '返回原查看器' : '尝试手势观画' }}</button>
          <button
            class="btn btn-ghost"
            :class="{ 'btn-copied-success': copiedPrompt }"
            type="button"
            @click="copyPrompt"
          >
            <ArchiveIcon :name="copiedPrompt ? 'success' : 'copy'" />
            <span>{{ copiedPrompt ? '已复制' : '复制 Prompt' }}</span>
          </button>
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
      </aside>
        </div>
      </FluidTransition>
    </Teleport>
  </article>

</template>

<script setup lang="ts">
import '@/assets/css/viewer.css'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import FluidTransition from "@/components/visual/FluidTransition.vue"
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { artworkTags } from '@/composables/gallery/artworkTags'
const PhotoSwipeStage = defineAsyncComponent(() => import('@/components/gallery/PhotoSwipeStage.vue'))
const gestureViewer = ref(false)
import CandidateCompare from '@/components/gallery/CandidateCompare.vue'
import GalleryOrganization from '@/components/gallery/GalleryOrganization.vue'
import GalleryTrashWall from '@/components/gallery/GalleryTrashWall.vue'
import GalleryGenerationFilters from '@/components/gallery/GalleryGenerationFilters.vue'
import GalleryAlbumOverview from '@/components/gallery/GalleryAlbumOverview.vue'
import GalleryCollectionFilters from '@/components/gallery/GalleryCollectionFilters.vue'
import GallerySmartAlbumEditor from '@/components/gallery/GallerySmartAlbumEditor.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ImageCompareSlider from '@/components/visual/ImageCompareSlider.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { useGalleryWorkspace } from "@/composables/gallery/useGalleryWorkspace"
import { useGalleryCollections } from '@/composables/gallery/useGalleryCollections'
import { useGalleryImageOrigin } from '@/composables/gallery/useGalleryImageOrigin'
const workspace = useGalleryWorkspace()
const {
tagFilter, tagOptions, characterFilter, collectionPreviewItems,
generationConditions, generationOptions, generationFilterCount, filterSnapshot, hasActiveFilters, applyFilterSnapshot, clearGenerationConditions, projectOptions, projectUnavailable,
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
compareItems,
loadGalleryStorage,
trashBusy,
trashThumbs,
trashPrompt,
formatTrashTime,
restoreTrashItem,
clearTrash, trashClearing,
galleryLoading,
galleryError,
history,
resetGalleryFilters,
masonryGroups,
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
step,
compareMode,
hasComparableImage,
viewerUrl,
parentImageUrl,
current,
characterName,
facts,
downloadCurrent,
copiedPrompt,
copyPrompt
} = workspace
const imageOrigin = useGalleryImageOrigin({ viewerEl, shellEl, viewerIndex, viewerUrl, current })
function openFromCard(index: number, event: MouseEvent) {
  imageOrigin.capture(event)
  openViewer(index)
  void imageOrigin.enter()
}
const { albums, characterAlbums, albumSection, visibleAlbumIds, selection, characterOptions, manualProjects, collectionTitle, currentSmartRule,
  albumsOpen, albumRoot, imageHeading, showImages, showOverview, showAllWorks, openCollection, editorOpen, editorTitle, editorRule,
  editing, saving, error: albumError, previewItems, previewCovers, syncPreviews, newSmartAlbum, editSmartAlbum, removeSmartAlbum, save: saveSmartAlbum } = useGalleryCollections(workspace)
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
const tagControls = ref<HTMLElement | null>(null)
async function filterByTag(tag: string) {
  closeViewer(); tagFilter.value = tag
  await nextTick(); tagControls.value?.querySelector<HTMLElement>('[aria-label="按标签筛选"]')?.focus()
}

const displayedCurrent = ref(current.value)
const displayedIndex = ref(viewerIndex.value)
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
