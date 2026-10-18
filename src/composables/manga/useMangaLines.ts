import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { mangaManifest, type MangaJob, type MangaLinePolarity } from '@/api/mangaApi'
import { fetchMangaTaskResult, mangaLineIndex } from '@/api/mangaTasks'
import { archiveTaskResult } from '@/composables/tasks/taskArtwork'
import { inspectMangaImage, previewMangaLines, type MangaImage } from './mangaImage'
import { downloadMangaPng, mangaLineResult } from './mangaResult'
import type { ArtworkRecord } from '@/types/artwork'

export type MangaLineMode = 'none' | 'auto' | 'external'
const message = (e: unknown) => e instanceof Error ? e.message : '线稿操作失败'
export function useMangaLines(options: { signal: AbortSignal; check: () => void; locked: () => boolean; loading: Ref<boolean>; exporting: Ref<boolean>;
  source: () => ArtworkRecord | undefined; onSaved: () => void }) {
  const mode = ref<MangaLineMode>('none'), polarity = ref<MangaLinePolarity>('black-on-white'), stretch = ref(false)
  const imported = shallowRef<MangaImage | null>(null), inputUrl = ref(''), inputBlob = shallowRef<Blob | null>(null)
  const outputUrl = ref(''), outputBlob = shallowRef<Blob | null>(null), expected = shallowRef<MangaJob | null>(null)
  const selected = ref<'input' | 'output'>('input'), error = ref(''), notice = ref(''), downloaded = ref(false)
  const inputResult = shallowRef<ReturnType<typeof mangaLineResult> | null>(null), outputResult = shallowRef<ReturnType<typeof mangaLineResult> | null>(null)
  const inputSaved = ref(false), outputSaved = ref(false), inputSaveAttempted = ref(false)
  const revision = ref(0), preparedPolarity = ref<MangaLinePolarity | null>(null)
  let sequence = 0
  const signature = computed(() => mode.value === 'external' ? `${revision.value}:${polarity.value}:${stretch.value}` : mode.value)
  const inputReady = computed(() => !!inputBlob.value && preparedPolarity.value === polarity.value)
  const previewUrl = computed(() => selected.value === 'input' ? inputReady.value ? inputUrl.value : '' : outputUrl.value)
  const previewAvailable = computed(() => !!imported.value || !!expected.value)
  const saved = computed(() => selected.value === 'input' ? inputSaved.value : outputSaved.value)
  const unsaved = computed(() => inputSaveAttempted.value && !inputSaved.value)
  const caption = computed(() => selected.value === 'input' ? imported.value
    ? `导入预览 · ${imported.value.name} · ${imported.value.width} × ${imported.value.height}` : '尚未导入线稿'
    : expected.value?.lineart ? `${expected.value.operation === 'lineart' ? '独立提取' : '任务线稿 · 裁框前'} · ${expected.value.lineart.width} × ${expected.value.lineart.height}` : '尚无线稿结果')
  const choices = computed(() => [
    ...(imported.value ? [{value:'input',label:'导入预览'}] : []),
    ...(expected.value ? [{value:'output',label:expected.value.operation === 'lineart' ? '独立提取结果' : '任务线稿'}] : []),
  ])
  function setUrl(target: Ref<string>, blob: Blob | null) {
    if (target.value) URL.revokeObjectURL(target.value)
    target.value = blob ? URL.createObjectURL(blob) : ''
  }
  async function prepare(file?: File) {
    if (options.locked()) return false
    const current = ++sequence
    options.loading.value = true; error.value = ''; notice.value = ''
    try {
      options.check()
      const image = file ? await inspectMangaImage(file, file.name) : imported.value
      if (!image) return false
      if (Math.max(image.width, image.height) > mangaManifest.maxInputSide || image.width * image.height > mangaManifest.maxInputPixels)
        throw new Error('线稿宽高不得超过 4096，总像素不超过 2097152；请先缩小后再导入')
      const selectedPolarity = polarity.value
      const blob = await previewMangaLines(image, selectedPolarity)
      options.check(); if (current !== sequence) return false
      imported.value = image; inputBlob.value = blob; preparedPolarity.value = selectedPolarity
      inputResult.value = mangaLineResult(blob, {id:`import-${crypto.randomUUID()}`, width:image.width, height:image.height, name:image.name,
        metadata:{operation:'lineart-import', sourceName:image.name, sourcePolarity:selectedPolarity,
          polarity:'black-on-white', stage:'import-preview', processorVersion:mangaManifest.schemaVersion, validation:'待主力机验证'}}, options.source())
      inputSaved.value = false; inputSaveAttempted.value = false
      setUrl(inputUrl, blob); selected.value = 'input'
      if (file) { revision.value++; stretch.value = false; mode.value = 'external' }
      return true
    } catch (e) { if (!options.signal.aborted) error.value = message(e); return false }
    finally { if (current === sequence) options.loading.value = false }
  }
  watch(polarity, () => { if (imported.value) void prepare() })
  function remove() {
    if (options.locked()) return
    imported.value = null; inputBlob.value = null; preparedPolarity.value = null; setUrl(inputUrl, null)
    inputResult.value = null; inputSaved.value = false; inputSaveAttempted.value = false
    revision.value++; stretch.value = false; error.value = ''; notice.value = ''
    if (mode.value === 'external') mode.value = 'none'
    if (selected.value === 'input' && expected.value) selected.value = 'output'
  }
  async function readOutput() {
    if (options.loading.value || !expected.value?.lineart) return
    const current = expected.value
    options.loading.value = true; error.value = ''; notice.value = ''
    try {
      options.check()
      const blob = await fetchMangaTaskResult(current, options.signal, 'lineart')
      const image = await inspectMangaImage(blob, '任务线稿')
      options.check()
      if (expected.value?.id !== current.id) return
      if (image.width !== current.lineart!.width || image.height !== current.lineart!.height) throw new Error('线稿实际尺寸与任务元数据不符')
      // Keep the same writer on retries, including an ambiguous artwork append.
      if (!outputResult.value) outputResult.value = {blob, save:() => archiveTaskResult(current.id, mangaLineIndex(current))}
      outputBlob.value = blob; setUrl(outputUrl, blob)
    } catch (e) { if (!options.signal.aborted) error.value = `${message(e)}；可重新读取线稿，无需重新处理漫画` }
    finally { options.loading.value = false }
  }
  async function accept(job: MangaJob) {
    if (!job.lineart) return
    if (expected.value?.id !== job.id) {
      outputBlob.value = null; outputResult.value = null; outputSaved.value = false
      setUrl(outputUrl, null); downloaded.value = false; expected.value = job
    }
    selected.value = 'output'
    if (!outputBlob.value) await readOutput()
  }
  async function save() {
    if (options.locked() || saved.value) return
    const output = selected.value === 'output'
    const result = output ? outputResult.value : inputReady.value ? inputResult.value : null
    if (!result) return
    options.exporting.value = true; error.value = ''; notice.value = ''
    try {
      options.check()
      if (!output) inputSaveAttempted.value = true
      await result.save(); options.check()
      if (output) outputSaved.value = true; else inputSaved.value = true
      notice.value = '线稿已存入我的作品，带有「线稿」标签与来源信息'
      options.onSaved()
    } catch (e) { if (!options.signal.aborted) error.value = `${message(e)}；可重试保存同一张线稿，或先导出 PNG` }
    finally { options.exporting.value = false }
  }
  async function download() {
    if (options.locked()) return
    const blob = selected.value === 'input' ? inputReady.value ? inputBlob.value : null : outputBlob.value
    if (!blob) return
    options.exporting.value = true; error.value = ''; notice.value = ''
    try {
      options.check()
      const output = selected.value === 'output'
      const id = output ? expected.value!.id.slice(0, 8) : '导入副本'
      if (await downloadMangaPng(blob, `绘遇-线稿-${id}.png`)) {
        if (output) downloaded.value = true
        notice.value = '已发起线稿 PNG 保存（黑线白底）'
      }
    } catch (e) { if (!options.signal.aborted) error.value = message(e) }
    finally { options.exporting.value = false }
  }
  function reset() {
    sequence++; imported.value = null; inputBlob.value = null; outputBlob.value = null; expected.value = null
    inputResult.value = null; outputResult.value = null; inputSaved.value = false; outputSaved.value = false; inputSaveAttempted.value = false
    setUrl(inputUrl, null); setUrl(outputUrl, null); preparedPolarity.value = null; downloaded.value = false
    if (mode.value === 'external') mode.value = 'none'
    selected.value = 'input'; stretch.value = false; error.value = ''; notice.value = ''
  }
  onScopeDispose(() => { sequence++; setUrl(inputUrl, null); setUrl(outputUrl, null) })
  return {mode, polarity, stretch, imported, signature, selected, error, notice, expected, outputBlob, unsaved, saved,
    previewUrl, previewAvailable, caption, choices, inputReady, prepare, remove, accept, readOutput, save, download, reset}
}
