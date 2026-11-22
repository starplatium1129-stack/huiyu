<template>
  <section class="studio-panel studio-library" aria-labelledby="project-library-title">
    <header class="studio-heading">
      <h2 id="project-library-title">素材库</h2>
      <span class="studio-caption">{{ data.assets.length }} 项素材</span>
    </header>
    <div class="studio-fields">
      <label for="studio-kind">导入为</label>
      <StudioSelect id="studio-kind" v-model="kind" :options="assetKinds" size="sm" />
      <input ref="picker" type="file" hidden :multiple="!revisionTarget" :accept="accept" @change="importPicked" />
      <button type="button" class="btn btn-ghost" :disabled="busy" @click="pickFiles()">
        <ArchiveIcon name="plus" />导入本地文件
      </button>
    </div>
    <div v-if="incoming" class="studio-incoming">
      <span>{{ route.query.character ? '从角色档案带来的立绘' : '从作品册带来的原图' }}</span>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="busy || (!!route.query.artwork && (kind === 'audio' || kind === 'clip'))"
        @click="importIncoming"
      >
        收入素材库
      </button>
    </div>
    <div class="studio-links">
      <RouterLink to="/character">选角色立绘</RouterLink><RouterLink to="/gallery">选已有作品</RouterLink>
    </div>
    <div class="studio-asset-filters">
      <div>
        <label for="studio-asset-type">素材类型</label>
        <StudioSelect id="studio-asset-type" v-model="filterKind" :options="filterKinds" size="sm" />
      </div>
      <div>
        <label for="studio-asset-search">查找素材</label>
        <input id="studio-asset-search" v-model="filter" type="search" class="input" placeholder="按名称查找" />
      </div>
    </div>
    <p v-if="!visibleAssets.length" class="studio-caption">
      {{ filter || filterKind ? '没有符合条件的素材。' : '先加入一张角色立绘或场景原图。' }}
    </p>
    <ul v-else class="studio-assets">
      <li
        v-for="{ asset, active, options } in visibleAssets"
        :key="asset.id"
        :class="{ 'is-selected': active?.id === selected }"
      >
        <template v-if="active">
          <button
            class="studio-asset-pick"
            type="button"
            :draggable="imageVersion(active)"
            :aria-pressed="active.id === selected"
            @dragstart="drag($event, asset)"
            @click="select(asset)"
          >
            <StudioAssetThumb :version="active" /><span
              ><strong>{{ asset.title }}</strong
              ><small>{{ assetLabels[asset.kind] }} · v{{ active.number }}</small></span
            >
          </button>
          <div class="studio-asset-actions">
            <StudioSelect
              v-if="options.length > 1"
              :label="asset.title + ' 的版本'"
              size="sm"
              :model-value="active.id"
              :options="options"
              @update:model-value="changeVersion(asset, String($event))"
            />
            <button
              v-if="asset.kind === 'outfit' && imageVersion(active)"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="reuseOutfit(asset)"
            >
              用这套拍场景
            </button>
            <button
              v-if="imageVersion(active)"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="addReference(asset)"
            >
              用作参考
            </button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="pickFiles(asset)">
              追加版本
            </button>
          </div>
        </template>
      </li>
    </ul>
    <button
      v-if="filteredAssets.length > visibleAssets.length"
      class="btn btn-ghost btn-sm"
      type="button"
      @click="limit += 12"
    >
      显示更多素材
    </button>
    <details v-if="chosen" :key="chosen.id" class="studio-asset-source">
      <StudioDisclosureSummary>{{ versionLabel(data, chosen.id) }} · 来源</StudioDisclosureSummary>
      <div data-disclosure-content>
        <p v-if="chosen.source.kind === 'catalog'">角色档案 · {{ chosen.source.catalogId }}</p>
        <p v-else-if="chosen.source.kind === 'artwork'">作品册 · {{ chosen.source.artworkId }}</p>
        <p v-else-if="chosen.source.kind === 'file'">本地原件 · {{ chosen.source.name || '已保存' }}</p>
        <template v-else>
          <p>{{ chosen.source.modelId }} · 任务 {{ chosen.source.taskId }}</p>
          <p v-if="chosen.source.seed !== undefined">种子 {{ chosen.source.seed }}<span v-if="chosen.source.width && chosen.source.height"> · {{ chosen.source.width }} × {{ chosen.source.height }}</span></p>
          <p v-if="chosen.source.prompt">{{ chosen.source.prompt }}</p>
          <ol><li v-for="id in chosen.source.inputVersionIds" :key="id">{{ versionLabel(data, id) }}</li></ol>
        </template>
      </div>
    </details>
    <p v-if="message" class="studio-feedback" role="status">{{ message }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioAssetThumb from './StudioAssetThumb.vue'
import {
  assetKinds,
  assetLabels,
  catalogPortrait,
  frameDragType,
  galleryOriginal,
  imageAccept,
  imageVersion,
  projectAssetIndex,
  referenceIssue,
  versionLabel,
} from './projectAssets'
import type {
  captureStudioProjectRepository,
  StudioAsset,
  StudioAssetImport,
  StudioAssetKind,
  StudioAssetVersion,
  StudioProjectSnapshot,
} from '@/storage/studioProjectRepository'

const props = defineProps<{
  data: StudioProjectSnapshot
  repo: ReturnType<typeof captureStudioProjectRepository>
  selected: string
  refresh: () => Promise<void>
}>()
const emit = defineEmits<{ select: [id: string]; reference: [id: string]; outfit: [id: string] }>()
const route = useRoute(),
  router = useRouter()
const kind = ref<StudioAssetKind>('scene'),
  picker = ref<HTMLInputElement>(),
  revisionTarget = ref<StudioAsset>()
const filter = ref(''),
  filterKind = ref(''),
  limit = ref(12),
  selectedVersions = ref<Record<string, string>>({})
const filterKinds = [{ value: '', label: '全部素材' }, ...assetKinds]
const busy = ref(false),
  message = ref(''),
  controller = new AbortController()
onScopeDispose(() => controller.abort())
const versions = computed(() => {
  const grouped = new Map<string, StudioAssetVersion[]>()
  for (const version of props.data.versions) {
    const group = grouped.get(version.assetId) || []
    group.push(version)
    grouped.set(version.assetId, group)
  }
  for (const group of grouped.values()) group.sort((left, right) => right.number - left.number)
  return grouped
})
const chosen = computed(() => projectAssetIndex(props.data).versions.get(props.selected))
const versionsOf = (asset: StudioAsset) => versions.value.get(asset.id) || []
function activeVersion(asset: StudioAsset) {
  const id = selectedVersions.value[asset.id]
  const selected = id ? projectAssetIndex(props.data).versions.get(id) : undefined
  return selected?.assetId === asset.id ? selected : versionsOf(asset)[0]
}
const filteredAssets = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase()
  return props.data.assets.filter(asset => (!filterKind.value || asset.kind === filterKind.value)
    && (!query || asset.title.toLocaleLowerCase().includes(query)))
})
const visibleAssets = computed(() => filteredAssets.value.slice(0, limit.value).map(asset => ({
  asset,
  active: activeVersion(asset),
  options: versionsOf(asset).map(version => ({ value: version.id, label: 'v' + version.number })),
})))
watch([filter, filterKind], () => {
  limit.value = 12
})
const incoming = computed(() => typeof route.query.character === 'string' || typeof route.query.artwork === 'string')
const accept = computed(() => {
  const type = revisionTarget.value?.kind || kind.value
  return type === 'audio' ? 'audio/wav,.wav' : type === 'clip' ? 'video/mp4,video/webm' : imageAccept + ',image/avif,image/gif'
})
function select(asset: StudioAsset) {
  const v = activeVersion(asset)
  if (v) emit('select', v.id)
}
function changeVersion(asset: StudioAsset, id: string) {
  selectedVersions.value[asset.id] = id
  emit('select', id)
}
function addReference(asset: StudioAsset) {
  const v = activeVersion(asset)
  message.value = referenceIssue(v)
  if (v && !message.value) emit('reference', v.id)
}
function reuseOutfit(asset: StudioAsset) {
  const version = activeVersion(asset)
  message.value = referenceIssue(version)
  if (version && !message.value) emit('outfit', version.id)
}
function drag(event: DragEvent, asset: StudioAsset) {
  const value = activeVersion(asset)
  if (value && imageVersion(value) && event.dataTransfer) {
    event.dataTransfer.setData(frameDragType, value.id)
    event.dataTransfer.effectAllowed = 'copy'
  }
}
async function save(input: StudioAssetImport) {
  controller.signal.throwIfAborted()
  props.repo.assertCurrent()
  const version = await props.repo.importAsset(input)
  controller.signal.throwIfAborted()
  selectedVersions.value[version.assetId] = version.id
  emit('select', version.id)
  return version
}
async function importFiles(files: File[], type: StudioAssetKind, asset?: StudioAsset): Promise<string[]> {
  if (busy.value) throw new Error('等待当前素材导入完成')
  busy.value = true
  message.value = ''
  const ids: string[] = []
  try {
    for (const file of files) {
      const version = await save({
        title: asset?.title || file.name,
        kind: type,
        blob: file,
        source: { kind: 'file', name: file.name },
        ...(asset ? { assetId: asset.id, expectedRevision: asset.revision } : {}),
      })
      ids.push(version.id)
    }
    filter.value = ''
    message.value = asset ? '已保存新版本。镜头仍可引用各自选用的版本。' : `已导入 ${ids.length} 项素材。`
    return ids
  } finally {
    try {
      if (!controller.signal.aborted) await props.refresh()
    } finally {
      busy.value = false
    }
  }
}
async function pickFiles(asset?: StudioAsset) {
  revisionTarget.value = asset
  if (!picker.value) return
  picker.value.accept = accept.value
  picker.value.multiple = !asset
  picker.value.click()
}
async function importPicked(event: Event) {
  const input = event.currentTarget as HTMLInputElement,
    files = Array.from(input.files || []),
    asset = revisionTarget.value
  input.value = ''
  if (!files.length) return
  try {
    await importFiles(files, asset?.kind || kind.value, asset)
  } catch (e) {
    if (!controller.signal.aborted) message.value = e instanceof Error ? e.message : '导入失败'
  }
}
async function importIncoming() {
  if (busy.value) return
  busy.value = true
  message.value = ''
  try {
    const character = route.query.character,
      artwork = route.query.artwork,
      type = route.query.idType
    const input =
      typeof character === 'string'
        ? await catalogPortrait(character, controller.signal)
        : typeof artwork === 'string'
          ? await galleryOriginal(type === 'number' ? Number(artwork) : artwork, kind.value, controller.signal)
          : null
    if (!input) return
    await save(input)
    await props.refresh()
    controller.signal.throwIfAborted()
    await router.replace({
      path: route.path,
      query: { ...route.query, character: undefined, artwork: undefined, idType: undefined },
    })
    message.value = `已收入「${input.title}」。`
  } catch (e) {
    if (!controller.signal.aborted) message.value = e instanceof Error ? e.message : '导入失败'
  } finally {
    busy.value = false
  }
}
defineExpose({ importFiles })
</script>
