<template>
  <Transition name="pet-orbit">
    <section v-if="open" ref="root" class="companion-orbit" :class="{ 'is-compact': compact, 'has-category': category }"
      :style="{ '--orbit-size': size + 'px' }" aria-label="桌宠环形菜单" @keydown="key" @contextmenu.prevent.stop="emit('close')">
      <header class="orbit-heading">
        <div><span class="orbit-kicker">陪伴菜单</span><strong>{{ characterName }}</strong></div>
        <button class="orbit-close" type="button" aria-label="收起桌宠菜单" @click="emit('close')"><ArchiveIcon name="close" /></button>
      </header>
      <div v-if="!compact || !category" class="orbit-wheel" role="group" aria-label="常用操作">
        <div v-for="(action, index) in actions" :key="action.id" class="orbit-segment"
          :data-active="active(action) || undefined" :data-tone="action.id" @click="activate(action)">
          <svg viewBox="0 0 440 440" aria-hidden="true"><path :d="orbitSector(index)" /></svg>
          <button type="button" class="orbit-action" :class="{ 'orbit-settings-trigger': action.id === 'settings' }"
            :style="{ '--orbit-x': position(orbitAngle(index), 127).left, '--orbit-y': position(orbitAngle(index), 127).top }" :aria-label="action.label" :aria-pressed="action.toggle ? active(action) : undefined"
            :aria-expanded="action.category ? category === action.category : undefined" :data-category-button="action.category || undefined">
            <ArchiveIcon :name="action.icon" /><span>{{ action.short }}</span>
          </button>
        </div>
        <template v-if="category && !compact">
          <StudioTooltip v-for="(option, index) in visibleOptions" :key="`${category}-${option.id}`" anchor :content="option.label"
            class="orbit-option-tooltip" :style="{ '--orbit-x': position(-67.5 + index * 360 / 8, 193).left, '--orbit-y': position(-67.5 + index * 360 / 8, 193).top }">
          <button type="button" class="orbit-option" :data-value="option.id" :aria-label="option.label"
            :aria-pressed="category === 'characters' ? option.id === characterId : undefined"
            :disabled="category !== 'characters' && (!controls?.ready || expressionBusy)" @click="choose(option)">
            <RuntimeImage v-if="option.image" :src="option.image" alt=""><template #fallback><ArchiveIcon name="character" /></template></RuntimeImage>
            <ArchiveIcon v-else :name="category === 'motions' ? 'spark' : 'happy'" />
            <span>{{ option.shortLabel || option.label }}</span>
          </button>
          </StudioTooltip>
        </template>
      </div>
      <section v-if="category" class="orbit-selection" :class="{ 'orbit-selection-compact': compact }" :aria-label="categoryLabel">
        <header>
          <button type="button" aria-label="返回常用操作" @click="category = null"><ArchiveIcon name="chevron-down" /></button>
          <strong>{{ categoryLabel }}</strong><span>{{ options.length }} 项</span>
        </header>
        <div v-if="compact" class="orbit-option-list">
          <button v-for="option in visibleOptions" :key="option.id" type="button" :data-value="option.id" :aria-label="option.label"
            :aria-pressed="category === 'characters' ? option.id === characterId : undefined"
            :disabled="category !== 'characters' && (!controls?.ready || expressionBusy)" @click="choose(option)">
            <RuntimeImage v-if="option.image" :src="option.image" alt=""><template #fallback><ArchiveIcon name="character" /></template></RuntimeImage>
            <ArchiveIcon v-else :name="category === 'motions' ? 'spark' : 'happy'" /><span>{{ option.label }}</span>
            <ArchiveIcon v-if="category === 'characters' && option.id === characterId" name="success" />
          </button>
        </div>
        <p v-if="category !== 'characters' && !controls?.ready">先在设置中加载动态立绘，再试试{{ categoryLabel }}。</p>
        <p v-else-if="!options.length">这个角色还没有配置{{ categoryLabel }}。</p>
        <footer v-if="pages > 1" class="orbit-pagination">
          <button type="button" aria-label="上一页" :disabled="page === 0" @click="page--">上一页</button>
          <span>{{ page + 1 }} / {{ pages }}</span>
          <button type="button" aria-label="下一页" :disabled="page + 1 === pages" @click="page++">下一页</button>
        </footer>
        <button v-if="category === 'characters'" class="orbit-manage" type="button" @click="emit('appearance')"><ArchiveIcon name="model" />导入与角色外观</button>
      </section>
      <p v-if="feedback || category === 'motions' && controls?.hint" class="orbit-feedback" role="status">{{ feedback || controls?.hint }}</p>
      <footer v-if="!category" class="orbit-guide">右键 / Esc 收起<span>·</span>拖动角色移动</footer>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import { characterArtEntry } from '@/platform/characterArtState'
import { computed, ref, watch } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import RuntimeImage from './visual/RuntimeImage.vue'
import StudioTooltip from './ui/StudioTooltip.vue'
import type { ArchiveIconName } from './visual/icons/types'
import { getCompanionCharacterConfig, listCompanionUiCharacters, resolveCompanionAvatar } from '@/utils/companionRegistry'
import { orbitAngle, orbitPoint, orbitSector, useCompanionOrbit } from '@/composables/chat/useCompanionOrbit'
import '@/assets/css/companion-orbit.css'

const props = defineProps<{
  open: boolean; characterId: string; characterName: string; pinned: boolean; passThrough: boolean
  controls?: { ready: boolean; motions: { id: string; label: string }[]; expressions: { id: string; label: string }[]; hint: string }
  setExpression?: (id: string) => Promise<boolean>
}>()
const emit = defineEmits<{
  close: []; settings: []; chat: []; pin: []; pass: []; hide: []; appearance: []
  character: [id: string]; motion: [id: string]
}>()
type Category = 'characters' | 'motions' | 'expressions'
interface Action { id: string; short: string; label: string; icon: ArchiveIconName; category?: Category; toggle?: boolean }
interface Option { id: string; label: string; shortLabel?: string; image?: string }
const root = ref<HTMLElement | null>(null)
const { compact, size, category, page, key } = useCompanionOrbit(() => props.open, root, () => emit('close'))
const feedback = ref(''), expressionBusy = ref(false)
let expressionTurn = 0
watch([() => props.characterId, () => props.open, category], () => { feedback.value = ''; expressionBusy.value = false; expressionTurn++ })
const actions: Action[] = [
  { id: 'settings', short: '设置', label: '设置', icon: 'gear' },
  { id: 'chat', short: '聊天', label: '打开聊天', icon: 'chat' },
  { id: 'characters', short: '角色', label: '切换陪伴角色', icon: 'character', category: 'characters' },
  { id: 'expressions', short: '表情', label: '角色表情', icon: 'happy', category: 'expressions' },
  { id: 'motions', short: '动作', label: '互动动作', icon: 'spark', category: 'motions' },
  { id: 'pin', short: '置顶', label: '置顶窗口', icon: 'pin', toggle: true },
  { id: 'pass', short: '穿透', label: '鼠标穿透', icon: 'eye', toggle: true },
  { id: 'hide', short: '隐藏', label: '隐藏桌宠', icon: 'moon' },
]
const characters = computed<Option[]>(() => listCompanionUiCharacters().map(character => ({
  id: character.id, label: character.name, shortLabel: character.shortName,
  image: characterArtEntry(character.id)?.thumbnailUrl || resolveCompanionAvatar(character.id)?.avatar.thumbnailUrl || getCompanionCharacterConfig(character.id)?.image,
})))
const options = computed<Option[]>(() => category.value === 'characters' ? characters.value : category.value === 'motions' ? props.controls?.motions || []
  : props.controls?.expressions.length ? [{ id: '', label: '恢复默认' }, ...props.controls.expressions] : [])
const pages = computed(() => Math.max(1, Math.ceil(options.value.length / 8)))
const visibleOptions = computed(() => options.value.slice(page.value * 8, (page.value + 1) * 8))
const categoryLabel = computed(() => category.value === 'characters' ? '陪伴角色' : category.value === 'motions' ? '互动动作' : '角色表情')
watch(pages, count => { page.value = Math.min(page.value, count - 1) })
function position(angle: number, radius: number) {
  const point = orbitPoint(angle, radius)
  return { left: `${point.x / 4.4}%`, top: `${point.y / 4.4}%` }
}
function active(action: Action) { return action.category ? category.value === action.category : action.id === 'pin' ? props.pinned : action.id === 'pass' ? props.passThrough : false }
// The icon and painted sector share one click owner: a press/release crossing
// their boundary targets this ancestor. Child handlers would silently lose it.
function activate(action: Action) {
  if (action.category) { category.value = category.value === action.category ? null : action.category; return }
  if (action.id === 'settings') emit('settings')
  else if (action.id === 'chat') emit('chat')
  else if (action.id === 'pin') emit('pin')
  else if (action.id === 'pass') { emit('pass'); emit('close') }
  else if (action.id === 'hide') { emit('hide'); emit('close') }
}
async function choose(option: Option) {
  if (category.value === 'characters') { emit('character', option.id); return }
  if (!props.controls?.ready) return
  if (category.value === 'motions') { emit('motion', option.id); return }
  if (!props.setExpression || expressionBusy.value) return
  expressionBusy.value = true
  const turn = ++expressionTurn
  try {
    const applied = await props.setExpression(option.id)
    if (turn === expressionTurn) feedback.value = applied ? `已切换：${option.label}` : '表情暂时没有切换成功，请重试。'
  } catch { if (turn === expressionTurn) feedback.value = '表情暂时不可用，请重试。' }
  finally { if (turn === expressionTurn) expressionBusy.value = false }
}
</script>

<style scoped>
.orbit-option-tooltip { position:absolute; left:var(--orbit-x); top:var(--orbit-y); transform:translate(-50%, -50%); pointer-events:auto; }
.orbit-option-tooltip :deep(.orbit-option) { position:relative; left:auto; top:auto; transform:none; }
</style>
