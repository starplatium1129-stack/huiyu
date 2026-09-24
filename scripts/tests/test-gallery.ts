'use strict';

const { test }: typeof import('node:test') = require('node:test');

test("Gallery tests passed: original ratios, masonry wall, immersive viewer with focus trap, lazy images and cleanup", () => {
/**
 * 作品册契约（Vue SPA 版本）
 *
 * 重构前断言 tools/gallery.html + gallery.js。两者已迁为 src/views/GalleryView.vue，
 * 这里保留同样的保障目标：
 *   1. 瀑布式展墙，保留每幅作品的完整原始构图（contain 而非 cover）
 *   2. 沉浸查看器可键盘导航、焦点可回、有无障碍标注
 *   3. 本地原图按需读取并及时释放 object URL
 *   4. 展墙图懒加载，查看器主图立即加载
 */

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const { artworkTimestamp, parseArtworkRecords }: typeof import('../../src/types/artwork.ts') = require('../../src/types/artwork.ts');

const view = read('src/composables/gallery/useGalleryWorkspace.ts') + '\n' + read('src/composables/gallery/galleryMutations.ts') + '\n' + read('src/composables/gallery/galleryStorage.ts') + '\n' + read('src/composables/gallery/useGalleryExports.ts') + '\n' + read('src/views/GalleryView.vue') + '\n' + read('src/assets/css/gallery-view.css');
const home = read('src/views/HomeView.vue');
const artworkTypes = read('src/types/artwork.ts');
const artworkRepository = read('src/storage/artworkRepository.ts');
const layout = read('src/components/AppLayout.vue');

assert.deepStrictEqual(
  parseArtworkRecords([null, {}, { id:'', prompt:'bad' }, { id:7, prompt:'ok' }]),
  [{ id:7, prompt:'ok' }],
  'persisted artwork parsing must reject malformed records without losing valid entries',
);
assert.strictEqual(
  artworkTimestamp({ id:42, timestamp:'not-a-date' }),
  42,
  'legacy artwork timestamps must fall back to numeric ids',
);

// ── 展墙：多列展墙 + 原始比例 ─────────────────────────────────────────────
// 2026-09-05 审计 P2-01：展墙实现已随 dff0c6e2 改为等高行 grid 铺排
// （repeat(var(--wall-cols)) 保持时间顺序、横竖混排零空洞），断言同步新契约。
assert(
  view.includes('gallery-wall') && view.includes('grid-template-columns: repeat(var(--wall-cols, 4), minmax(0, 1fr))'),
  'gallery must use a responsive multi-column exhibition wall (grid row-fill)',
);
assert(
  view.includes('object-fit:contain'),
  'artwork must preserve the complete original composition',
);
assert(
  !/\.artwork-image\s*\{[^}]*object-fit:cover/.test(view),
  'artwork images must not be cropped with object-fit:cover',
);
assert(
  view.includes('--art-ratio') && view.includes('ratioOf'),
  'gallery must honor each artwork aspect ratio',
);

// ── 沉浸查看器 ────────────────────────────────────────────────────────────
assert(
  view.includes('art-viewer') && view.includes('aria-label="作品观赏模式"'),
  'gallery must provide an accessible immersive viewer',
);
assert(
  view.includes('aria-modal="true"'),
  'immersive viewer must be marked as a modal dialog',
);
assert(
  view.includes("'ArrowLeft'") && view.includes("'ArrowRight'"),
  'immersive viewer must support keyboard navigation',
);
// 焦点管理已抽成 useFocusTrap（原先 6 个弹层里只有这里做对了）。
// 断言视图接上了它，而不是再手写一份。
assert(
  /useFocusTrap\(\s*viewerEl/.test(view),
  'immersive viewer must use the shared useFocusTrap composable',
);
assert(
  /onEscape:\s*closeViewer/.test(view),
  'immersive viewer must close on Escape via useFocusTrap',
);
assert(
  /initialFocus:\s*closeBtn/.test(view),
  'immersive viewer must move focus into the dialog on open',
);
assert(
  /useFocusTrap\(\s*infoEl/.test(view) && /initialFocus:\s*infoCloseBtn/.test(view),
  'narrow artwork info must open as a nested focus trap on its visible close control',
);
assert(
  view.includes(':inert="infoDrawerHidden"')
    && view.includes(':aria-hidden="infoDrawerHidden ? \'true\' : undefined"')
    && view.includes('关闭信息'),
  'closed narrow artwork info must be hidden from focus and assistive technology',
);
assert(
  view.includes('background:var(--bg-deep)') && view.includes('background-image:linear-gradient(var(--art-scrim),var(--art-scrim))'),
  'narrow artwork info must use an opaque theme surface',
);

// composable 本身必须真的实现陷阱与焦点还原
const trap = read('src/composables/useFocusTrap.ts');
assert(
  trap.includes("event.key !== 'Tab'") && trap.includes('shiftKey'),
  'useFocusTrap must implement a real Tab cycle',
);
assert(
  /returnFocus\.value(?:\?\.)?\.?focus(?:\?\.)?\(/.test(trap),
  'useFocusTrap must restore focus to the opener on close',
);
assert(
  trap.includes("classList.add('overlay-open')") && trap.includes("classList.remove('overlay-open')"),
  'useFocusTrap must lock and unlock background scroll',
);

// ── 本地原图读取与释放 ────────────────────────────────────────────────────
assert(
  view.includes('imgGet'),
  'gallery must load local originals from the image store',
);
assert(
  view.includes('revokeAll') || view.includes('revokeObjectURL'),
  'gallery must release object URLs to avoid leaking blobs',
);
assert(
  view.includes('requestCardHydration') && view.includes('IntersectionObserver'),
  'gallery must hydrate card images lazily (viewport-driven) rather than eagerly decoding everything',
);
assert(
  view.includes('viewerLoadToken') && view.includes('unmounted'),
  'gallery async image loads must not write stale URLs after navigation or unmount',
);
// 2026-09-05 审计 P2-01：删除已升级为回收站软删（softDeleteArtwork，30 天可恢复），
// 硬删 deleteArtwork 退役为仓储内部 purge 路径；断言从旧硬删 API 同步到软删契约。
assert(
  view.includes('artworkRepository.softDeleteArtwork') && !view.includes('imgDelete('),
  'gallery deletion must go through the repository soft-delete (trash) path instead of deleting media piecemeal',
);
assert(
  artworkRepository.includes('rollbackErrors') && artworkRepository.includes('thumbnailSnapshot'),
  'artwork repository must expose snapshot-based compensation for cross-store deletion',
);
assert(
  home.includes('Promise.all') && home.includes('unmounted'),
  'home cover hydration must be awaited and guarded against component unmount',
);
assert(
  view.includes('parseArtworkRecords') && home.includes('parseArtworkRecords')
    && artworkTypes.includes('interface ArtworkRecord'),
  'home and gallery must share one typed compatibility boundary for persisted artwork',
);
assert(
  !/\bany\b/.test(view) && !/\bany\b/.test(home),
  'home and gallery persistence, scene, event, and image lifecycles must stay explicitly typed',
);

// ── 图片加载策略 ──────────────────────────────────────────────────────────
assert(
  /class="artwork-image"[\s\S]{0,200}loading="lazy"/.test(view),
  'wall images must lazy-load',
);
// 2026-08-22 起查看器改由 ZoomableImageViewer 渲染（平滑视口缩放）：
// 契约不变——选中作品必须立即加载（组件内部 img 不得带 loading="lazy"），
// 且画廊必须把 viewerUrl 直接交给该组件。
assert(
  /<ZoomableImageViewer[\s\S]{0,200}:src="viewerUrl"/.test(view)
    && !/loading="lazy"/.test(read('src/components/visual/ZoomableImageViewer.vue').split('<template')[1].split('</template>')[0]),
  'the selected artwork must load eagerly (no lazy attribute)',
);

// ── 无障碍骨架由 AppLayout 提供 ───────────────────────────────────────────
assert(
  layout.includes('skip-link') && layout.includes('id="main"'),
  'shared layout must expose a skip link and main landmark for the gallery',
);

});
