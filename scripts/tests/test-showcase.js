'use strict';

/**
 * 效果样张页契约（Vue SPA 版本）
 *
 * 重构前断言 tools/showcase.html + showcase.js 的 DOM 与内联样式。
 * 那两个文件已迁为 src/views/ShowcaseView.vue，这里保留同样的保障目标：
 *   1. 加载审核 manifest、链回导演台、缩略图懒加载
 *   2. R18 直接可筛选（不用二次确认弹窗），默认模糊
 *   3. 瀑布流保持每张图原始比例
 *   4. 服务端正确挂载并限制 scene-showcase 目录（真实 HTTP 断言）
 *   5. 实际产出的 manifest 与图片资产自洽
 *   6. scene/artist/popular/lora 四类条目、生成元数据与审核依据
 *
 * 顶层结构全部是独立 test()，扩展契约测试不依赖 AI 目录也存在；
 * 资产自洽测试在没有 AI 工作区时用 t.skip() 优雅跳过。
 */

const { test } = require('node:test');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('showcase source contract: view, router, nav, server allowlist, exporter wording', () => {
  const view = read('src/views/ShowcaseView.vue');
  const router = read('src/router/index.ts');
  const nav = read('src/components/AppNav.vue');
  const server = read('server.js');
  const showcaseBuilder = read('scripts/maintenance/build-scene-showcase.py');

  // ── 数据来源与跳转 ────────────────────────────────────────────────────────
  assert(
    view.includes("fetch('/scene-showcase/manifest.json'"),
    'showcase view must load the approved manifest',
  );
  assert(
    view.includes('showcaseDestination') && read('src/utils/showcaseDestination.ts').includes('/prompt-builder?scene='),
    'approved scene samples must link back to the director',
  );
  assert(view.includes('loading="lazy"'), 'sample thumbnails must lazy-load');
  assert(
    view.includes('parseShowcaseManifest'),
    'showcase data must pass through the typed production parser',
  );
  assert(
    view.includes('viewerVersion') && !view.includes('t=${Date.now()}'),
    'viewer URLs must stay stable across unrelated reactive renders',
  );
  assert(
    view.includes('manifestController.abort()'),
    'manifest loading must be cancelled when the view unmounts',
  );
  assert(
    view.includes('brokenThumbs') && view.includes('viewerImageFailed'),
    'thumbnail and viewer image failures must render explicit fallbacks',
  );
  assert(!/\bany\b/.test(view), 'ShowcaseView must not regress to explicit any types');

  // ── R18 处理：可直接筛选 + 默认模糊，不要确认弹窗 ─────────────────────────
  assert(
    view.includes("{ v:'R18', l:'R18' }"),
    'R18 must be directly filterable',
  );
  assert(
    view.includes('.sample-r18 .sample-image { filter:blur('),
    'R18 thumbnails must be blurred by default',
  );
  assert(
    view.includes('sample-r18') && view.includes('sample-sensitive'),
    'R18 cards must render the blur treatment and content label',
  );
  assert(
    !/window\.confirm|\bconfirm\(/.test(view),
    'R18 browsing must not require a confirmation dialog',
  );

  // ── 画面比例：Grid 网格（2026-08-15 由 columns 瀑布流改为 Grid，修正
  //  columns 先填满一列的填序问题）+ 自适应高度 ────────────────────────────────
  assert(
    view.includes('.showcase-grid { display:grid')
      && /grid-template-columns:repeat\(4/.test(view),
    'sample wall must use the 4-up grid layout (columns→grid, 2026-08-15)',
  );
  assert(
    /\.sample-image \{[^}]*width:100%[^}]*height:auto/.test(view),
    'sample wall must preserve each image aspect ratio',
  );

  // ── 查看器必须脱离 scoped 样式（Teleport 到 body） ────────────────────────
  assert(
    view.includes('showcase-viewer'),
    'viewer must use a dedicated class so teleported markup keeps its styles',
  );
  assert(
    /<style>\s*[\s\S]*\.showcase-viewer/.test(view),
    'teleported viewer styles must live in a non-scoped <style> block',
  );

  // ── 导航与路由 ────────────────────────────────────────────────────────────
  assert(
    router.includes("path: 'showcase'") && router.includes('ShowcaseView.vue'),
    'router must expose the showcase route',
  );
  assert(
    nav.includes("id: 'showcase'") && nav.includes("to: '/showcase'"),
    'global navigation must expose the showcase',
  );

  // ── 服务端资产挂载 ────────────────────────────────────────────────────────
  assert(server.includes("app.use('/scene-showcase'"), 'server must mount showcase assets');
  assert(
    server.includes('SCENE_SHOWCASE_DIR') && server.includes('showcase-assets') && server.includes('isShowcaseAssetPath'),
    'server must resolve the showcase dir and delegate allowlisting to the shared module',
  );

  // ── 导出脚本保持"直接模糊浏览"的措辞 ─────────────────────────────────────
  assert(
    showcaseBuilder.includes('data-rating="R18"') && showcaseBuilder.includes('R18 默认模糊'),
    'generated showcase exports must keep the direct blurred R18 experience',
  );
  assert(
    !showcaseBuilder.includes('R18 默认隐藏') && !showcaseBuilder.includes('显示 R18'),
    'generated showcase exports must not restore the old R18 reveal copy',
  );
});

test('showcase manifest normalizes entries and fails closed on garbage', () => {
  const { parseShowcaseManifest } = require('../../src/utils/showcaseManifest.ts');

  const normalizedManifest = parseShowcaseManifest({
    entries: [
      { id: 'sc010', title: 'Ten', char: 'nene', rating: 'R15', attempt: '2.9' },
      null,
      { id: 'sc002', title: 'Two', char: 'triad', rating: 'All', story: 'Story' },
      { id: 'sc002', title: 'Duplicate', char: 'natsume', rating: 'R18' },
      { id: '', title: 'Invalid', char: 'nene', rating: 'All' },
    ],
  });
  assert.deepStrictEqual(
    normalizedManifest.entries.map(entry => entry.id),
    ['sc002', 'sc010'],
    'manifest parsing must discard malformed and duplicate entries, then sort numeric ids',
  );
  assert.strictEqual(normalizedManifest.entries[1].attempt, 2, 'attempts must normalize to integers');
  assert.deepStrictEqual(
    normalizedManifest.counts,
    { All: 1, R15: 1, R18: 0 },
    'missing manifest counts must be derived from accepted entries',
  );
  assert.strictEqual(normalizedManifest.sceneCount, 2, 'missing scene count must use accepted entries');
  assert.strictEqual(normalizedManifest.entryCount, 2, 'entryCount must equal accepted entries');
  assert.deepStrictEqual(normalizedManifest.typeCounts, { scene: 2, artist: 0, popular: 0, lora: 0 });
  assert.throws(
    () => parseShowcaseManifest({ entries: [{ id: 'broken' }] }),
    /manifest/,
    'a non-empty manifest with no valid entries must fail closed',
  );
});

test('showcase manifest extended contract: scene/artist/popular/lora entries with metadata, provenance and counts', () => {
  const assert = require('assert');
  const { parseShowcaseManifest } = require('../../src/utils/showcaseManifest.ts');

  const mixed = parseShowcaseManifest({
    entries: [
      { id: 'sc001', title: '放学后的等待', char: 'nene', rating: 'All', attempt: 1 },
      {
        id: 'pc_raiden_shogun',
        title: '雷电将军',
        char: 'raiden_shogun',
        rating: 'All',
        attempt: 1,
        type: 'popular',
        displayName: '雷电将军 (Genshin Impact)',
        image: 'images/pc_raiden_shogun.png',
        thumb: 'thumbs/pc_raiden_shogun.jpg',
        meta: { engine: 'anima', checkpoint: 'anima-aesthetic-v1.1.safetensors', seed: '12345.9' },
      },
      {
        id: 'artist_bunbun',
        title: 'Bunbun',
        char: 'bunbun',
        rating: 'All',
        attempt: 2,
        type: 'artist',
        meta: { engine: 'sd', checkpoint: 'x.safetensors', seed: 7 },
        prompt: '1girl, bunbun',
        negative: 'bad anatomy',
        provenance: {
          batch: 'artist',
          key: 'artist:bunbun',
          recordId: 'artist:bunbun@attempt-2',
          review: { verdict: 'pass', recordId: 'artist:bunbun@attempt-2', notes: 'ok', reviewedAt: '2026-08-12T00:00:00.000Z' },
        },
      },
      {
        id: 'lora_nene_sd_closeup',
        title: '宁宁 近景',
        char: 'nene',
        rating: 'All',
        attempt: 1,
        type: 'lora',
        meta: { engine: 'sd', loraId: 'L_NENE_V18_WD14', loraVersion: '1.8.0' },
      },
    ],
  });
  assert.strictEqual(mixed.entries.length, 4, 'scene/artist/popular/lora entries must all parse');
  assert.strictEqual(mixed.sceneCount, 1, 'sceneCount counts only scene entries');
  assert.strictEqual(mixed.entryCount, 4, 'entryCount counts all entries');
  assert.deepStrictEqual(mixed.typeCounts, { scene: 1, artist: 1, popular: 1, lora: 1 });
  assert.deepStrictEqual(mixed.counts, { All: 4, R15: 0, R18: 0 }, 'counts run across all entries');

  const scene = mixed.entries.find(entry => entry.id === 'sc001');
  assert.strictEqual(scene.type, 'scene', 'missing type must default to scene');
  assert.strictEqual(scene.meta, undefined, 'scene without meta stays metadata-free');

  const popular = mixed.entries.find(entry => entry.id === 'pc_raiden_shogun');
  assert.strictEqual(popular.type, 'popular');
  assert.strictEqual(popular.char, 'raiden_shogun', 'popular char is a free-form character id');
  assert.strictEqual(popular.displayName, '雷电将军 (Genshin Impact)');
  assert.strictEqual(popular.image, 'images/pc_raiden_shogun.png');
  assert.strictEqual(popular.thumb, 'thumbs/pc_raiden_shogun.jpg');
  assert.deepStrictEqual(
    popular.meta,
    { engine: 'anima', checkpoint: 'anima-aesthetic-v1.1.safetensors', seed: 12345 },
    'meta must keep only present fields and truncate seed to integer',
  );

  const artist = mixed.entries.find(entry => entry.id === 'artist_bunbun');
  assert.strictEqual(artist.type, 'artist');
  assert.strictEqual(artist.attempt, 2, 'artist entry keeps its attempt');
  assert.strictEqual(artist.prompt, '1girl, bunbun', 'prompt is preserved for audit');
  assert.strictEqual(artist.negative, 'bad anatomy');
  assert.deepStrictEqual(artist.provenance, {
    batch: 'artist',
    key: 'artist:bunbun',
    recordId: 'artist:bunbun@attempt-2',
    review: { verdict: 'pass', recordId: 'artist:bunbun@attempt-2', notes: 'ok', reviewedAt: '2026-08-12T00:00:00.000Z' },
  }, 'provenance carries the review reference');

  const lora = mixed.entries.find(entry => entry.id === 'lora_nene_sd_closeup');
  assert.strictEqual(lora.type, 'lora');
  assert.deepStrictEqual(lora.meta, { engine: 'sd', loraId: 'L_NENE_V18_WD14', loraVersion: '1.8.0' });

  // 元数据部分字段缺省：不存在的 key 不进入对象，空对象视为无 meta。
  const partial = parseShowcaseManifest({
    entries: [
      {
        id: 'pc_miku', title: '初音未来', char: 'hatsune_miku', rating: 'All',
        type: 'popular', meta: { loraId: 'L_NENE_V20_ANIMA', loraVersion: '20b' },
      },
      { id: 'pc_empty', title: '空', char: 'nene', rating: 'All', type: 'popular', meta: {} },
    ],
  }).entries;
  const partialMiku = partial.find(entry => entry.id === 'pc_miku');
  const partialEmpty = partial.find(entry => entry.id === 'pc_empty');
  assert.deepStrictEqual(partialMiku.meta, { loraId: 'L_NENE_V20_ANIMA', loraVersion: '20b' });
  assert.strictEqual(partialEmpty.meta, undefined, 'empty meta object must be dropped');

  // 类型约束：scene 必须使用工作室角色；artist/popular/lora 必须有非空 char。
  assert.throws(() => parseShowcaseManifest({ entries: [{ id: 'scx', title: 'x', char: 'unknown', rating: 'All' }] }), /没有有效条目/);
  assert.throws(() => parseShowcaseManifest({ entries: [{ id: 'pcx', title: 'x', char: '', rating: 'All', type: 'popular' }] }), /没有有效条目/);
  assert.throws(() => parseShowcaseManifest({ entries: [{ id: 'ax', title: 'x', char: '', rating: 'All', type: 'artist' }] }), /没有有效条目/);
  assert.throws(() => parseShowcaseManifest({ entries: [{ id: 'lx', title: 'x', char: '', rating: 'All', type: 'lora' }] }), /没有有效条目/);
});

test('showcase view renders entry-type grouping, gated CTA, metadata and the mobile popular select', () => {
  const assert = require('assert');
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..', '..');
  const view = fs.readFileSync(path.join(root, 'src/views/ShowcaseView.vue'), 'utf8');

  // 类型分组复用现有 filter-pill 视觉语言。
  assert(view.includes("TYPE_OPTS = [{ v:'all', l:'全部类型' }"), 'type filter must group entries');
  assert(view.includes('typeFilter'), 'view must track the type filter');
  assert(view.includes("v-else-if=\"entry.type !== 'scene'\""), 'non-scene cards must get a type badge');
  assert(view.includes('sample-badge-type'), 'type badge needs distinct styling');

  // 移动端：热门角色并入统一的 char select（动态注入 popularCharOpts，不再单独补 18 个 pills）；
  // 搜索仍覆盖全部条目。2026-08-22 筛选器收敛重构后由 showcaseTypeSelect/showcaseCharSelect 承载。
  assert(view.includes('popularCharOpts'), 'popular characters must be derived for the select');
  assert(
    view.includes('id="showcaseTypeSelect"') && view.includes('id="showcaseCharSelect"')
      && view.includes('allCharOptions'),
    'type and character filters must render as unified selects',
  );
  assert(view.includes('全部热门角色'), 'select must have a clear-all option');
  assert(view.includes('charOpts'), 'char filter must keep the fixed studio pills');

  // 生成版本元数据：只渲染有值的字段。
  assert(view.includes('viewer-meta-gen'), 'viewer must render a generation metadata block');
  assert(view.includes('currentEntry.meta.engine'), 'engine meta row must be conditional');
  assert(view.includes('currentEntry.meta.checkpoint'), 'checkpoint meta row must be conditional');
  assert(view.includes('currentEntry.meta.loraId'), 'LoRA id meta row must be conditional');
  assert(view.includes('currentEntry.meta.seed !== undefined'), 'seed meta row must be conditional on presence');
  assert(view.includes('v-if="workspaceTarget"') && view.includes(':to="workspaceTarget.to"'), 'CTA must use the catalog-aware destination resolver');
  const destination = read('src/utils/showcaseDestination.ts');
  assert(destination.includes("entry.type === 'scene'") && destination.includes("entry.type === 'popular'"), 'scene and popular samples must resolve their own identities');
  assert(view.includes('overflow-wrap:anywhere'), 'long meta values must not overflow the viewer pills');

  // 热门角色样张的自定义资源路径（manifest 提供 image/thumb 时优先于 id 推导）。
  assert(view.includes('entry.thumb ?'), 'viewer thumbs must honour manifest-provided paths');
  assert(view.includes('entry.image ?'), 'viewer images must honour manifest-provided paths');

  // R18 模糊遮罩行为不能被新分组破坏。
  assert(view.includes('.sample-r18 .sample-image { filter:blur('), 'R18 thumbnails must stay blurred by default');
});

test('showcase asset allowlist rejects traversal, absolute urls, backslashes and stray paths', () => {
  const assert = require('assert');
  const { isShowcaseAssetPath } = require('../../server/showcase-assets.js');

  const allowed = [
    '/manifest.json',
    '/00-cover.jpg',
    '/README.txt',
    '/home/nene.jpg',
    '/home/natsume.jpg',
    '/images/sc001.jpg',
    '/images/sc001.png',
    '/images/sc001.webp',
    '/images/artist_bunbun.jpg',
    '/images/artist_so-bin.webp',
    '/images/pc_emilia_rezero.png',
    '/images/pc_miku.jpg',
    '/images/lora_nene_sd_closeup.jpg',
    '/images/lora_natsume_anima_fullbody.webp',
    '/thumbs/artist_bunbun.jpg',
    '/thumbs/pc_emilia_rezero.png',
    '/thumbs/lora_nene_sd_closeup.jpg',
    '/sheets/01-all/sc001-sc012.jpg',
  ];
  for (const item of allowed) {
    assert.strictEqual(isShowcaseAssetPath(item), true, `allowed path must pass: ${item}`);
  }

  const blocked = [
    // 任意路径 / 不在前缀内的文件名 / 非法扩展名
    '/config.json',
    '/home-hero.json',
    '/images/sc001.exe',
    '/images/foo.jpg',
    '/images/pc.txt',
    '/images/sc001',
    '/images/artist_.jpg',
    '/images/sc1234.jpg',
    '/images/pc_0.jpg/extra',
    '/home/nene.png',
    // 绝对 URL 与协议相对
    '//images/sc001.jpg',
    'http://evil.example/images/sc001.jpg',
    '/images/https:/sc001.jpg',
    // dot-dot 穿越（含编码）
    '/images/../manifest.json',
    '/images/%2e%2e/manifest.json',
    '/images/sc001.jpg/..',
    '/..',
    // 反斜杠 / query / hash / 编码
    '/images\\sc001.jpg',
    '/images/sc001.jpg?x=1',
    '/images/sc001.jpg#frag',
    '/images/sc001%2ejpg',
    // 目录形态与深层路径
    '/images/',
    '/images/sc001.jpg/pc_x.jpg',
    '/manifest.json/',
    '/sheets/01-all/..%2f.jpg',
    // 不带前导斜杠 / 非字符串
    'images/sc001.jpg',
    '',
  ];
  for (const item of blocked) {
    assert.strictEqual(isShowcaseAssetPath(item), false, `blocked path must be rejected: ${JSON.stringify(item)}`);
  }
  assert.strictEqual(isShowcaseAssetPath(null), false);
  assert.strictEqual(isShowcaseAssetPath(undefined), false);
});

test('showcase publish helper gates on manual review and builds per-batch entries', () => {
  const assert = require('assert');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const publish = require('../../scripts/maintenance/publish-showcase-refresh.js');

  // ── manual-review 结构校验 ─────────────────────────────────────────────────
  const review = publish.parseReviewData({
    version: 1,
    reviewedAt: '2026-08-12T00:00:00.000Z',
    records: {
      'popular:emilia_rezero': { verdict: 'pass', recordId: 'popular:emilia_rezero@attempt-2', notes: 'ok' },
      'artist:bunbun': { verdict: 'fail', recordId: 'artist:bunbun@attempt-2' },
    },
  });
  assert.strictEqual(review.version, 1);
  assert.strictEqual(review.records['popular:emilia_rezero'].verdict, 'pass');
  assert.strictEqual(
    review.records['popular:emilia_rezero'].reviewedAt,
    '2026-08-12T00:00:00.000Z',
    'top-level reviewedAt must be injected into every review entry',
  );
  assert.strictEqual(
    review.records['artist:bunbun'].reviewedAt,
    '2026-08-12T00:00:00.000Z',
    'fail verdicts carry the same reviewedAt',
  );
  assert.throws(() => publish.parseReviewData({ records: {} }), /version/, 'missing version must fail');
  assert.throws(() => publish.parseReviewData({ version: 1, reviewedAt: 'x' }), /records/, 'missing records must fail');
  assert.throws(
    () => publish.parseReviewData({ version: 1, reviewedAt: 'x', records: { k: { verdict: 'maybe' } } }),
    /verdict/,
    'unknown verdict must fail',
  );
  assert.throws(
    () => publish.parseReviewData({ version: 1, reviewedAt: 'x', records: { k: { verdict: 'pass' } } }),
    /recordId/,
    'pass without recordId must fail',
  );

  // 缺 manual-review.json 必须抛错（dry-run 也一样失败，绝不机械发布）。
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-showcase-review-'));
  try {
    assert.throws(() => publish.readReview(path.join(missingRoot, 'manual-review.json')), /manual review file missing/);
  } finally {
    fs.rmSync(missingRoot, { recursive: true, force: true });
  }

  // ── 计划映射：只发布明确 pass + recordId 对应 succeeded 记录 ──────────────
  const records = [
    {
      batch: 'popular', key: 'popular:emilia_rezero', subject: 'emilia_rezero',
      displayName: '爱蜜莉雅 (Re:Zero)', engine: 'anima', modelId: 'anima-aesthetic-v1.1',
      checkpoint: 'anima-aesthetic-v1.1.safetensors', loraId: '', seed: 11, attempt: 1,
      recordId: 'popular:emilia_rezero@attempt-1', status: 'succeeded',
      image: 'images/popular/popular_emilia_rezero.png', generatedAt: '2026-08-12T00:00:00.000Z',
    },
    {
      batch: 'popular', key: 'popular:emilia_rezero', subject: 'emilia_rezero',
      displayName: '爱蜜莉雅 (Re:Zero)', engine: 'anima', modelId: 'anima-aesthetic-v1.1',
      checkpoint: 'anima-aesthetic-v1.1.safetensors', loraId: '', seed: 14, attempt: 2,
      recordId: 'popular:emilia_rezero@attempt-2', status: 'succeeded',
      image: 'images/popular/popular_emilia_rezero_attempt-2.png', generatedAt: '2026-08-12T00:00:00.000Z',
    },
    {
      batch: 'artist', key: 'artist:bunbun', artistId: 'bunbun', displayName: 'Bunbun',
      engine: 'sd', modelId: 'waiIllustriousSDXL_v170', checkpoint: 'waiIllustriousSDXL_v170.safetensors',
      seed: 5, attempt: 2, recordId: 'artist:bunbun@attempt-2', status: 'failed', image: '',
    },
    {
      batch: 'latest-lora', key: 'latest-lora:nene:sd:closeup', characterId: 'nene',
      engine: 'sd', sceneId: 'closeup', displayName: '绫地宁宁 · 近景身份 · SD',
      modelId: 'waiIllustriousSDXL_v170',
      loraId: 'L_NENE_V18_WD14', checkpoint: 'waiIllustriousSDXL_v170.safetensors',
      seed: 9, attempt: 1, recordId: 'latest-lora:nene:sd:closeup@attempt-1', status: 'succeeded',
      image: 'images/latest-lora/latest-lora_nene_sd_closeup.png',
    },
  ];
  const plan = publish.planPublished(review, records);
  assert.deepStrictEqual(plan.additions.map(item => item.key), ['popular:emilia_rezero'],
    'only the pass record resolves to a published addition');
  assert.strictEqual(plan.additions[0].record.attempt, 2, 'the reviewed recordId picks the attempt');
  assert.deepStrictEqual(plan.rejected, ['artist:bunbun'], 'fail verdicts are rejected');
  assert.deepStrictEqual(plan.unreviewed, ['latest-lora:nene:sd:closeup'], 'succeeded but unreviewed keys are skipped');

  // 完整审核门禁：只要有 succeeded key 未审核就拒绝发布。
  assert.throws(() => publish.assertFullReviewCoverage(plan), /未审核/, 'unreviewed succeeded keys must fail the gate');
  const fullReview = publish.parseReviewData({
    version: 1,
    reviewedAt: '2026-08-12T00:00:00.000Z',
    records: {
      'popular:emilia_rezero': { verdict: 'pass', recordId: 'popular:emilia_rezero@attempt-2' },
      'artist:bunbun': { verdict: 'fail', recordId: 'artist:bunbun@attempt-2' },
      'latest-lora:nene:sd:closeup': { verdict: 'pass', recordId: 'latest-lora:nene:sd:closeup@attempt-1' },
    },
  });
  const fullPlan = publish.planPublished(fullReview, records);
  assert.strictEqual(fullPlan.unreviewed.length, 0, 'a complete review leaves nothing unreviewed');
  assert.strictEqual(publish.assertFullReviewCoverage(fullPlan), undefined, 'complete coverage passes the gate');

  // 重复 recordId 必须直接抛错，不能含糊指向其中一条。
  assert.throws(
    () => publish.planPublished(
      publish.parseReviewData({
        version: 1,
        reviewedAt: 'x',
        records: { 'popular:a': { verdict: 'pass', recordId: 'dup@attempt-1' } },
      }),
      [
        { batch: 'popular', key: 'popular:a', subject: 'a', recordId: 'dup@attempt-1', status: 'succeeded' },
        { batch: 'popular', key: 'popular:b', subject: 'b', recordId: 'dup@attempt-1', status: 'succeeded' },
      ],
    ),
    /duplicate recordId/,
    'duplicate candidate recordIds must fail',
  );

  assert.throws(
    () => publish.planPublished(review, [{ batch: 'popular', key: 'popular:x', recordId: 'popular:x@attempt-1', status: 'succeeded' }]),
    /review key not in candidate manifest/,
    'unknown review key must fail',
  );
  assert.throws(
    () => publish.planPublished(
      publish.parseReviewData({ version: 1, reviewedAt: 'x', records: { 'artist:bunbun': { verdict: 'pass', recordId: 'artist:bunbun@attempt-2' } } }),
      records,
    ),
    /not succeeded/,
    'pass pointing at a failed record must fail',
  );
  assert.throws(
    () => publish.planPublished(
      publish.parseReviewData({ version: 1, reviewedAt: 'x', records: { 'popular:emilia_rezero': { verdict: 'pass', recordId: 'popular:emilia_rezero@attempt-9' } } }),
      records,
    ),
    /not in candidate manifest/,
    'pass pointing at a nonexistent recordId must fail',
  );

  // ── 条目构造：稳定安全 ID + 生成元数据 + 审核依据 ─────────────────────────
  const loraVersions = { L_NENE_V18_WD14: '1.8.0' };
  const emilia = publish.entryForRecord(plan.additions[0], loraVersions);
  assert.strictEqual(emilia.entry.id, 'pc_emilia_rezero');
  assert.strictEqual(emilia.entry.type, 'popular');
  assert.strictEqual(emilia.entry.title, '爱蜜莉雅', 'title drops the (Franchise) suffix for card display');
  assert.strictEqual(emilia.entry.displayName, '爱蜜莉雅 (Re:Zero)');
  assert.strictEqual(emilia.entry.image, 'images/pc_emilia_rezero.jpg');
  assert.strictEqual(emilia.entry.thumb, 'thumbs/pc_emilia_rezero.jpg');
  assert.deepStrictEqual(emilia.entry.meta, {
    engine: 'anima', model: 'anima-aesthetic-v1.1',
    checkpoint: 'anima-aesthetic-v1.1.safetensors', seed: 14,
  });
  assert.strictEqual(emilia.entry.provenance.recordId, 'popular:emilia_rezero@attempt-2');
  assert.strictEqual(emilia.entry.provenance.review.verdict, 'pass');
  assert.strictEqual(emilia.entry.provenance.review.notes, 'ok');
  assert.strictEqual(
    emilia.entry.provenance.review.reviewedAt,
    '2026-08-12T00:00:00.000Z',
    'entry provenance must carry the real top-level reviewedAt',
  );

  const adultPopular = publish.entryForRecord({
    record: {
      batch: 'popular', key: 'popular:raiden_shogun:raiden_shogun_r18_bath',
      characterId: 'raiden_shogun', blueprintId: 'raiden_shogun_r18_bath', adult: true,
      displayName: '雷电将军 / 天守阁汤殿 (R18)', recordId: 'adult@attempt-1', attempt: 1,
    },
    review: { verdict: 'pass', recordId: 'adult@attempt-1', reviewedAt: 'x' },
    key: 'popular:raiden_shogun:raiden_shogun_r18_bath',
  }, {});
  assert.strictEqual(adultPopular.entry.id, 'pc_raiden_shogun_raiden_shogun_r18_bath');
  assert.strictEqual(adultPopular.entry.char, 'raiden_shogun');
  assert.strictEqual(adultPopular.entry.category, '成人');
  assert.strictEqual(adultPopular.entry.rating, 'R18');

  const artist = publish.entryForRecord({ record: records[2], review: review.records['artist:bunbun'], key: 'artist:bunbun' }, {});
  assert.strictEqual(artist.entry.id, 'artist_bunbun');
  assert.strictEqual(artist.entry.type, 'artist');
  assert.strictEqual(artist.entry.meta.loraId, undefined, 'artist entry carries no LoRA meta');

  const loraRec = records[3];
  const lora = publish.entryForRecord({ record: loraRec, review: { verdict: 'pass', recordId: loraRec.recordId, reviewedAt: 'x' }, key: loraRec.key }, loraVersions);
  assert.strictEqual(lora.entry.id, 'lora_nene_sd_closeup');
  assert.strictEqual(lora.entry.type, 'lora');
  assert.deepStrictEqual(lora.entry.meta, {
    engine: 'sd', model: 'waiIllustriousSDXL_v170', checkpoint: 'waiIllustriousSDXL_v170.safetensors',
    loraId: 'L_NENE_V18_WD14', loraVersion: '1.8.0', seed: 9,
  });

  const baseline = publish.entryForRecord({
    record: { batch: 'artist', key: 'artist:no-artist', artistId: '', displayName: 'no-artist baseline', engine: 'sd', seed: 1, attempt: 1 },
    review: { verdict: 'pass', recordId: 'artist:no-artist@attempt-1', reviewedAt: 'x' },
    key: 'artist:no-artist',
  }, {});
  assert.strictEqual(baseline.entry.id, 'artist_baseline', 'baseline artist becomes artist_baseline');

  // ── manifest 合并：sceneCount 只数场景，新增 entryCount/typeCounts，counts 跨全部条目 ──
  const merged = publish.buildManifest(
    {
      version: 3,
      sceneCount: 1,
      sourceAudit: '2026-07-30_v18_core',
      counts: { All: 1, R15: 0, R18: 0 },
      entries: [{ id: 'sc001', rating: 'All' }],
    },
    [emilia.entry, artist.entry, lora.entry],
    { sourceName: '2026-07-22_v14', publishedAt: '2026-08-12T00:00:00.000Z' },
  );
  assert.strictEqual(merged.version, 4, 'publish must bump the manifest version to 4');
  assert.strictEqual(merged.sceneCount, 1, 'sceneCount keeps the scene-entry meaning');
  assert.strictEqual(merged.entryCount, 4, 'entryCount counts every entry');
  assert.deepStrictEqual(merged.typeCounts, { scene: 1, artist: 1, popular: 1, lora: 1 });
  assert.deepStrictEqual(merged.counts, { All: 4, R15: 0, R18: 0 });
  assert.strictEqual(merged.source, '2026-07-22_v14');
  assert.strictEqual(merged.entries[0].type, 'scene', 'source scene entries get an explicit scene type');

  // 重复发布幂等：相同 id 的旧条目被替换而不是叠加。
  const mergedTwice = publish.buildManifest(merged, [emilia.entry], { sourceName: 'v', publishedAt: 'x' });
  assert.strictEqual(mergedTwice.entryCount, 4, 're-publishing the same id must dedupe');

  // ── 路径解析助手 ───────────────────────────────────────────────────────────
  const sourceRel = publish.sourcePathFor({ image: 'images/popular/popular_x.png' }, 'C:/cand/generation-manifest.json');
  assert.ok(sourceRel.endsWith(path.join('images', 'popular', 'popular_x.png')), 'source path resolves under the manifest dir');
  assert.throws(() => publish.sourcePathFor({ image: '' }, 'x'), /no image/);

  // 逃逸拒绝：绝对路径 / 盘符 / 前导 slash / 反斜杠 / `..` / query / hash / percent。
  const unsafeImages = [
    '/etc/passwd',
    'C:/windows/system32/x.png',
    'C:\\windows\\system32\\x.png',
    '\\\\server\\share\\x.png',
    'images\\popular\\x.png',
    'images/../../secret.png',
    '../manifest.json',
    'images/popular/x.png?v=1',
    'images/popular/x.png#frag',
    'images/%2e%2e/secret.png',
    'images/popular/%2e/x.png',
  ];
  for (const image of unsafeImages) {
    assert.throws(
      () => publish.sourcePathFor({ key: 'k', image }, 'C:/cand/generation-manifest.json'),
      /unsafe|escapes/,
      `source path must reject escape: ${image}`,
    );
  }
  // 解算后仍被锁在 generation-manifest 同级候选目录内。
  const safeResolved = publish.sourcePathFor(
    { image: 'images/popular/popular_x.png' },
    path.join('C:', 'cand', 'generation-manifest.json'),
  );
  assert.ok(
    safeResolved.startsWith(path.resolve(path.join('C:', 'cand')) + path.sep),
    'resolved source must stay inside the candidate dir',
  );

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-showcase-publish-'));
  try {
    assert.throws(() => publish.resolveDirArg(rootDir, 'missing', '--source', true), /does not exist/);
    fs.mkdirSync(path.join(rootDir, 'sub'));
    assert.throws(() => publish.resolveDirArg(rootDir, 'sub', '--source', true), /no manifest\.json/);
    fs.writeFileSync(path.join(rootDir, 'sub', 'manifest.json'), '{}');
    assert.strictEqual(publish.resolveDirArg(rootDir, 'sub', '--source', true), path.resolve(path.join(rootDir, 'sub')));
    const absoluteTarget = path.join(rootDir, 'new-v15');
    assert.strictEqual(publish.resolveDirArg(rootDir, absoluteTarget, '--target', false), path.resolve(absoluteTarget));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('showcase publish target validation rejects root, overlaps and out-of-root targets', () => {
  const assert = require('assert');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const publish = require('../../scripts/maintenance/publish-showcase-refresh.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-showcase-target-'));
  const source = path.join(root, 'versions', 'v14');
  fs.mkdirSync(source, { recursive: true });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-showcase-elsewhere-'));
  try {
    // 正常命名发布：root 的直接子目录。
    const named = path.join(root, '2026-08-12_v15');
    assert.strictEqual(publish.validateTarget(root, source, named), path.resolve(named));

    // 危险 target 全部拒绝。
    assert.throws(() => publish.validateTarget(root, source, source), /must not equal/,
      'target must not equal source');
    assert.throws(() => publish.validateTarget(root, source, root), /showcase root/,
      'target must not be the showcase root');
    assert.throws(() => publish.validateTarget(root, source, path.join(root, 'versions')), /contained by/,
      'target being the source parent must fail');
    assert.throws(() => publish.validateTarget(root, source, path.join(source, 'sub')), /contained by/,
      'target inside the source must fail');
    assert.throws(() => publish.validateTarget(root, source, path.dirname(root)), /must not contain/,
      'absolute target containing the root must fail');
    assert.throws(() => publish.validateTarget(root, source, path.join(root, 'a', 'b')), /direct child/,
      'a nested child of the root is not a direct child');

    // root 之外的绝对 target 只要不含 source/root（测试逃生口）就放行。
    assert.strictEqual(
      publish.validateTarget(root, source, path.join(elsewhere, 'v15')),
      path.resolve(path.join(elsewhere, 'v15')),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('showcase publish switchTarget replaces atomically and rolls back on failure', () => {
  const assert = require('assert');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const publish = require('../../scripts/maintenance/publish-showcase-refresh.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-showcase-switch-'));
  try {
    // 既有 target：先 rename 到 backup，再 rename temp 到 target，成功后删 backup。
    const target = path.join(root, '2026-08-12_v15');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'manifest.json'), '{old:true}');
    fs.writeFileSync(path.join(target, 'old.jpg'), 'old');
    const temp = path.join(root, `.${path.basename(target)}.building-test`);
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(temp, 'manifest.json'), '{new:true}');
    fs.writeFileSync(path.join(temp, 'new.jpg'), 'new');

    publish.switchTarget(temp, target, true);
    assert.strictEqual(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'), '{new:true}',
      'new build must land on the target name');
    assert.strictEqual(fs.existsSync(path.join(target, 'old.jpg')), false,
      'old target must be replaced, not merged');
    assert.strictEqual(fs.existsSync(temp), false, 'temp must move onto the target name');
    assert.deepStrictEqual(
      fs.readdirSync(root).filter(name => name.includes('.backup-')),
      [],
      'backup must be deleted after a successful switch',
    );

    // 无 manifest.json 的既有 target 拒绝替换，且保持原样。
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'readme.txt'), 'x');
    const tempPlain = path.join(root, `.${path.basename(plain)}.building-test`);
    fs.mkdirSync(tempPlain);
    fs.writeFileSync(path.join(tempPlain, 'manifest.json'), '{}');
    assert.throws(() => publish.switchTarget(tempPlain, plain, true), /without manifest\.json/,
      'an existing target without manifest.json must not be replaced');
    assert.strictEqual(fs.existsSync(path.join(plain, 'readme.txt')), true,
      'refused target stays untouched');

    // 回滚：temp→target rename 失败时 restore backup。
    const targetB = path.join(root, '2026-08-12_v16');
    fs.mkdirSync(targetB, { recursive: true });
    fs.writeFileSync(path.join(targetB, 'manifest.json'), '{old:true}');
    const tempB = path.join(root, `.${path.basename(targetB)}.building-test`);
    fs.mkdirSync(tempB);
    fs.writeFileSync(path.join(tempB, 'manifest.json'), '{new:true}');
    let calls = 0;
    const failingRename = (fromDir, toDir) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated rename failure');
      fs.renameSync(fromDir, toDir);
    };
    assert.throws(() => publish.switchTarget(tempB, targetB, true, failingRename),
      /simulated rename failure/);
    assert.strictEqual(fs.readFileSync(path.join(targetB, 'manifest.json'), 'utf8'), '{old:true}',
      'the old target must be restored when the switch fails');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scene-showcase route serves approved assets and blocks everything else over HTTP', async () => {
  const assert = require('assert');
  const fs = require('fs');
  const http = require('http');
  const os = require('os');
  const path = require('path');
  const gatewayTestStack = require('./gateway-test-stack');

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-showcase-http-'));
  const showcaseDir = path.join(fixtureRoot, '2026-08-12_v15');
  fs.mkdirSync(path.join(showcaseDir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(showcaseDir, 'thumbs'), { recursive: true });
  fs.mkdirSync(path.join(showcaseDir, 'home'), { recursive: true });
  fs.writeFileSync(path.join(showcaseDir, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(showcaseDir, 'README.txt'), 'fixture');
  fs.writeFileSync(path.join(showcaseDir, 'images', 'sc001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(showcaseDir, 'images', 'pc_emilia_rezero.png'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(showcaseDir, 'images', 'artist_bunbun.webp'), Buffer.from([4, 5, 6]));
  fs.writeFileSync(path.join(showcaseDir, 'images', 'lora_nene_sd_closeup.jpg'), Buffer.from([0xff, 0xd8]));
  fs.writeFileSync(path.join(showcaseDir, 'thumbs', 'pc_emilia_rezero.png'), Buffer.from([7, 8]));
  fs.writeFileSync(path.join(showcaseDir, 'home', 'nene.jpg'), Buffer.from([9, 10]));

  const stack = await gatewayTestStack.start({
    token: 'showcase-http-fixture-token-0123456789abcdef01234',
    configureConfig: (config) => { config.SCENE_SHOWCASE_DIR = showcaseDir; },
  });
  const PORT = stack.address.port;
  const LOCAL = { Host: '127.0.0.1:' + PORT };
  function request(pathname, port) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: port || PORT,
        method: 'GET',
        path: pathname,
        headers: LOCAL,
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
  }

  let plainStack = null;
  try {
    // 放行：白名单内场景 / 画师 / 热门角色 / LoRA 资产，query 版本号不影响路径。
    const allowed = [
      '/scene-showcase/manifest.json',
      '/scene-showcase/README.txt',
      '/scene-showcase/home/nene.jpg',
      '/scene-showcase/images/sc001.jpg',
      '/scene-showcase/images/pc_emilia_rezero.png',
      '/scene-showcase/images/artist_bunbun.webp',
      '/scene-showcase/images/lora_nene_sd_closeup.jpg',
      '/scene-showcase/thumbs/pc_emilia_rezero.png',
      '/scene-showcase/images/pc_emilia_rezero.png?cv=1750&v=1751',
    ];
    for (const item of allowed) {
      const status = await request(item);
      assert.strictEqual(status, 200, `allowed path must serve 200: ${item}`);
    }

    // 拒绝：任意路径 / 非前缀文件名 / 穿越 / 编码穿越 / 深层路径 / 非法扩展名。
    const blocked = [
      '/scene-showcase/images/sc001.exe',
      '/scene-showcase/images/foo.jpg',
      '/scene-showcase/images/pc.txt',
      '/scene-showcase/images/sc001',
      '/scene-showcase/images/sc1234.jpg',
      '/scene-showcase/images/../manifest.json',
      '/scene-showcase/images/%2e%2e/manifest.json',
      '/scene-showcase/images/sc001.jpg/secret',
      '/scene-showcase/images/pc_emilia_rezero.png/../manifest.json',
      '/scene-showcase/manifest.json/..',
      '/scene-showcase/home/nene.png',
      '/scene-showcase/home-hero.json',
      '/scene-showcase/config.json',
      '/scene-showcase/sheets/../manifest.json',
    ];
    for (const item of blocked) {
      const status = await request(item);
      assert.strictEqual(status, 404, `blocked path must be 404: ${item}`);
    }

    // 未配置 SCENE_SHOWCASE_DIR 时整个挂载点 404。
    // 显式清空该值，避免 config 的 auto-resolve 落到本机真实 AI/SceneShowcase。
    plainStack = await gatewayTestStack.start({
      token: 'showcase-http-fixture-token-0123456789abcdef01234',
      configureConfig: (config) => { config.SCENE_SHOWCASE_DIR = ''; },
    });
    const plainStatus = await request('/scene-showcase/manifest.json', plainStack.address.port);
    assert.strictEqual(plainStatus, 404, 'unconfigured showcase dir must 404');
  } finally {
    if (plainStack) await plainStack.close();
    await stack.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('showcase actual assets are self-consistent (skipped without AI workspace)', (t) => {
  const { isShowcaseAssetPath } = require('../../server/showcase-assets.js');
  const { parseShowcaseManifest } = require('../../src/utils/showcaseManifest.ts');

  const showcaseRoot = path.resolve(root, '..', 'AI', 'SceneShowcase');
  if (!fs.existsSync(showcaseRoot)) {
    t.skip('AI/SceneShowcase not present in this workspace');
    return;
  }
  const candidates = fs.readdirSync(showcaseRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(showcaseRoot, entry.name, 'manifest.json')))
    .sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'));
  assert.ok(candidates.length > 0, 'expected at least one showcase version under AI/SceneShowcase');
  const selected = path.join(showcaseRoot, candidates[0].name);
  const manifest = JSON.parse(fs.readFileSync(path.join(selected, 'manifest.json'), 'utf8'));
  const parsed = parseShowcaseManifest(manifest);

  assert.strictEqual(
    new Set(parsed.entries.map(entry => entry.id)).size,
    parsed.entries.length,
    'manifest ids must be unique',
  );
  assert.strictEqual(
    parsed.sceneCount,
    parsed.entries.filter(entry => entry.type === 'scene').length,
    'sceneCount must count only scene entries',
  );
  assert.strictEqual(parsed.entryCount, parsed.entries.length, 'entryCount must equal entries');
  assert.strictEqual(
    Object.values(parsed.typeCounts).reduce((sum, count) => sum + count, 0),
    parsed.entryCount,
    'typeCounts must sum to entryCount',
  );
  // 资产自洽按 entry.image/thumb 读取，不硬编码 jpg 扩展名。
  for (const entry of parsed.entries) {
    const image = entry.image || `images/${entry.id}.jpg`;
    const thumb = entry.thumb || `thumbs/${entry.id}.jpg`;
    assert(
      fs.existsSync(path.join(selected, ...image.split('/'))),
      `missing approved image: ${entry.id} (${image})`,
    );
    assert(
      fs.existsSync(path.join(selected, ...thumb.split('/'))),
      `missing approved thumbnail: ${entry.id} (${thumb})`,
    );
    assert(isShowcaseAssetPath('/' + image), `image not allowlisted: ${entry.id} ${image}`);
    assert(isShowcaseAssetPath('/' + thumb), `thumb not allowlisted: ${entry.id} ${thumb}`);
  }
});


test('local showcase config accepts a published collection or a parent library', () => {
  const os = require('os');
  const { resolveSceneShowcaseDir, loadGatewayConfig } = require('../../server/config');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-library-'));
  try {
    const library = path.join(temp, 'SceneShowcase');
    const edition = path.join(library, '2026-09-02-published');
    const staging = path.join(library, '.building-new');
    for (const dir of [edition, staging]) { fs.mkdirSync(dir, { recursive:true }); fs.writeFileSync(path.join(dir, 'manifest.json'), '{"entries":[]}'); }
    assert.strictEqual(resolveSceneShowcaseDir(temp, library), edition);
    assert.strictEqual(resolveSceneShowcaseDir(temp, edition), edition);
    const runtime = path.join(temp, 'runtime');
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ sceneShowcaseDir:library }));
    const config = loadGatewayConfig(temp, { AICS_RUNTIME_ROOT:runtime, AICS_DISABLE_LEGACY_RUNTIME_MIGRATION:'1' });
    assert.strictEqual(config.SCENE_SHOWCASE_DIR, edition, 'saved local media path survives a gateway restart');
    assert.strictEqual(resolveSceneShowcaseDir(temp, path.join(temp, 'disconnected')), '');
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});
