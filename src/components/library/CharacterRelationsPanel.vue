<script setup lang="ts">
import { computed, nextTick, onDeactivated, ref, toRef, useId, watch } from 'vue'
import { VueFlow, useVueFlow, type EdgeChange } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import type { CharacterProfile } from '@/types/character'
import { useCharacterRelations } from '@/composables/useCharacterRelations'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import { useFluidDialog } from '@/composables/useFluidDialog'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import CharacterRelationTerritory from './CharacterRelationTerritory.vue'
import CharacterRelationPortrait from './CharacterRelationPortrait.vue'
import { useRelationCircles } from '@/composables/useRelationCircles'

const props = defineProps<{ profiles: CharacterProfile[]; characterId: string }>()
const emit = defineEmits<{ openProfile: [id: string] }>()

const {
  graph, invalid, scope, showSpoilers, pendingOnly, pendingPeople, visiblePeople, visibleRelations,
  centerPerson, selectedPerson, selectedProfile, selectedRelation, selectedConnections, nodes, edges,
  selectPerson, selectRelation, setHoveredPerson, setHoveredRelation, isAnyActive, expandPerson, reset,
  personQuery, matchingPeople, listedRelations, locatePerson, clearSelection,
  safePeople, safeRelations, profileFor,
} = useCharacterRelations(toRef(props, 'profiles'), toRef(props, 'characterId'))

const circlePeople = computed(() => pendingOnly.value ? safePeople.value.filter(person => !profileFor(person)) : safePeople.value)
const {
  mode, dimension, options: circleOptions, enabled: circlesEnabled, dimensionLabel, groups, groupId, activeGroup,
  members, groupRelations, outsideConnections, hoveredGroup, overview, openGroup, reveal, canvasNodes, canvasEdges,
} = useRelationCircles({ work: computed(() => graph.value?.work || ''), people: circlePeople, classificationPeople: safePeople, relations: safeRelations,
  nodes, edges, profileFor, clearSelection })
watch([circlesEnabled, toRef(props, 'characterId')], ([enabled]) => {
  if (enabled) { scope.value = 'work'; overview() }
}, { immediate: true, flush: 'post' })
const inspectorRelations = computed(() => circlesEnabled.value ? groupRelations.value : listedRelations.value)
function explorePerson(id: string) { mode.value = 'person'; expandPerson(id) }
async function enterGroup(id: string) {
  inspectorCollapsed.value = true; openGroup(id)
  await nextTick(); canvas.value?.focus({ preventScroll: true })
}
async function showOverview() { overview(); await nextTick(); canvas.value?.focus({ preventScroll: true }) }

const flowId = useId(), canvasId = useId(), helpId = useId()
const { fitView, zoomIn, zoomOut, getViewport, setViewport } = useVueFlow(flowId)

const isFullscreen = ref(false)
const inspectorCollapsed = ref(true)
const showInspector = computed(() => !inspectorCollapsed.value && (!circlesEnabled.value || !!activeGroup.value && (!!selectedPerson.value || !!selectedRelation.value)))
const inspectorToggle = ref<HTMLButtonElement | null>(null)
const canvas = ref<HTMLElement | null>(null)
const fullscreenDialog = ref<HTMLDialogElement | null>(null)
const fullscreenButton = ref<HTMLButtonElement | null>(null)
const { open: openFullscreen, close: closeFullscreen } = useFluidDialog(fullscreenDialog)

const name = (id: string) => graph.value?.people.find(person => person.id === id)?.name || ''
const topology = computed(() => `${mode.value}:${dimension.value}:${groupId.value}:${centerPerson.value?.id}:${canvasNodes.value.map(node => node.id).join(',')}:${visibleRelations.value.map(relation => relation.id).join(',')}`)
const duration = () => prefersReducedMotion() ? 0 : cssTimeToMilliseconds(getComputedStyle(document.documentElement).getPropertyValue('--motion-control'))

function fit() {
  if (!circlesEnabled.value || activeGroup.value) { frameMap(); return }
  void fitView({ padding: .12, minZoom: .65, maxZoom: 1, duration: duration() })
}
function frameMap() {
  if (!circlesEnabled.value) {
    const person = canvasNodes.value.find(node => node.type === 'portrait' && node.id === centerPerson.value?.id)
      || canvasNodes.value.find(node => node.type === 'portrait')
    if (person) void setViewport({ x: (canvas.value?.clientWidth || 1000) / 2 - (person.position.x + 54) * 1.1,
      y: (canvas.value?.clientHeight || 700) / 2 - (person.position.y + 74) * 1.1, zoom: 1.1 }, { duration: duration() })
    return
  }
  const currentGroup = centerPerson.value && profileFor(centerPerson.value)?.identity?.[dimension.value]
  const territory = canvasNodes.value.find(node => node.type === 'territory' && node.data.label === (activeGroup.value?.id || currentGroup))
    || canvasNodes.value.find(node => node.type === 'territory')
  if (!territory) return
  const shape = territory.data.shape
  const zoom = activeGroup.value ? Math.min(1, Math.max(.6, ((canvas.value?.clientHeight || 700) - 160) / (shape.height + 100))) : .9
  const centerX = territory.position.x + shape.width / 2 + (activeGroup.value ? 130 : 0), centerY = territory.position.y + shape.height / 2
  void setViewport({ x: (canvas.value?.clientWidth || 1000) / 2 - centerX * zoom, y: (canvas.value?.clientHeight || 700) / 2 - centerY * zoom, zoom }, { duration: duration() })
}
function focusAtlasNode(id: string) {
  if (!document.activeElement?.matches(':focus-visible')) return
  const node = canvasNodes.value.find(node => node.id === id)
  if (!node || !canvas.value) return
  const zoom = getViewport().zoom, width = node.data.shape?.width || 108, height = node.data.shape?.height || 148
  const viewport = getViewport()
  const left = node.position.x * zoom + viewport.x, top = node.position.y * zoom + viewport.y
  if (left >= 0 && top >= 0 && left + width * zoom <= canvas.value.clientWidth && top + height * zoom <= canvas.value.clientHeight) return
  void setViewport({ x: canvas.value.clientWidth / 2 - (node.position.x + width / 2) * zoom,
    y: canvas.value.clientHeight / 2 - (node.position.y + height / 2) * zoom, zoom }, { duration: duration() })
}
watch(topology, async () => { await nextTick(); frameMap() }, { flush: 'post' })
onDeactivated(() => { isFullscreen.value = false })

function resetView() {
  reset()
  if (circlesEnabled.value) { overview(); scope.value = 'work' }
  void nextTick(frameMap)
}

async function toggleFullscreen() {
  if (isFullscreen.value) {
    closeFullscreen()
    isFullscreen.value = false
  } else {
    isFullscreen.value = true
    await nextTick()
    openFullscreen(fullscreenButton.value)
  }
  await nextTick()
  fullscreenButton.value?.focus({ preventScroll: true })
  frameMap()
}

function inspectPerson(id: string) { inspectorCollapsed.value = false; selectPerson(id) }
function inspectRelation(id: string) { inspectorCollapsed.value = false; selectRelation(id) }
async function locate(id: string) {
  inspectorCollapsed.value = false
  const person = safePeople.value.find(person => person.id === id)
  if (circlesEnabled.value && person) {
    pendingOnly.value = false; reveal(person); selectPerson(id); personQuery.value = ''; scope.value = 'work'
  } else locatePerson(id)
  await nextTick(); canvas.value?.focus({ preventScroll: true }); frameMap()
}
async function setInspectorCollapsed(collapsed: boolean) {
  const returnFocus = document.activeElement?.closest('.relations-inspector, .relations-inspector-collapsed')
  inspectorCollapsed.value = collapsed
  if (returnFocus) { await nextTick(); inspectorToggle.value?.focus({ preventScroll: true }) }
}
function fitOnDoubleClick(event: MouseEvent) {
  if ((event.target as HTMLElement).classList.contains('vue-flow__pane')) fit()
}

function edgeSelection(changes: EdgeChange[]) {
  for (const change of changes) if (change.type === 'select') {
    if (change.selected) inspectRelation(change.id)
    else if (selectedRelation.value?.id === change.id) selectRelation('')
  }
}

function keyboardPan(event: KeyboardEvent) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
  const directions: Record<string, [number, number]> = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }
  const delta = directions[event.key]
  if (!delta) return
  event.preventDefault(); event.stopPropagation()
  const viewport = getViewport()
  void setViewport({ ...viewport, x: viewport.x + delta[0], y: viewport.y + delta[1] })
}

</script>

<template>
  <dialog ref="fullscreenDialog" class="relations-fullscreen-dialog" aria-label="人物关系沉浸画板" @cancel.prevent="toggleFullscreen" />
  <Teleport :to="fullscreenDialog || 'body'" :disabled="!isFullscreen">
  <section class="character-relations is-atlas" :class="{ 'is-fullscreen': isFullscreen }" aria-label="原作人物关系">
    <ArchiveStatePanel
      v-if="!graph"
      :kind="invalid ? 'error' : 'empty'"
      :title="invalid ? '人物关系资料格式有误' : '这部作品的关系待整理'"
      :message="invalid ? '请在内容目录中修正关系资料后重新打开。' : '尚未收录可核实的原作关系，整理后会在这里展示人物与待补档案。'"
    />
    <template v-else>
      <header class="relations-heading">
        <div>
          <span class="page-kicker">人物图谱</span>
          <h2>{{ graph.work }}</h2>
        </div>
        <div class="relations-heading-actions">
          <span class="relations-summary">{{ pendingPeople.length }} 位待补档案</span>
          <button ref="fullscreenButton" class="btn btn-ghost btn-sm" type="button" :aria-expanded="isFullscreen" :title="isFullscreen ? '退出全屏沉浸（Esc）' : '全屏沉浸画板'" @click="toggleFullscreen">
            <ArchiveIcon :name="isFullscreen ? 'compress' : 'expand'" />
            <span>{{ isFullscreen ? '退出沉浸' : '沉浸全屏' }}</span>
          </button>
        </div>
      </header>

      <div class="relations-browsebar">
      <div class="relations-toolbar">
        <div v-if="circleOptions.length" class="studio-segments studio-segments--compact" role="group" aria-label="关系浏览方式">
          <AnimatedSelection />
          <button type="button" :aria-pressed="mode === 'circles'" @click="mode = 'circles'">地图总览</button>
          <button type="button" :aria-pressed="mode === 'person'" @click="mode = 'person'">人物关系</button>
        </div>
        <StudioSelect v-if="circlesEnabled" v-model="dimension" :options="circleOptions" label="圈子划分方式" :hint="dimension === 'region' ? '按角色档案记载的出身地划分' : undefined" size="sm" inline />
        <div v-else class="studio-segments studio-segments--compact" role="group" aria-label="关系展示范围">
          <AnimatedSelection />
          <button type="button" :aria-pressed="scope === 'nearby'" @click="scope = 'nearby'">当前人物</button>
          <button type="button" :aria-pressed="scope === 'work'" @click="scope = 'work'">作品全貌</button>
        </div>
        <StudioCheckbox v-model:checked="pendingOnly" label="只看待补人物">只看待补人物</StudioCheckbox>
        <StudioCheckbox v-model:checked="showSpoilers" label="显示剧透关系">显示剧透关系</StudioCheckbox>
        <div class="relations-toolbar-spacer"></div>
        <button
          v-if="!circlesEnabled || (activeGroup && (selectedPerson || selectedRelation))"
          ref="inspectorToggle"
          class="btn btn-ghost btn-sm"
          type="button"
          :title="inspectorCollapsed ? '展开右侧说明栏' : '收起右侧说明栏以拓宽画布'"
          :aria-expanded="!inspectorCollapsed"
          @click="setInspectorCollapsed(!inspectorCollapsed)"
        >
          <ArchiveIcon :name="inspectorCollapsed ? 'expand' : 'minus'" />
          <span>{{ inspectorCollapsed ? '展开说明栏' : '收起说明栏' }}</span>
        </button>
      </div>

      <div class="relations-finder">
        <StudioSearch v-model="personQuery" label="查找关系网中的人物" placeholder="输入人物姓名或别名" size="sm" @keydown="event => { if (event.key === 'Enter' && !event.isComposing && matchingPeople.length === 1) locate(matchingPeople[0].id) }" />
        <div v-if="personQuery.trim()" class="relations-finder-results" aria-label="人物查找结果">
          <span v-if="!matchingPeople.length" role="status">未找到人物，请换个姓名或别名。</span>
          <button v-for="person in matchingPeople" :key="person.id" class="btn btn-ghost btn-sm" type="button" @click="locate(person.id)">
            {{ person.name }}<ArchiveIcon name="search" />
          </button>
        </div>
      </div>

      </div>
      <div class="relations-layout" :class="{ 'is-inspector-collapsed': !showInspector }">
        <div class="relations-map">
          <div class="relations-map-head">
            <template v-if="circlesEnabled">
              <div class="relations-circle-breadcrumb"><button v-if="activeGroup" class="btn btn-ghost btn-sm" type="button" @click="showOverview"><ArchiveIcon class="atlas-back" name="chevron-down" />返回{{ dimensionLabel }}总览</button><strong>{{ activeGroup?.id || dimensionLabel + '总览' }}</strong></div>
              <span>{{ activeGroup ? members.length + ' 位人物' : groups.length + ' 个' + dimensionLabel + ' · ' + circlePeople.length + ' 位人物' }}</span>
            </template>
            <template v-else><strong>{{ scope === 'nearby' ? centerPerson?.name + '的关系' : '作品人物关系' }}</strong><span>{{ visiblePeople.length }} 人 · {{ visibleRelations.length }} 条关系</span></template>
          </div>

          <div
            :id="canvasId"
            ref="canvas"
            class="relations-canvas"
            :class="{ 'has-focus-context': isAnyActive }"
            role="group"
            aria-label="人物地图画布，可用方向键移动、滚轮缩放"
            :aria-describedby="helpId"
            tabindex="0"
            @keydown="keyboardPan"
            @dblclick="fitOnDoubleClick"
          >
            <VueFlow
              :id="flowId"
              :nodes="canvasNodes"
              :edges="canvasEdges"
              :nodes-draggable="false"
              :nodes-connectable="false"
              :edges-updatable="false"
              :delete-key-code="null"
              :selection-key-code="null"
              :multi-selection-key-code="null"
              :zoom-on-scroll="true"
              :zoom-on-pinch="true"
              :pan-on-scroll="false"
              :pan-on-drag="[0, 1]"
              :pane-click-distance="6"
              :zoom-on-double-click="false"
              :min-zoom=".55"
              :max-zoom="2.5"
              :fit-view-on-init="false"
              @nodes-initialized="frameMap"
              @edge-click="(!circlesEnabled || activeGroup) && inspectRelation($event.edge.id)"
              @edge-mouse-enter="(!circlesEnabled || activeGroup) && setHoveredRelation($event.edge.id)"
              @edge-mouse-leave="setHoveredRelation('')"
              @pane-click="clearSelection"
              @edges-change="(!circlesEnabled || activeGroup) && edgeSelection($event)"
            >
              <template #node-territory="node"><CharacterRelationTerritory :data="node.data" @open="enterGroup" @hover="hoveredGroup = $event" @focus="focusAtlasNode(node.id)" /></template>
              <template #node-portrait="node"><CharacterRelationPortrait :data="node.data" @select="inspectPerson" @hover="(id, enter) => setHoveredPerson(enter ? id : '')" @focus="focusAtlasNode(node.id)" /></template>
            </VueFlow>

            <div class="relations-map-controls nopan" role="group" aria-label="关系图缩放与布局控制">
              <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="放大关系图" :aria-controls="canvasId" @click="zoomIn({ duration: duration() })">
                <ArchiveIcon name="plus" />
              </button>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="缩小关系图" :aria-controls="canvasId" @click="zoomOut({ duration: duration() })">
                <ArchiveIcon name="minus" />
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="fit">
                <ArchiveIcon name="expand" />{{ circlesEnabled && !activeGroup ? '查看全图' : '适合阅读' }}
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="resetView">
                {{ circlesEnabled ? '返回总览' : '回到主角' }}
              </button>
            </div>
          </div>

          <p :id="helpId" class="relations-map-help">
            {{ circlesEnabled && !activeGroup ? '单击区域进入 · 空白处拖动 · 滚轮缩放' : '单击肖像或连线查看关系 · 空白处拖动 · 中键可从人物上拖动 · 滚轮缩放' }}
          </p>
          <p v-if="circlesEnabled && !circlePeople.length" class="relations-map-empty" role="status">当前没有符合筛选的人物，请取消“只看待补人物”。</p>
          <p v-else-if="!circlesEnabled && !visibleRelations.length" class="relations-map-empty" role="status">
            {{ pendingOnly ? '当前范围内没有待补人物的关系，可切换作品全貌。' : '当前人物在此范围内暂无公开关系。' }}
          </p>
        </div>

        <aside v-if="showInspector" v-content-motion:fade="selectedRelation?.id || selectedPerson?.id" class="relations-inspector" aria-label="人物与关系说明">
          <section v-if="selectedRelation" :key="selectedRelation.id" v-content-motion:fade="selectedRelation.id" class="relation-description">
            <div class="relation-description-head">
              <span class="page-kicker">{{ selectedRelation.spoiler ? '剧透关系' : '原作关系' }}</span>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" title="收起说明栏" @click="setInspectorCollapsed(true)">
                <ArchiveIcon name="minus" />
              </button>
            </div>
            <h3>{{ name(selectedRelation.source) }} {{ selectedRelation.directed ? '→' : '与' }} {{ name(selectedRelation.target) }}</h3>
            <strong>{{ selectedRelation.label }}</strong>
            <p>{{ selectedRelation.description }}</p>
            <span class="relation-stage">{{ selectedRelation.stage }}</span>
            <a class="relation-evidence" :href="selectedRelation.evidence.url" target="_blank" rel="noopener noreferrer">{{ selectedRelation.evidence.title }} ↗</a>
          </section>

          <section v-else-if="selectedPerson" :key="selectedPerson.id" v-content-motion:fade="selectedPerson.id" class="relation-description">
            <div class="relation-description-head">
              <span class="page-kicker">{{ selectedProfile ? '已收录档案' : '待补档案' }}</span>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" title="收起说明栏" @click="setInspectorCollapsed(true)">
                <ArchiveIcon name="minus" />
              </button>
            </div>
            <h3>{{ selectedPerson.name }}</h3>
            <p v-if="!selectedProfile">{{ graph.work }}中的人物，尚未建立角色档案。补入档案后，会接回这个人物及已有关系。</p>
            <p v-else>查看与{{ selectedPerson.name }}相关的原作关系，或进入人物档案。</p>
            <div class="relation-person-actions">
              <button class="btn btn-ghost btn-sm" type="button" @click="explorePerson(selectedPerson.id)">以此人为中心</button>
              <button v-if="selectedProfile" class="btn btn-primary btn-sm" type="button" @click="emit('openProfile', selectedProfile.id)">进入档案</button>
            </div>
            <a v-if="selectedConnections[0]" class="relation-evidence" :href="selectedConnections[0].evidence.url" target="_blank" rel="noopener noreferrer">{{ selectedConnections[0].evidence.title }} ↗</a>
          </section>

          <section v-else class="relation-description relation-description--idle">
            <div class="relation-description-head">
              <span class="page-kicker">全貌探索</span>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" title="收起说明栏" @click="setInspectorCollapsed(true)">
                <ArchiveIcon name="minus" />
              </button>
            </div>
            <h3>点击人物或连线</h3>
            <p>在画布中点击任意人物卡片或连线，在此查看详细人设背景、剧情阶段与官方证据。</p>
          </section>

          <section class="relation-list" aria-label="可见关系列表">
            <div class="relation-list-heading"><h3>{{ circlesEnabled ? '圈内关系' : selectedPerson && !selectedRelation ? selectedPerson.name + '的关系' : '关系一览' }}</h3><span>{{ inspectorRelations.length }}</span></div>
            <button v-if="!circlesEnabled && selectedPerson && !selectedRelation" class="btn btn-ghost btn-sm" type="button" @click="clearSelection">查看全部可见关系</button>
            <p v-if="!inspectorRelations.length">{{ circlesEnabled ? '同属一个圈子，不代表人物之间已有直接关系。' : '当前范围暂无关系。' }}</p>
            <button
              v-for="relation in inspectorRelations"
              :key="relation.id"
              class="relation-list-item"
              type="button"
              :aria-pressed="selectedRelation?.id === relation.id"
              @click="inspectRelation(relation.id)"
              @mouseenter="setHoveredRelation(relation.id)"
              @mouseleave="setHoveredRelation('')"
            >
              <span>{{ name(relation.source) }} {{ relation.directed ? '→' : '与' }} {{ name(relation.target) }}</span>
              <strong>{{ relation.label }}</strong>
              <small>{{ relation.stage }}</small>
            </button>
            <template v-if="circlesEnabled && outsideConnections.length"><h3 class="relations-outside-title">圈外的联系</h3>
              <button v-for="connection in outsideConnections" :key="connection.relation.id" class="relation-list-item" type="button" @click="locate(connection.person.id)"><span>{{ connection.group }} · {{ connection.person.name }}</span><strong>{{ connection.relation.label }}</strong></button>
            </template>
          </section>
        </aside>

      </div>
    </template>
  </section>
  </Teleport>
</template>

<style scoped src="@/assets/css/character-relations.css"></style>
<style scoped src="@/assets/css/character-relations-atlas.css"></style>
