/**
 * 场景管理 · 样张与首页主视觉上传（从 SceneManagerView.vue 拆出）。
 *
 * 所有权：图片预览、JPEG 归一化、样张与首页主视觉的上传/恢复生命周期。
 * 2026-08-18：全量支持经典场景（302 个）与热门角色蓝图（347 个）样张在线预览与无感替换。
 */

import { ref, computed, watch, onScopeDispose } from 'vue'
import { maintenanceApi, maintenanceFailure } from '@/api/maintenanceApi'
import type { HomeHeroCharacter, SceneDraft } from '@/types/api'
import type { SceneBlueprint } from '@/utils/popularContent'
import { confirmAction } from '@/composables/useConfirm'
import { useHomeHeroes, type HeroEntry } from '@/composables/useHomeHeroes'
import { runtimeFetch, runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { parseShowcaseManifest, type ShowcaseEntry } from '@/utils/showcaseManifest'

const IMAGE_PAGE_SIZE = 36

export interface ShowcaseSceneItem {
  id: string
  title: string
  char: string
  rating?: string
  type: 'scene' | 'popular'
}

interface UploadHooks {
  scenes: { value: SceneDraft[] }
  blueprints?: { value: SceneBlueprint[] }
  errorMessage: (error: unknown, fallback: string) => string
}

/** 归一化为 JPEG，与后端 15MB 原图 / 3MB 缩略图限制对齐 */
function jpegAtWidth(image: HTMLImageElement, maxWidth: number, quality: number): string {
  const scale = Math.min(1, maxWidth / image.naturalWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

function readFileAsImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('无法解析这张图片'))
      img.src = String(reader.result || '')
    }
    reader.onerror = () => reject(new Error('无法读取这张图片'))
    reader.readAsDataURL(file)
  })
}

export function useSceneShowcaseUpload({ scenes, blueprints, errorMessage }: UploadHooks) {
  const imageSearch = ref('')
  const imageSearchDebounced = ref('')
  let imageDebounceTimer: ReturnType<typeof setTimeout> | null = null
  watch(imageSearch, (v) => {
    if (imageDebounceTimer) clearTimeout(imageDebounceTimer)
    imageDebounceTimer = setTimeout(() => { imageSearchDebounced.value = v }, 250)
  })
  const imagePage = ref(1)
  const imageTypeFilter = ref<'all' | 'scene' | 'popular'>('all')
  const selectedImageId = ref('')
  const selectedImageTitle = ref('')
  const showcaseFeedback = ref('')
  const showcaseError = ref(false)
  const showcaseVersion = ref(Date.now())
  const uploadBusy = ref(false)
  const showcaseFileEl = ref<HTMLInputElement | null>(null)
  const heroFileEl = ref<HTMLInputElement | null>(null)
  const selectedHeroId = ref<HomeHeroCharacter | ''>('')
  const selectedHeroTitle = ref('')
  const { heroes, reload: loadHomeHeroes } = useHomeHeroes()
  const homeHeroes = computed(() => Object.values(heroes.value))
  const showcaseEntries = ref(new Map<string, ShowcaseEntry>())
  let alive = true
  let heroRequest: AbortController | undefined
  let showcaseRequest: AbortController | undefined
  onScopeDispose(() => {
    alive = false
    heroRequest?.abort()
    showcaseRequest?.abort()
    if (imageDebounceTimer) clearTimeout(imageDebounceTimer)
  })

  async function loadShowcaseManifest() {
    showcaseRequest?.abort()
    const controller = new AbortController()
    showcaseRequest = controller
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await runtimeFetch('/scene-showcase/manifest.json', { signal: controller.signal, cache: 'no-cache' })
      if (!response.ok) throw new Error('无法读取当前样张清单')
      const raw = await response.json() as { entries?: Array<{ id?: unknown } | null> }
      const counts = new Map<unknown, number>()
      for (const item of raw.entries ?? []) counts.set(item?.id, (counts.get(item?.id) ?? 0) + 1)
      const entries = parseShowcaseManifest(raw).entries.filter(item => counts.get(item.id) === 1)
      if (alive && !controller.signal.aborted) showcaseEntries.value = new Map(entries.map(item => [item.id, item]))
    } finally {
      clearTimeout(timeout)
      if (showcaseRequest === controller) showcaseRequest = undefined
    }
  }
  watch(runtimeResourceIdentity, () => {
    showcaseEntries.value = new Map()
    void loadShowcaseManifest().catch(() => {})
  }, { immediate: true })

  const allShowcaseItems = computed<ShowcaseSceneItem[]>(() => {
    const items: ShowcaseSceneItem[] = scenes.value.map(s => ({
      id: s.id,
      title: s.title,
      char: s.char,
      rating: s.rating,
      type: 'scene'
    }))

    if (blueprints?.value?.length) {
      blueprints.value.forEach(bp => {
        const charId = bp.characterId || ''
        const entryId = `pc_${charId}_${bp.id}`
        items.push({
          id: entryId,
          title: bp.title,
          char: charId,
          rating: bp.adult ? 'R18' : 'All',
          type: 'popular'
        })
      })
    }

    return items
  })

  const filteredImageScenes = computed(() => {
    const q = imageSearchDebounced.value.trim().toLowerCase()
    let list = allShowcaseItems.value

    if (imageTypeFilter.value !== 'all') {
      list = list.filter(item => item.type === imageTypeFilter.value)
    }

    if (!q) return list
    return list.filter(s => (s.id + ' ' + s.title + ' ' + s.char).toLowerCase().includes(q))
  })

  const imageTotalPages = computed(() => Math.max(1, Math.ceil(filteredImageScenes.value.length / IMAGE_PAGE_SIZE)))
  const pagedImageScenes = computed(() =>
    filteredImageScenes.value.slice((imagePage.value - 1) * IMAGE_PAGE_SIZE, imagePage.value * IMAGE_PAGE_SIZE),
  )
  watch([imageSearchDebounced, imageTypeFilter], () => { imagePage.value = 1 })

  const showcaseUrl = computed(() => imageUrl(selectedImageId.value))
  const heroUrl = computed(() => selectedHeroId.value
    ? heroes.value[selectedHeroId.value].image
    : '')

  function showcaseAssetUrl(id: string, kind: 'image' | 'thumb'): string {
    const entry = showcaseEntries.value.get(id)
    if (!entry) return ''
    const path = entry[kind] || `${kind === 'image' ? 'images' : 'thumbs'}/${id}.jpg`
    return /^(?:images|thumbs)\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path)
      ? `/scene-showcase/${path}?v=${showcaseVersion.value}` : ''
  }
  const thumbUrl = (id: string) => showcaseAssetUrl(id, 'thumb')
  const imageUrl = (id: string) => showcaseAssetUrl(id, 'image')

  function previewImage(s: ShowcaseSceneItem | SceneDraft) {
    selectedImageId.value = s.id
    selectedImageTitle.value = s.title
    showcaseError.value = false
    showcaseVersion.value = Date.now()
    showcaseFeedback.value = '支持 PNG / JPEG / WebP，最大 15MB；仅本机可替换。'
  }

  function onShowcaseMissing() {
    showcaseError.value = true
    showcaseFeedback.value = '该场景还没有样张，可直接上传一张。'
  }
  function pickShowcase() { showcaseFileEl.value?.click() }

  function previewHero(hero: HeroEntry) {
    selectedHeroId.value = hero.id
    selectedHeroTitle.value = hero.title
    showcaseError.value = false
    showcaseFeedback.value = '支持 PNG / JPEG / WebP，最大 15MB；仅本机可替换。'
  }
  function pickHero() { heroFileEl.value?.click() }

  function uploadErrorMessage(error: unknown, fallback: string): string {
    const failure = maintenanceFailure(error)
    const message = errorMessage(error, fallback)
    return failure?.recovery && !message.includes(failure.recovery)
      ? `${message}；${failure.recovery}`
      : message
  }

  async function refreshSavedHero(character: HomeHeroCharacter, message: string) {
    if (!alive) return
    if (selectedHeroId.value === character) showcaseFeedback.value = message
    try { await loadHomeHeroes() } catch (error) {
      if (!alive || selectedHeroId.value !== character) return
      showcaseError.value = true
      showcaseFeedback.value = `${message}，但预览未能刷新：${uploadErrorMessage(error, '请重新打开页面')}`
    }
  }

  async function resetHero() {
    if (!selectedHeroId.value || uploadBusy.value) return
    const character = selectedHeroId.value
    if (!(await confirmAction({ title: `恢复${selectedHeroTitle.value}的内置首页图？`, danger: false }))) return
    if (!alive || uploadBusy.value) return
    uploadBusy.value = true
    showcaseError.value = false
    heroRequest = new AbortController()
    try {
      const data = await maintenanceApi.resetHomeHero(character, { signal: heroRequest.signal })
      await refreshSavedHero(character, data.message || '已恢复内置图')
    } catch (err) {
      if (!alive || selectedHeroId.value !== character) return
      showcaseError.value = true
      showcaseFeedback.value = '未能恢复：' + uploadErrorMessage(err, '请确认通过本机控制面板打开网站')
    } finally { uploadBusy.value = false; heroRequest = undefined }
  }

  async function onShowcasePicked(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !selectedImageId.value) return
    const id = selectedImageId.value
    showcaseError.value = false
    if (file.size > 15 * 1024 * 1024) {
      showcaseError.value = true
      showcaseFeedback.value = '图片超过 15MB，请先压缩。'
      input.value = ''
      return
    }
    uploadBusy.value = true
    showcaseFeedback.value = '正在保存样张…'
    try {
      const image = await readFileAsImage(file)
      if (!alive) return
      if (image.naturalWidth * image.naturalHeight > 60_000_000) {
        throw new Error('图片像素过大，请使用不超过 6000 万像素的版本')
      }
      const normalized = jpegAtWidth(image, 4096, 0.94)
      const thumbnail = jpegAtWidth(image, 560, 0.86)
      const data = await maintenanceApi.saveShowcase({
        id,
        image: normalized,
        thumbnail,
      })
      if (!alive) return
      const message = data.message || '样张已保存'
      if (selectedImageId.value === id) showcaseFeedback.value = message
      showcaseVersion.value = Date.now()
      try { await loadShowcaseManifest() } catch (error) {
        if (!alive || selectedImageId.value !== id) return
        showcaseError.value = true
        showcaseFeedback.value = `${message}，但预览未能刷新：${uploadErrorMessage(error, '请重新打开页面')}`
      }
    } catch (err) {
      if (!alive || selectedImageId.value !== id) return
      showcaseError.value = true
      showcaseFeedback.value = '未能保存：' + uploadErrorMessage(err, '请确认通过本机控制面板打开网站')
    } finally {
      uploadBusy.value = false
      input.value = ''
    }
  }

  async function onHeroPicked(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !selectedHeroId.value || uploadBusy.value) return
    const character = selectedHeroId.value
    showcaseError.value = false
    uploadBusy.value = true
    heroRequest = new AbortController()
    showcaseFeedback.value = '正在保存首页主视觉…'
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('图片超过 15MB，请先压缩')
      const image = await readFileAsImage(file)
      if (!alive) return
      if (image.naturalWidth * image.naturalHeight > 60_000_000) throw new Error('图片像素过大，请使用不超过 6000 万像素的版本')
      const normalized = jpegAtWidth(image, 4096, 0.94)
      const data = await maintenanceApi.saveHomeHero(character, normalized, { signal: heroRequest.signal })
      await refreshSavedHero(character, data.message || '首页主视觉已保存')
    } catch (err) {
      if (!alive || selectedHeroId.value !== character) return
      showcaseError.value = true
      showcaseFeedback.value = '未能保存：' + uploadErrorMessage(err, '请确认通过本机控制面板打开网站')
    } finally { uploadBusy.value = false; heroRequest = undefined; input.value = '' }
  }

  return {
    imageSearch, imageSearchDebounced, imagePage, imageTypeFilter, selectedImageId, selectedImageTitle,
    showcaseFeedback, showcaseError, showcaseVersion, uploadBusy,
    showcaseFileEl, heroFileEl, selectedHeroId, selectedHeroTitle, homeHeroes,
    allShowcaseItems, filteredImageScenes, imageTotalPages, pagedImageScenes, showcaseUrl, heroUrl,
    thumbUrl, imageUrl,
    previewImage, onShowcaseMissing, pickShowcase, previewHero, pickHero,
    loadHomeHeroes, resetHero, onShowcasePicked, onHeroPicked,
  }
}
