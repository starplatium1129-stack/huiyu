<template>
  <article class="gallery-shell gallery-page" ref="shellEl">
    <header class="gallery-intro">
      <div>
        <div class="gallery-kicker">HUIYU / PRIVATE COLLECTION</div>
        <h1 class="gallery-title">我的作品</h1>
        <p class="gallery-subtitle">收藏每一次心动，让灵感从这里继续。</p>
      </div>
      <RouterLink class="btn btn-primary gallery-create" to="/prompt-builder">
        <ArchiveIcon name="spark" />新建创作
      </RouterLink>
    </header>

    <div class="gallery-toolbar sticky-toolbar" aria-label="作品筛选" data-reveal>
      <div class="gallery-browse-controls" role="group" aria-label="浏览作品">
      <button class="gallery-filter" :class="{ active: !favoriteOnly && !trashMode }" type="button"
        :aria-pressed="!favoriteOnly && !trashMode" @click="favoriteOnly = false; trashMode && toggleTrashMode()">全部作品</button>
      <button class="gallery-filter" :class="{ active: favoriteOnly && !trashMode }" type="button" :aria-pressed="favoriteOnly && !trashMode" @click="favoriteOnly = trashMode || !favoriteOnly; trashMode && toggleTrashMode()">
        <ArchiveIcon name="love" /> 收藏 {{ favoriteCount }}
      </button>
      </div>
      <!--
        展墙搜索（2026-08-30 UX 审计 P1）：攒到几百张之后，「找某一张旧作」是
        最高频也最痛苦的动作，此前只能靠翻。检索范围含场景名、角色、当时写的
        故事与完整 prompt——很多旧作只记得里面出现过某个词。
      -->
      <div class="gallery-search-field">
        <input ref="searchInput" v-model="searchQuery" type="search" class="gallery-search" aria-label="搜索作品"
          placeholder="搜场景、角色或关键词…" />
        <button v-if="searchQuery" class="gallery-search-clear" type="button" aria-label="清空搜索" @click="searchQuery = ''; searchInput?.focus()">×</button>
      </div>
      <select v-model="projectFilter" class="gallery-project" aria-label="按项目筛选">
        <option value="">全部项目</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.title }}</option>
      </select>
      <!--
        多选（2026-08-30 UX 审计 P1）：清 500 张废稿原本要点约 1500 次（每张进大图
        → 点删除 → 再确认）。删除已改软删可撤销，批量删的风险随之降到可接受。
      -->
      <div class="gallery-manage-controls" role="group" aria-label="管理作品">
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
    <div class="gallery-summary" aria-live="polite">
      <span class="gallery-count">{{ trashMode ? `回收站 · ${trashItems.length} 幅作品` : countLabel }}</span>
      <span class="gallery-toolbar-note">{{ trashMode ? '删除的作品保留 30 天，可随时恢复' : selectMode ? '选择作品后，可对比挑选或批量移入回收站' : '点作品欣赏原图，或沿用配方继续创作' }}</span>
    </div>

    <div v-if="selectMode" class="gallery-bulkbar" role="region" aria-label="批量操作">
      <span class="gallery-bulk-count" aria-live="polite">已选 {{ selectedIds.size }} / {{ visible.length }}</span>
      <span class="gallery-bulk-actions">
        <button class="btn btn-primary btn-sm" type="button" :disabled="selectedIds.size < 2 || selectedIds.size > 4" @click="compareSelected">对比挑选（2–4 张）</button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="!visible.length"
          @click="selectAllVisible">{{ allVisibleSelected ? '取消全选' : '全选当前' }}</button>
        <button class="btn btn-danger btn-sm" type="button" :disabled="!selectedIds.size || bulkDeleting"
          @click="bulkDelete">{{ bulkDeleting ? '处理中…' : `移入回收站（${selectedIds.size}）` }}</button>
        <button class="btn btn-ghost btn-sm" type="button" @click="toggleSelectMode">完成</button>
      </span>
    </div>

    <CandidateCompare :open="compareOpen" :items="compareItems" @close="compareOpen = false" @changed="loadGalleryStorage" />
    <section aria-live="polite" data-reveal data-reveal-delay="1">
      <!-- 回收站视图（2026-08-31）：列出软删条目，可逐条恢复；30 天超期自动清理 -->
      <div v-if="trashMode" class="trash-wall" :style="{ '--wall-cols': columnCount }">
        <div class="trash-toolbar">
          <span class="trash-hint">软删保留 30 天，超期自动清理；点「恢复」放回展墙</span>
          <span class="trash-count" aria-live="polite">{{ trashItems.length }} 条</span>
        </div>
        <template v-if="trashItems.length">
          <article
            v-for="entry in trashItems"
            :key="entry.id"
            class="artwork trash-card"
            :class="{ 'artwork-pending': trashBusy === entry.id }"
          >
            <div class="artwork-media" style="--art-ratio: 1">
              <img
                v-if="trashThumbs[entry.id]"
                class="artwork-image"
                :src="trashThumbs[entry.id]"
                :alt="trashPrompt(entry)"
                loading="lazy"
                decoding="async"
              />
              <div v-else class="artwork-placeholder"><ArchiveIcon name="image" /></div>
            </div>
            <div class="artwork-caption">
              <span class="artwork-name truncate">{{ trashPrompt(entry) }}</span>
              <span class="artwork-date">删除于 {{ formatTrashTime(entry.deletedAt) }}</span>
            </div>
            <div class="artwork-tools">
              <button class="artwork-tool" type="button" :disabled="trashBusy === entry.id"
                :aria-label="`恢复作品：${trashPrompt(entry)}`" title="恢复放回展墙"
                @click="restoreTrashItem(entry.id)">
                <ArchiveIcon name="spark" /><span>{{ trashBusy === entry.id ? '恢复中…' : '恢复' }}</span>
              </button>
            </div>
          </article>
        </template>
        <ArchiveStatePanel v-else kind="empty" title="回收站是空的"
          message="删除的作品会在这里保留 30 天，随时可以恢复。" />
      </div>
      <template v-else>
      <ArchiveStatePanel
        v-if="galleryLoading"
        class="gallery-loading-wall"
        kind="loading"
        title="正在读取本地作品档案"
        message="先建立展墙结构，再逐张解码原图。"
      />
      <ArchiveStatePanel
        v-else-if="galleryError"
        kind="error"
        title="本地作品档案读取失败"
        :message="galleryError"
      >
        <button class="btn btn-primary" type="button" @click="loadGalleryStorage">重新读取</button>
      </ArchiveStatePanel>
      <ArchiveStatePanel
        v-else-if="!history.length"
        kind="empty"
        title="展墙还在等你的第一幅作品"
        message="画好之后，它会按自己的横竖比例住进来。作品只存在这台电脑，参数不挡画面。"
      >
        <RouterLink class="btn btn-primary" to="/prompt-builder">开始绘制</RouterLink>
      </ArchiveStatePanel>
      <ArchiveStatePanel
        v-else-if="!visible.length"
        kind="filtered"
        title="当前筛选下没有作品"
        message="作品仍在本地档案中，清空搜索或重置收藏 / 项目筛选即可重新显示。"
      >
        <button class="btn btn-primary" type="button" @click="resetGalleryFilters">重置筛选</button>
      </ArchiveStatePanel>
      <div v-else class="gallery-wall stagger-container">
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
                    <button class="artwork-tool" type="button"
                      :class="{ 'artwork-tool-on': item.favorite }"
                      :aria-pressed="!!item.favorite"
                      :aria-label="`${item.favorite ? '取消收藏' : '收藏'}：${sceneTitle(item.scene, item)}`"
                      title="收藏后可在顶部按「收藏」筛选"
                      @click="toggleFavorite(item)">
                      <ArchiveIcon name="love" /><span>{{ item.favorite ? '已收藏' : '收藏' }}</span>
                    </button>
                    <RouterLink class="artwork-tool" :to="`/prompt-builder?remix=${encodeURIComponent(item.id || '')}`" title="以此作品配方回填创作台">
                      <ArchiveIcon name="spark" /><span>沿用配方</span>
                    </RouterLink>
                    <button class="artwork-tool danger" type="button"
                      :aria-label="`删除作品：${sceneTitle(item.scene, item)}`"
                      title="删除作品"
                      @click="pendingDeleteId = item.id">
                      <ArchiveIcon name="close" /><span>删除</span>
                    </button>
                  </template>
                </div>
                <button
                  class="artwork-button"
                  type="button"
                  :aria-pressed="selectMode ? selectedIds.has(item.id) : undefined"
                  :aria-label="selectMode
                    ? `${selectedIds.has(item.id) ? '取消选择' : '选择'}作品：${sceneTitle(item.scene, item)}`
                    : `欣赏作品：${sceneTitle(item.scene, item)}`"
                  @click="selectMode ? toggleSelect(item.id) : openViewer(indexOf(item))"
                >
                  <div class="artwork-media" :style="{ '--art-ratio': String(ratioOf(item)) }">
                    <!-- 底层：缩略图垫底（HD 就绪前先出图，也避免 LRU 淘汰 HD 后回退成骨架屏） -->
                    <img
                      v-if="thumbUrls[item.id]"
                      class="artwork-image"
                      :src="thumbUrls[item.id]"
                      :alt="sceneTitle(item.scene, item)"
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      @load="measure(item, $event)"
                    />
                    <!-- 上层：HD 原图，解码完成后淡入覆盖缩略图，消除「闪一下变高清」的硬切 -->
                    <img
                      v-if="cardUrls[item.id]"
                      class="artwork-image artwork-image-hd"
                      :src="cardUrls[item.id]"
                      :alt="sceneTitle(item.scene, item)"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      @load="onHdLoad(item, $event)"
                    />
                    <div v-if="!cardUrls[item.id] && !thumbUrls[item.id] && missingImageIds.has(item.id)" class="artwork-placeholder"><ArchiveIcon name="image" /></div>
                    <div v-else-if="!cardUrls[item.id] && !thumbUrls[item.id]" class="artwork-skeleton" aria-hidden="true"></div>
                  </div>
                    <div class="artwork-caption">
                      <span class="artwork-caption-copy">
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

    <!-- 沉浸查看器（Teleport 渲染到 body；放在根元素内保持单根，
         否则多根组件不会继承 AppLayout 注入的 route-view class） -->
    <Teleport to="body">
      <FluidTransition>
        <div
          v-show="viewerIndex >= 0"
          class="art-viewer"
          :class="{ open: viewerIndex >= 0, 'info-open': infoOpen }"
          role="dialog"
          aria-modal="true"
          :aria-hidden="viewerIndex >= 0 ? 'false' : 'true'"
          aria-label="作品观赏模式"
          ref="viewerEl"
        >
      <section class="viewer-stage" @click.self="infoOpen = false">
        <button class="viewer-close viewer-close-on-art" type="button" aria-label="关闭" @click="closeViewer" ref="closeBtn">×</button>
        <button class="viewer-nav viewer-prev" type="button" aria-label="上一幅" :disabled="viewerIndex <= 0" @click="step(-1)">‹</button>
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
        <PhotoSwipeStage v-else-if="gestureViewer && viewerIndex >= 0" :items="visible" :index="viewerIndex" @change="openViewer" @error="gestureViewer = false" />
        <ZoomableImageViewer
          v-else-if="viewerUrl"
          :src="viewerUrl"
          :alt="current ? sceneTitle(current.scene, current) : ''"
        >
          <template #fallback>
            <div class="viewer-fallback"><ArchiveIcon name="image" /></div>
          </template>
        </ZoomableImageViewer>
        <div v-else class="viewer-fallback"><ArchiveIcon name="image" /></div>
        <button class="viewer-nav viewer-next" type="button" aria-label="下一幅" :disabled="viewerIndex >= visible.length - 1" @click="step(1)">›</button>
        <button v-if="hasComparableImage && viewerUrl" class="viewer-compare-toggle" :class="{ active: compareMode }" type="button" :aria-pressed="compareMode" :title="compareMode ? '退出对比' : '开启对比滑块'" @click="compareMode = !compareMode">
          <ArchiveIcon name="spark" /> 对比
        </button>
        <button class="viewer-info-toggle" type="button" aria-label="作品信息" :aria-expanded="infoOpen" @click="infoOpen = !infoOpen">i</button>
        <div class="viewer-position">{{ viewerIndex + 1 }} / {{ visible.length }}</div>
      </section>

      <aside class="viewer-info" v-if="displayedCurrent">
        <div class="viewer-kicker">Artwork {{ (viewerIndex >= 0 ? viewerIndex : displayedIndex) + 1 }}</div>
        <h2 class="viewer-title">{{ sceneTitle(displayedCurrent.scene, displayedCurrent) }}</h2>
        <div class="viewer-meta">
          {{ characterName(displayedCurrent.character, displayedCurrent) }} · {{ formatDate(stamp(displayedCurrent)) }} · v{{ displayedCurrent.version || 1 }}
        </div>
        <div class="viewer-story viewer-story-on-art">{{ displayedCurrent.story || '这幅作品还没有附加文字。' }}</div>
        <div class="viewer-facts">
          <div class="viewer-fact" v-for="f in facts" :key="f.label">
            <small>{{ f.label }}</small>
            <strong :title="f.value || '—'">{{ f.value || '—' }}</strong>
          </div>
        </div>
        <details class="viewer-details">
          <summary>创作参数与 Prompt</summary>
          <div class="viewer-prompt">{{ displayedCurrent.prompt || '未保存 Prompt' }}</div>
        </details>
        <div class="viewer-actions">
          <button class="btn btn-ghost" type="button" :aria-pressed="gestureViewer" @click="gestureViewer = !gestureViewer">{{ gestureViewer ? '返回原查看器' : '尝试手势观画' }}</button>
          <button class="btn btn-ghost" type="button"
            :class="{ 'btn-favorite-on': displayedCurrent.favorite }"
            :aria-pressed="!!displayedCurrent.favorite"
            @click="toggleFavorite(displayedCurrent)">
            <ArchiveIcon name="love" /><span>{{ displayedCurrent.favorite ? '取消收藏' : '收藏这幅' }}</span>
          </button>
          <RouterLink class="btn btn-primary" :to="`/prompt-builder?remix=${encodeURIComponent(displayedCurrent.id || '')}`"><ArchiveIcon name="spark" /> 沿用配方</RouterLink>
          <RouterLink class="btn btn-ghost" :to="`/prompt-builder?regen=${encodeURIComponent(displayedCurrent.id || '')}`">原参重跑</RouterLink>
          <button class="btn btn-ghost" type="button" @click="downloadCurrent">下载原图</button>
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
      </aside>
        </div>
      </FluidTransition>
    </Teleport>
  </article>

</template>

<script setup lang="ts">
import FluidTransition from "@/components/visual/FluidTransition.vue"
import { defineAsyncComponent, ref, watch } from 'vue'
const PhotoSwipeStage = defineAsyncComponent(() => import('@/components/gallery/PhotoSwipeStage.vue'))
const gestureViewer = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
import CandidateCompare from '@/components/gallery/CandidateCompare.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ImageCompareSlider from '@/components/visual/ImageCompareSlider.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import { useGalleryWorkspace } from "@/composables/gallery/useGalleryWorkspace"
const {
closeBtn,viewerEl,sentinelEl,shellEl,countLabel,
searchQuery,
favoriteOnly,
favoriteCount,
projectFilter,
projects,
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
closeViewer,
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
} = useGalleryWorkspace()

const displayedCurrent = ref(current.value)
const displayedIndex = ref(viewerIndex.value)
watch(current, value => {
  if (value) {
    displayedCurrent.value = value
    displayedIndex.value = viewerIndex.value
  }
}, { flush: 'sync' })
</script>

<style scoped src="@/assets/css/gallery-view.css"></style>


<style>
/* 非 scoped：Teleport 到 body 的查看器 */
.art-viewer { position:fixed; inset:0; z-index:var(--z-overlay); display:grid; grid-template-columns:minmax(0,1fr) minmax(290px,360px); background:var(--art-backdrop); color:var(--on-art-primary); }
.art-viewer.layer-pop-enter-active,
.art-viewer.layer-pop-leave-active { transition:opacity var(--motion-surface) var(--ease-out); }
.art-viewer.layer-pop-enter-active > .viewer-stage,
.art-viewer.layer-pop-leave-active > .viewer-stage { transition:transform var(--motion-surface) var(--ease-out),opacity var(--motion-surface) var(--ease-out); }
.art-viewer.layer-pop-enter-from,
.art-viewer.layer-pop-leave-to { opacity:0; }
.art-viewer.layer-pop-enter-from > .viewer-stage { transform:scale(.985); opacity:0; }
.art-viewer.layer-pop-leave-to > .viewer-stage { transform:scale(.98); opacity:0; }
.viewer-compare-host { width:100%; height:calc(100vh - 120px); max-width:min(90vw, 1200px); display:flex; align-items:center; justify-content:center; }
.viewer-compare-toggle {
  position:absolute; z-index:var(--z-raised); top:18px; right:64px;
  display:inline-flex; align-items:center; gap:4px;
  padding:6px 12px; border-radius:var(--r-pill);
  border:1px solid var(--on-art-line); background:var(--art-scrim);
  color:var(--on-art-primary); cursor:pointer; font:600 var(--fs-label-xs) var(--font-mono);
  -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px);
  transition:background var(--motion-hover), border-color var(--motion-hover);
}
.viewer-compare-toggle:hover, .viewer-compare-toggle.active {
  border-color:var(--accent); background:color-mix(in srgb,var(--accent) 30%,var(--art-scrim)); color:var(--on-art-primary);
}
.viewer-stage { position:relative; min-width:0; display:grid; place-items:center; padding:clamp(46px,5vw,76px) clamp(48px,6vw,92px); overflow:hidden; }
.viewer-image { display:block; max-width:100%; max-height:calc(100vh - 92px); width:auto; height:auto; object-fit:contain; filter:drop-shadow(0 24px 56px var(--art-backdrop)); animation:galleryImageIn .35s var(--ease-out); }
.viewer-fallback { color:var(--on-art-secondary); font-size:var(--fs-glyph-lg); }
.art-viewer .viewer-close { position:absolute; z-index:var(--z-raised); top:18px; left:18px; }
.viewer-nav,.viewer-info-toggle { position:absolute; z-index:var(--z-raised); display:grid; place-items:center; border:1px solid var(--on-art-line); background:var(--art-scrim); color:var(--on-art-primary); cursor:pointer; -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); transition:background var(--motion-hover),transform var(--motion-hover); }
.viewer-info-toggle { top:18px; right:18px; width:40px; height:40px; border-radius:50%; display:none; }
.viewer-nav { top:50%; width:44px; height:64px; border-radius:var(--r-pill); transform:translateY(-50%); font-size:var(--fs-title); }
.viewer-nav:hover,.viewer-info-toggle:hover { background:color-mix(in srgb,var(--accent) 58%,var(--art-scrim)); }
.viewer-prev { left:var(--s-4); }
.viewer-next { right:var(--s-4); }
/* 审计修复: .24 远低于 UI 组件 3:1 门槛 */
.viewer-nav:disabled { color: var(--text-disabled); border-color: var(--border-soft); cursor:default; }
.viewer-position { position:absolute; left:50%; bottom:18px; transform:translateX(-50%); color:var(--on-art-secondary); font:650 var(--fs-mono-xs) var(--font-mono); letter-spacing:.12em; }
.viewer-info { min-width:0; overflow-y:auto; padding:56px var(--s-5) var(--s-6); border-left:1px solid var(--on-art-line); background:var(--art-scrim); }
.viewer-title { margin:var(--s-3) 0 var(--s-1); color:var(--on-art-primary); font-size:var(--fs-title); line-height:var(--lh-tight); }
.art-viewer .viewer-kicker { color:var(--on-art-secondary); }
.viewer-meta { color:var(--on-art-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); }
.viewer-facts { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-2); margin-bottom:var(--s-5); }
.viewer-fact { min-width:0; padding:var(--s-2); border:1px solid var(--on-art-line); border-radius:var(--r-md); background:var(--on-art-fill); }
.viewer-fact small,.viewer-fact strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.viewer-fact small { color:var(--on-art-secondary); font-size:var(--fs-mono-xs); text-transform:uppercase; letter-spacing:.08em; }
.viewer-fact strong { margin-top:var(--s-1); color:var(--on-art-primary); font-size:var(--fs-label-xs); }
.viewer-details { margin:0 0 var(--s-5); border-top:1px solid var(--on-art-line); }
.viewer-details summary { padding:var(--s-3) 0; color:var(--on-art-secondary); font-size:var(--fs-label-xs); cursor:pointer; }
.art-viewer .viewer-actions .btn-ghost { color:var(--on-art-primary); border-color:var(--on-art-line); background:var(--art-scrim); }
.art-viewer .viewer-actions .btn-danger { color:var(--on-art-primary); }
.viewer-prompt { max-height:220px; overflow:auto; padding:var(--s-3); border-radius:var(--r-md); background:var(--art-backdrop); color:var(--on-art-secondary); font:400 var(--fs-mono-sm)/1.65 var(--font-mono); white-space:pre-wrap; word-break:break-word; }
@media (max-width:900px) {
  .art-viewer { grid-template-columns:1fr; }
  .viewer-stage { padding:60px 42px 78px; }
  .viewer-info { position:absolute; inset:0 0 0 auto; width:min(86vw,360px); transform:translateX(100%); transition:transform var(--motion-surface) var(--ease-drawer); z-index:var(--z-raised); }
  .art-viewer.info-open .viewer-info { transform:none; }
  .viewer-info-toggle { display:grid; }
}
@media (max-width:600px) {
  .viewer-stage { padding:58px 38px 76px; }
  .viewer-nav { width:36px; height:56px; }
  .viewer-prev { left:var(--s-2); }
  .viewer-next { right:var(--s-2); }
}
@media (prefers-reduced-motion:reduce) { .art-viewer,.viewer-info { transition:none !important; } }

</style>
