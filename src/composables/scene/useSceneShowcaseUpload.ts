/**
 * 场景管理 · 样张与首页主视觉上传（从 SceneManagerView.vue 拆出）。
 *
 * 所有权：图片预览、JPEG 归一化、样张与首页主视觉的上传/恢复生命周期。
 * 2026-08-18：全量支持经典场景（302 个）与热门角色蓝图（347 个）样张在线预览与无感替换。
 */

import { ref, computed, onScopeDispose } from 'vue'
import { maintenanceApi, maintenanceFailure } from '@/api/maintenanceApi'
import type { HomeHeroCharacter } from '@/types/api'
import { confirmAction } from '@/composables/useConfirm'
import { useHomeHeroes, type HeroEntry } from '@/composables/useHomeHeroes'
import { useShowcaseAssets } from './useShowcaseAssets'

export interface ShowcaseSceneItem {
  id: string
  title: string
  char: string
  rating?: string
  type: 'scene' | 'popular'
}

interface UploadHooks {
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

export function useSceneShowcaseUpload({ errorMessage }: UploadHooks) {
  const selectedImageId = ref('')
  const selectedImageTitle = ref('')
  const showcaseFeedback = ref('')
  const showcaseError = ref(false)
  const { loading: manifestLoading, error: manifestError, reload: loadShowcaseManifest,
    thumbUrl, imageUrl, hasShowcase, invalidateAsset } = useShowcaseAssets(errorMessage)
  const uploadBusy = ref(false)
  const showcaseFileEl = ref<HTMLInputElement | null>(null)
  const heroFileEl = ref<HTMLInputElement | null>(null)
  const selectedHeroId = ref<HomeHeroCharacter | ''>('')
  const selectedHeroTitle = ref('')
  const { heroes, reload: loadHomeHeroes } = useHomeHeroes()
  const homeHeroes = computed(() => Object.values(heroes.value))
  let alive = true
  let heroRequest: AbortController | undefined
  let uploadRequest: AbortController | undefined
  onScopeDispose(() => {
    alive = false
    heroRequest?.abort()
    uploadRequest?.abort()
  })

  const showcaseUrl = computed(() => imageUrl(selectedImageId.value))
  const heroUrl = computed(() => selectedHeroId.value
    ? heroes.value[selectedHeroId.value].image
    : '')

  function previewImage(s: ShowcaseSceneItem) {
    selectedImageId.value = s.id
    selectedImageTitle.value = s.title
    showcaseError.value = false
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
    if (!file || !selectedImageId.value || uploadBusy.value) return
    const id = selectedImageId.value
    showcaseError.value = false
    if (file.size > 15 * 1024 * 1024) {
      showcaseError.value = true
      showcaseFeedback.value = '图片超过 15MB，请先压缩。'
      input.value = ''
      return
    }
    uploadBusy.value = true
    uploadRequest = new AbortController()
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
      }, { signal: uploadRequest.signal })
      if (!alive) return
      const message = data.message || '样张已保存'
      if (selectedImageId.value === id) showcaseFeedback.value = message
      invalidateAsset(id)
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
      uploadRequest = undefined
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
    selectedImageId, selectedImageTitle,
    showcaseFeedback, showcaseError, uploadBusy,
    showcaseFileEl, heroFileEl, selectedHeroId, selectedHeroTitle, homeHeroes,
    showcaseUrl, heroUrl, manifestLoading, manifestError,
    thumbUrl, imageUrl, hasShowcase, loadShowcaseManifest,
    previewImage, onShowcaseMissing, pickShowcase, previewHero, pickHero,
    loadHomeHeroes, resetHero, onShowcasePicked, onHeroPicked,
  }
}
