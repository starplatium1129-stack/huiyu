import type { Page } from '@playwright/test'

/** 与 helpers/ui-fluidity-measure.ts 一致：测试侧只收窄本夹具用到的字段，不引入应用全局声明。 */
type UiFluidityProbeWindow = Window & { __AICS_UI_FLUIDITY__?: { enabled?: boolean } }

/** Fixed, synthetic data set for 009/F0. It never reads the user's gallery or calls a generator. */
export const UI_FLUIDITY_FIXTURE = Object.freeze({
  id: 'ui-fluidity-f0-v1',
  sceneCount: 48,
  showcaseCount: 36,
  image: { width: 832, height: 1216, format: 'svg' },
})

const scenes = Array.from({ length: UI_FLUIDITY_FIXTURE.sceneCount }, (_, index) => {
  const number = index + 1
  const id = `sc${9000 + number}`
  return {
    id,
    title: `F0 固定场景 ${String(number).padStart(2, '0')}`,
    story: 'F0 synthetic scene fixture; no production content.',
    prompt: 'synthetic fixture scene',
    tags: ['f0', 'fixture'],
    char: number % 2 ? 'nene' : 'natsume',
    character: [number % 2 ? 'nene' : 'natsume'],
    category: 'F0 基线',
    season: '秋',
    series: 'fixture',
    rating: 'All',
    mature: false,
    timeOfDay: 'afternoon',
    lighting: 'soft ambient light',
    camera: 'medium shot',
    location: 'fixture room',
    weather: 'clear',
    emotion: '平静',
    recommendedSize: '832x1216',
  }
})

const popularCharacter = {
  id: 'nene',
  displayName: 'F0 夹具宁宁',
  originalName: 'F0 Fixture Nene',
  franchise: 'F0 Fixture',
  aliases: [],
  identityProse: 'A synthetic adult character used only for the local fluidity fixture.',
  identityTokens: ['1girl', 'adult woman'],
  exactTokens: ['f0_fixture_nene'],
  exactPrefixes: [],
  recommendedEngine: 'anima',
  supportedEngines: ['anima', 'krea2'],
  adultEligibility: 'adult',
  outfits: [{ id: 'default', name: '默认夹具服装', prose: 'wearing a simple fixture outfit', tokens: ['simple dress'], default: true }],
  curatedArtistStyles: [],
}

const blueprint = {
  id: 'f0-blueprint-001',
  title: 'F0 固定蓝图',
  category: '日常',
  description: 'Synthetic blueprint for local performance measurement.',
  characterId: 'nene',
  location: 'fixture room',
  action: 'standing',
  timeOfDay: 'afternoon',
  lighting: 'soft ambient light',
  camera: 'medium shot',
  mood: 'calm',
  sceneTags: ['f0', 'fixture'],
  promptProse: 'A synthetic fixture scene.',
  promptTokens: ['standing'],
  negativeTokens: [],
  recommendedSize: '832x1216',
  adult: false,
  compositionIntent: 'single',
}

const fixtureData: Record<string, unknown> = {
  'curation.json': {
    version: 1,
    qualityGate: 'fixture',
    curatedSceneIds: scenes.slice(0, 12).map(scene => scene.id),
    signatureSceneIds: scenes.slice(0, 12).map(scene => scene.id),
    personaCoreSceneIds: scenes.map(scene => scene.id),
    personaCoreReasons: Object.fromEntries(scenes.map(scene => [scene.id, 'F0 fixture'])),
    recommendationReasons: {},
    moodRails: [],
  },
  'characters.json': [{ id: 'nene', name: 'F0 夹具宁宁', source: 'F0 Fixture', tags: [] }],
  'loras.json': [],
  'tags.json': [],
  'presets.json': [],
  'scenes-index.json': {
    version: 1,
    total: scenes.length,
    shards: {
      nene: { file: 'scenes-nene.json', count: scenes.filter(scene => scene.char === 'nene').length },
      natsume: { file: 'scenes-natsume.json', count: scenes.filter(scene => scene.char === 'natsume').length },
      shared: { file: 'scenes-shared.json', count: 0 },
    },
    tiers: { core: scenes.map(scene => scene.id) },
    orderedIds: scenes.map(scene => scene.id),
  },
  'popular-characters.json': { version: 1, characters: [popularCharacter] },
  'scene-blueprints.json': { version: 1, blueprints: [blueprint] },
  'scenes-core.json': scenes,
  'scenes-nene.json': scenes.filter(scene => scene.char === 'nene'),
  'scenes-natsume.json': scenes.filter(scene => scene.char === 'natsume'),
  'scenes-shared.json': [],
}

const showcaseEntries = Array.from({ length: UI_FLUIDITY_FIXTURE.showcaseCount }, (_, index) => {
  const id = `f0-showcase-${String(index + 1).padStart(2, '0')}`
  return {
    id,
    title: `F0 样张 ${String(index + 1).padStart(2, '0')}`,
    story: 'Synthetic showcase entry for local performance measurement.',
    char: 'nene',
    type: 'scene',
    rating: 'All',
    thumb: `thumbs/${id}.svg`,
    image: `images/${id}.svg`,
  }
})

const imageBody = `<svg xmlns="http://www.w3.org/2000/svg" width="${UI_FLUIDITY_FIXTURE.image.width}" height="${UI_FLUIDITY_FIXTURE.image.height}" viewBox="0 0 ${UI_FLUIDITY_FIXTURE.image.width} ${UI_FLUIDITY_FIXTURE.image.height}"><rect width="100%" height="100%" fill="#554b68"/><text x="48" y="96" fill="#fff" font-size="32">F0 FIXTURE</text></svg>`

const offlineGenerationStatus = {
  ok: true,
  online: false,
  provider: null,
  webuiOnline: false,
  comfyFallbackOnline: false,
  checkpoint: '',
  samplers: [],
  schedulers: [],
  models: [],
  loras: [],
  capabilities: { basic: false, hires: false, hiresUpscalers: [], faceDetailer: false },
  pending: 0,
  maxPending: 0,
}

/** 1×1 PNG：零解码成本的对照图，仅用于把图片解码/光栅代价从其它渲染代价里分离。 */
const MICRO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

export async function installUiFluidityFixture(
  page: Page,
  measurementEnabled = true,
  options: { thumbFormat?: 'svg' | 'micro' } = {},
) {
  await page.addInitScript(({ enabled }) => {
    const onceKey = '__aics_ui_fluidity_fixture_ready__'
    if (!sessionStorage.getItem(onceKey)) {
      localStorage.clear()
      localStorage.setItem('aics_theme', 'dark')
      localStorage.setItem('aics_guest_guide_dismissed', '1')
      for (const name of ['aics_kv_store', 'aics_image_store', 'aics_artwork_store']) indexedDB.deleteDatabase(name)
      sessionStorage.setItem(onceKey, '1')
    }
    ;(window as UiFluidityProbeWindow).__AICS_UI_FLUIDITY__ = { enabled }
  }, { enabled: measurementEnabled })

  await page.route('**/data/**', async route => {
    const file = new URL(route.request().url()).pathname.split('/').pop() || ''
    if (!(file in fixtureData)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fixtureData[file]),
    })
  })
  await page.route('**/scene-showcase/**', route => route.fulfill(
    options.thumbFormat === 'micro'
      // 1×1 PNG 对照：请求数、DOM 结构与默认 SVG 完全一致，只把解码/光栅成本降到接近 0，
      // 用来把「图片解码尖峰」从其它渲染代价里分离出来（.sc-band 定比例，固有尺寸不影响布局）。
      ? { status: 200, contentType: 'image/png', body: MICRO_PNG }
      : { status: 200, contentType: 'image/svg+xml', body: imageBody },
  ))
  await page.route('**/scene-showcase/manifest.json*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ entries: showcaseEntries }),
  }))
  await page.route('**/assets/characters/**', route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: imageBody,
  }))
  await page.route('**/api/generation/status*', route => route.fulfill({ json: offlineGenerationStatus }))
  await page.route('**/api/sd-status*', route => route.fulfill({ json: {
    online: false, checkpoint: '', models: [], samplers: [], schedulers: [], upscalers: [],
  } }))
  await page.route('**/api/live2d-status*', route => route.fulfill({ json: { models: {} } }))

  return {
    fixture: UI_FLUIDITY_FIXTURE,
    data: fixtureData,
    showcaseEntries,
  }
}

export async function setUiFluidityMeasurement(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(value => {
    const state = (window as UiFluidityProbeWindow).__AICS_UI_FLUIDITY__
    if (state) state.enabled = value
  }, enabled)
}
