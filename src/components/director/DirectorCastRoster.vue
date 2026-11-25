<template>
  <section v-if="pb.cast.length || pb.isUnbound" class="director-cast" :aria-label="pb.cast.length > 1 ? '同框演员表' : '同框角色'">
    <div v-if="showRoster" v-content-motion:up="true" class="cast-roster">
      <h3>同框演员表 <span>{{ pb.cast.length }} / 5</span></h3>
      <p v-if="pb.cast.length > 1" class="cast-status" role="status">{{ placementLabel }}</p>
      <div v-if="pb.cast.length > 1" class="cast-stacked-field">
        <label :for="interactionId">角色互动关系</label>
        <textarea :id="interactionId" v-model="pb.castInteraction" class="textarea input-sm" rows="2" maxlength="1000"
          placeholder="例如两人对视，共用一把伞" />
      </div>
      <div v-if="canChooseFormation" class="cast-field">
        <label :for="formationId">自动排布</label>
        <StudioSelect :id="formationId" :model-value="displayedFormation" :options="formationOptions" label="自动排布" size="sm"
          @update:model-value="setFormation" />
      </div>
      <ol ref="roster" class="cast-list" role="list">
        <li v-for="(actor, index) in actors" :key="actor.key" :data-actor="actor.key" class="cast-actor">
          <div class="cast-actor-header">
            <CharacterPortrait :src="actor.image" :name="actor.name" />
            <div class="cast-actor-name">
              <small>#{{ index + 1 }}<template v-if="actor.isLead"> · 主角</template><template v-if="staggered"> · {{ index < 2 ? '前排' : '后排' }}</template></small>
              <strong>{{ actor.name }}</strong>
            </div>
            <div class="cast-actor-actions">
              <StudioTooltip content="前移一位">
                <button class="btn btn-quiet btn-sm cast-move-earlier" type="button" :aria-disabled="index === 0"
                  :aria-label="`${actor.name}前移一位`" @click="moveActor(index, -1, $event)"><ArchiveIcon name="chevron-down" /></button>
              </StudioTooltip>
              <StudioTooltip content="后移一位">
                <button class="btn btn-quiet btn-sm" type="button" :aria-disabled="index === actors.length - 1"
                  :aria-label="`${actor.name}后移一位`" @click="moveActor(index, 1, $event)"><ArchiveIcon name="chevron-down" /></button>
              </StudioTooltip>
            </div>
          </div>
          <div class="cast-field">
            <label :for="`${rosterId}-${index}-outfit`">服装</label>
            <StudioSelect :id="`${rosterId}-${index}-outfit`" :model-value="actor.outfitId"
              :options="actor.outfits" :label="`${actor.name}的服装`" size="sm"
              @update:model-value="setOutfit(index, $event)" />
            <button v-if="referenceOutfit" class="btn btn-quiet btn-sm cast-reference-outfit" type="button"
              :aria-label="`采用参考图服装（${actor.name}）`" @click="applyReferenceOutfit(index)">
              <ArchiveIcon name="image" />采用参考图服装
            </button>
          </div>
          <div v-if="actor.outfitId === 'custom'" class="cast-stacked-field">
            <label :for="`${rosterId}-${index}-outfit-prompt`">自定义服装</label>
            <textarea :id="`${rosterId}-${index}-outfit-prompt`" class="textarea input-sm" rows="2" maxlength="400"
              :value="actor.member.outfitPrompt ?? ''" :aria-label="`${actor.name}的自定义服装`" placeholder="例如蓝色睡衣"
              @input="updateText(index, 'outfitPrompt', $event)" @compositionend="updateText(index, 'outfitPrompt', $event)" />
          </div>
          <div class="cast-field">
            <label :for="`${rosterId}-${index}-action`">个人动作</label>
            <input :id="`${rosterId}-${index}-action`" class="input input-sm" type="text" :value="actor.action"
              :aria-label="`${actor.name}的个人动作`" placeholder="选填，例如微笑挥手" maxlength="600"
              @input="updateText(index, 'action', $event)" @compositionend="updateText(index, 'action', $event)" />
          </div>
          <div class="cast-actor-footer">
            <button v-if="actor.member.source === 'custom'" class="btn btn-quiet btn-sm" type="button" :aria-label="`编辑${actor.name}`"
              @click="openOriginal($event, actor.member)">编辑角色</button>
            <button v-if="!actor.isLead" class="btn btn-quiet btn-sm" type="button" :aria-label="`将${actor.name}设为主角`"
              @click="setLead(index)">设为主角</button>
            <button v-if="pb.cast.length > 1 || actor.member.source === 'custom'" class="btn btn-quiet btn-sm cast-remove" type="button" :aria-label="`移除${actor.name}`"
              @click="removeActor(index)"><ArchiveIcon name="trash" />移除</button>
          </div>
        </li>
      </ol>
    </div>
    <p v-else-if="singleReferenceLabel" class="cast-status" role="status">{{ singleReferenceLabel }}</p>
    <p class="sr-only" role="status">{{ announcement }}</p>
    <div class="cast-add-actions">
      <button v-if="pb.cast.length" ref="addButton" class="btn btn-quiet btn-sm cast-add" type="button" aria-haspopup="dialog"
        :aria-disabled="pb.cast.length >= 5" @click="openDirectory">
        <ArchiveIcon name="plus" />{{ pb.cast.length >= 5 ? '已满 5 位同框角色' : '添加同框角色' }}
      </button>
      <button v-if="pb.cast.length < 5" ref="originalButton" class="btn btn-quiet btn-sm" type="button" aria-haspopup="dialog"
        @click="openOriginal($event)"><ArchiveIcon name="plus" />添加原创角色</button>
    </div>
    <DirectorOriginalActorDialog ref="original" @save="saveOriginal" />
    <CharacterDirectoryDialog ref="directory" title="添加同框角色"
      description="可混搭工作室角色与热门角色。点击肖像即可加入演员表。"
      :items="availableCharacters" selected-id="" @select="addActor">
      <template #notice>
        <p v-if="loadingCatalog" role="status">正在读取热门角色…</p>
        <div v-else-if="catalogError" class="cast-catalog-error">
          <p role="status">热门角色暂时无法读取。</p>
          <button type="button" class="btn btn-quiet btn-sm" @click="loadCatalog">重新读取</button>
        </div>
      </template>
    </CharacterDirectoryDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import DirectorOriginalActorDialog from '@/components/director/DirectorOriginalActorDialog.vue'
import CharacterDirectoryDialog from '@/components/library/CharacterDirectoryDialog.vue'
import type { DirectoryCharacter } from '@/components/library/CharacterDirectory.vue'
import CharacterPortrait from '@/components/library/CharacterPortrait.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'
import { characterArtEntry } from '@/platform/characterArtState'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { CastMember } from '@/types/prompt'
import { CANONICAL_OUTFITS } from '@/utils/canonicalOutfits'
import { singleReferenceCastOutfit } from '@/utils/mossCast'
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { castMemberKey, isCustomCastOutfit, parseCastFormation, referenceCharacterCount } from '@/utils/promptCast'

const props = defineProps<{ engine: string; canvasSize: string; sizeManuallySet: boolean; customMossLayout: boolean }>()
const pb = usePromptBuilderStore()
const rosterId = useId()
const formationId = useId()
const interactionId = useId()
const original = ref<InstanceType<typeof DirectorOriginalActorDialog> | null>(null)
const originalButton = ref<HTMLButtonElement | null>(null)
const directory = ref<InstanceType<typeof CharacterDirectoryDialog> | null>(null)
const roster = ref<HTMLOListElement | null>(null)
const addButton = ref<HTMLButtonElement | null>(null)
const loadingCatalog = ref(false)
const catalogError = ref(false)
const announcement = ref('')

const formations = { row: '横排一列', close: '亲密贴近', staggered: '前后错落合影' } as const
const formationOptions = computed(() => Object.entries(formations)
  .filter(([value]) => value !== 'staggered' || pb.cast.length >= 4).map(([value, label]) => ({ value, label })))
const displayedFormation = computed(() => pb.effectiveCastFormation === 'staggered' && pb.cast.length < 4 ? 'row' : pb.effectiveCastFormation)
const showRoster = computed(() => pb.cast.length > 1 || pb.cast.some(member => member.source === 'custom' || isCustomCastOutfit(member.outfitId)))
const studioCharacters = [
  { id: 'nene', name: '绫地宁宁', aliases: ['宁宁', 'Ayachi Nene', '綾地寧々'] },
  { id: 'natsume', name: '四季夏目', aliases: ['夏目', 'Shiki Natsume', '四季ナツメ'] },
] as const
const outfitNames = {
  neneWitch: '黑色魔女服',
  neneSchool: '学院制服',
  neneSailor: '深色水手服',
  neneRedCardigan: '红开衫校服',
  neneBluePajamas: '蓝色猫咪睡衣',
  neneGreenSleepwear: '薄荷绿睡裙',
  neneBatDress: '蝙蝠礼裙',
  neneBlackDress: '黑色连衣裙',
  natsumeQipao: '红色花纹旗袍',
  natsumeCafe: '咖啡店制服',
  natsumePinkCafe: '粉色咖啡店制服',
  natsumeMaid: '咖啡店女仆服',
  natsumeWinter: '冬季毛边外套',
  natsumeSleepwear: '浅蓝睡衣',
} satisfies Record<keyof typeof CANONICAL_OUTFITS, string>

type ActorDirectoryEntry = DirectoryCharacter & { characterId: string; kind: CastMember['source'] }
function actorKey(source: CastMember['source'], id: string) { return `${source}:${id}` }
const catalog = computed<ActorDirectoryEntry[]>(() => [
  ...studioCharacters.map(item => ({
    id: actorKey('studio', item.id),
    characterId: item.id,
    kind: 'studio' as const,
    name: item.name,
    source: '工作室角色',
    aliases: [...item.aliases],
    image: characterArtEntry(item.id)?.thumbnailUrl || `/assets/characters/${item.id}-home-cg-512.webp`,
  })),
  ...pb.popularCharacters.map(item => ({
    id: actorKey('popular', item.id),
    characterId: item.id,
    kind: 'popular' as const,
    name: item.displayName,
    source: item.franchise,
    aliases: item.aliases,
    image: popularPortraitSrc(item.id),
  })),
])
const availableCharacters = computed(() => {
  const occupied = new Set(pb.cast.map(item => actorKey(item.source, item.characterId)))
  return catalog.value.filter(item => !occupied.has(item.id))
})
const actors = computed(() => pb.cast.map((item, index) => {
  const key = actorKey(item.source, item.characterId)
  const person = catalog.value.find(entry => entry.id === key)
  const options = item.source === 'studio'
    ? Object.entries(outfitNames).filter(([id]) => id.startsWith(item.characterId)).map(([value, label]) => ({ value, label }))
    : pb.popularCharacters.find(character => character.id === item.characterId)?.outfits.map(outfit => ({ value: outfit.id, label: outfit.name })) ?? []
  return {
    key,
    isLead: pb.castLead !== null && castMemberKey(pb.castLead) === key,
    member: item,
    name: item.source === 'custom' ? item.name || '原创角色' : person?.name || item.characterId,
    image: resolveRuntimeUrl(person?.image),
    outfitId: isCustomCastOutfit(item.outfitId) || item.outfitExplicit && options.some(option => option.value === item.outfitId) ? item.outfitId : '',
    action: item.action ?? '',
    outfits: [{ value: '', label: props.engine === 'moss' && referenceCount.value >= 2 && index < referenceCount.value ? '跟随参考图服装' : '角色默认服装' }, ...options, { value: 'custom', label: '自定义服装' }, { value: 'none', label: '不穿默认服（清空）' }],
  }
}))
const referenceCount = computed(() => referenceCharacterCount(pb.referenceInput?.layout))
const referenceMapping = computed(() => referenceCount.value >= 2 && referenceCount.value >= pb.cast.length)
const referenceOutfit = computed(() => {
  if (props.engine !== 'anima' && (props.engine !== 'moss' || props.customMossLayout)) return ''
  return singleReferenceCastOutfit(pb.referenceInput)
})
const canChooseFormation = computed(() => props.engine === 'moss' && pb.cast.length >= 2 && !referenceMapping.value && !props.customMossLayout)
const staggered = computed(() => canChooseFormation.value && displayedFormation.value === 'staggered')
const placementLabel = computed(() => {
  const people = pb.cast.length
  if (props.engine === 'anima') return '按演员表从左到右排列。'
  if (props.engine !== 'moss') return '当前引擎沿用主角设置。同框构图可使用 MOSS 或 Anima。'
  if (props.customMossLayout) return '正在使用已编辑的 MOSS 布局。'
  if (referenceMapping.value) {
    const remaining = referenceCount.value - people
    return `已映射参考图 ${people} 个角色框${remaining ? `，另保留 ${remaining} 位参考配角` : ''}。`
  }
  const formation = formations[displayedFormation.value]
  if (referenceCount.value >= 2) return '参考服装按演员顺序分配，自动站位为' + formation + '。'
  return pb.referenceInput ? `参考图用于环境与氛围，自动站位为${formation}。` : `自动站位为${formation}。`
})
const singleReferenceLabel = computed(() => props.engine === 'moss' && !props.customMossLayout && referenceCount.value >= 2
  ? `参考图识别到 ${referenceCount.value} 位人物。添加同框角色可替换其余位置。` : '')

async function loadCatalog() {
  if (loadingCatalog.value || pb.popularCharacters.length) return
  loadingCatalog.value = true
  catalogError.value = false
  try { await pb.loadPopularCatalog() }
  catch { catalogError.value = true }
  finally { loadingCatalog.value = false }
}

function openDirectory() {
  const source = addButton.value
  if (!source || pb.cast.length >= 5) return
  void directory.value?.open(source)
  void loadCatalog()
}

function addActor(id: string) {
  const selected = availableCharacters.value.find(item => item.id === id)
  if (!selected || !pb.cast.length || pb.cast.length >= 5) return
  const firstPartner = pb.cast.length === 1
  pb.addCoStar({ source: selected.kind, characterId: selected.characterId, outfitId: '', outfitExplicit: false })
  recommendWideCanvas(firstPartner)
}

function recommendWideCanvas(firstPartner: boolean) {
  if (!firstPartner || pb.cast.length !== 2 || props.sizeManuallySet || pb.sdParamsTouched.has('size')) return
  const [width, height] = props.canvasSize.split(/[x×:]/).map(Number)
  if (width < height) pb.flash('当前是竖屏。想给两位角色留出更多空间，可以在画幅中选择横屏。', 4200)
}

function setFormation(value: string | number) {
  const formation = parseCastFormation(value)
  if (formation) pb.castFormation = formation
}

function setOutfit(index: number, value: string | number) {
  const outfitId = String(value)
  if (outfitId === 'custom' && referenceOutfit.value) {
    applyReferenceOutfit(index)
    return
  }
  pb.updateCastMember(index, { outfitId, outfitExplicit: Boolean(outfitId) })
}

function applyReferenceOutfit(index: number) {
  const actor = actors.value[index]
  const outfitPrompt = referenceOutfit.value
  if (!actor || !outfitPrompt) return
  pb.updateCastMember(index, { outfitId: 'custom', outfitExplicit: true, outfitPrompt })
  announcement.value = `${actor.name}已采用参考图服装。`
}

function updateText(index: number, field: 'outfitPrompt' | 'action', event: Event) {
  if (event instanceof InputEvent && event.isComposing) return
  const input = event.target
  if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) pb.updateCastMember(index, { [field]: input.value })
}

function openOriginal(event: MouseEvent, member?: CastMember) {
  if (event.currentTarget instanceof HTMLElement && (member || pb.cast.length < 5)) original.value?.open(event.currentTarget, member)
}

async function saveOriginal(id: string | null, identity: Pick<CastMember, 'name' | 'appearance' | 'gender'>) {
  if (id) {
    pb.updateCastMember(pb.cast.findIndex(member => member.source === 'custom' && member.characterId === id), identity)
    return
  }
  const firstPartner = pb.cast.length === 1
  const characterId = globalThis.crypto?.randomUUID?.() ?? `oc-${Date.now()}-${Math.random().toString(36).slice(2)}`
  pb.addCoStar({ source: 'custom', characterId, outfitId: '', ...identity })
  recommendWideCanvas(firstPartner)
  await nextTick()
  if (document.activeElement === document.body) addButton.value?.focus({ preventScroll: true })
}

async function setLead(index: number) {
  const actor = actors.value[index]
  pb.selectCastLead(index)
  announcement.value = `${actor.name}已设为主角。`
  await nextTick()
  if (document.activeElement === document.body) roster.value?.children[index]?.querySelector<HTMLElement>('.cast-remove')?.focus({ preventScroll: true })
}

async function moveActor(index: number, step: number, event: MouseEvent) {
  const next = index + step
  if (next < 0 || next >= actors.value.length) return
  const control = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  const focused = document.activeElement === control
  const actor = actors.value[index]
  pb.moveCastMember(index, next)
  announcement.value = `${actor.name}位于第 ${next + 1} 位。`
  // A keyed Vue move can detach and reinsert the same focused DOM node.
  await nextTick()
  if (focused && document.activeElement === document.body) control?.focus({ preventScroll: true })
}

async function removeActor(index: number) {
  const actor = actors.value[index]
  pb.removeCastMember(index)
  announcement.value = `已移除${actor.name}，剩余 ${pb.cast.length} 位角色。`
  await nextTick()
  if (document.activeElement === document.body) {
    const next = roster.value?.children[Math.min(index, actors.value.length - 1)]?.querySelector<HTMLElement>('.cast-remove')
    ;(next ?? addButton.value ?? originalButton.value)?.focus({ preventScroll: true })
  }
}
</script>

<style scoped>
.director-cast, .cast-roster, .cast-list, .cast-actor { display: grid; gap: var(--s-2); min-inline-size: 0; }
.director-cast { margin-block-start: var(--s-3); }
.cast-roster { gap: var(--s-3); }
.cast-roster h3 {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--s-2);
  margin: 0;
  color: var(--text-primary);
  font: 650 var(--fs-title-xs)/var(--lh-body) var(--font-sans);
}
.cast-roster h3 span, .cast-status, .cast-actor-name small, .cast-field label, .cast-stacked-field label {
  color: var(--text-secondary);
  font: 500 var(--fs-label)/var(--lh-label) var(--font-sans);
}
.cast-status { margin: 0; }
.cast-list { margin: 0; padding: 0; list-style: none; }
.cast-actor {
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
}
.cast-actor-header, .cast-actor-actions, .cast-catalog-error, .cast-actor-footer, .cast-add-actions { display: flex; align-items: center; gap: var(--s-2); min-inline-size: 0; }
.cast-actor-header :deep(.character-portrait) { inline-size: 2rem; block-size: 2.5rem; }
.cast-actor-name, .cast-field, .cast-stacked-field { display: grid; gap: var(--s-1); min-inline-size: 0; }
.cast-actor-name strong { color: var(--text-primary); overflow-wrap: anywhere; }
.cast-actor-actions { margin-inline-start: auto; gap: 0; }
.cast-actor-actions .btn { min-inline-size: var(--control-height-sm); padding-inline: var(--s-1); }
.cast-move-earlier .archive-icon { transform: rotate(180deg); }
.cast-actor-actions [aria-disabled='true'], .cast-add[aria-disabled='true'] { color: var(--text-disabled); cursor: default; }
.director-cast .btn[aria-disabled='true']:focus-visible { outline: 2px solid var(--focus-color); outline-offset: 2px; }
.cast-field { grid-template-columns: 4em minmax(0, 1fr); align-items: center; }
.cast-reference-outfit { grid-column: 2; justify-self: start; }
.cast-actor-footer, .cast-add-actions { flex-wrap: wrap; }
.cast-actor-footer { justify-content: end; }
.cast-stacked-field textarea { min-block-size: calc(2 * var(--control-height-sm)); }
</style>
