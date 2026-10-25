<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, useId, watch } from 'vue'
import { VueFlow, useVueFlow, type EdgeChange } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import type { CharacterProfile } from '@/types/character'
import { useCharacterRelations } from '@/composables/useCharacterRelations'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'
import CharacterRelationNode from './CharacterRelationNode.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioCheckbox from '@/components/ui/StudioCheckbox.vue'

const props = defineProps<{ profiles: CharacterProfile[]; characterId: string }>()
const emit = defineEmits<{ openProfile: [id: string] }>()

const {
  graph, invalid, scope, showSpoilers, pendingOnly, pendingPeople, visiblePeople, visibleRelations,
  centerPerson, selectedPerson, selectedProfile, selectedRelation, selectedConnections, nodes, edges,
  selectPerson, selectRelation, setHoveredPerson, setHoveredRelation, isAnyActive, expandPerson, reset,
} = useCharacterRelations(toRef(props, 'profiles'), toRef(props, 'characterId'))

const flowId = useId(), canvasId = useId(), helpId = useId()
const { fitView, zoomIn, zoomOut, getViewport, setViewport } = useVueFlow({ id: flowId })

const isFullscreen = ref(false)
const inspectorCollapsed = ref(false)

const name = (id: string) => graph.value?.people.find(person => person.id === id)?.name || ''
const topology = computed(() => `${centerPerson.value?.id}:${visiblePeople.value.map(person => person.id).join(',')}:${visibleRelations.value.map(relation => relation.id).join(',')}`)
const duration = () => prefersReducedMotion() ? 0 : cssTimeToMilliseconds(getComputedStyle(document.documentElement).getPropertyValue('--motion-control'))

function fit() { void fitView({ padding: .22, minZoom: .2, maxZoom: 1, duration: duration() }) }
watch(topology, async () => { await nextTick(); fit() }, { flush: 'post' })

function resetView() { reset(); void nextTick(fit) }

function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value
  void nextTick(() => fit())
}

function edgeSelection(changes: EdgeChange[]) {
  for (const change of changes) if (change.type === 'select') {
    if (change.selected) selectRelation(change.id)
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

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isFullscreen.value) {
    event.preventDefault()
    toggleFullscreen()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
})
</script>

<template>
  <section class="character-relations" :class="{ 'is-fullscreen': isFullscreen }" aria-label="原作人物关系">
    <ArchiveStatePanel
      v-if="!graph"
      :kind="invalid ? 'error' : 'empty'"
      :title="invalid ? '人物关系资料格式有误' : '这部作品的关系待整理'"
      :message="invalid ? '请在内容目录中修正关系资料后重新打开。' : '尚未收录可核实的原作关系，整理后会在这里展示人物与待补档案。'"
    />
    <template v-else>
      <header class="relations-heading">
        <div>
          <span class="page-kicker">原作人物关系</span>
          <h2>{{ graph.work }}</h2>
        </div>
        <div class="relations-heading-actions">
          <span class="relations-summary">{{ pendingPeople.length }} 位待补档案</span>
          <button class="btn btn-ghost btn-sm" type="button" :title="isFullscreen ? '退出全屏沉浸（Esc）' : '全屏沉浸画板'" @click="toggleFullscreen">
            <ArchiveIcon :name="isFullscreen ? 'compress' : 'expand'" />
            <span>{{ isFullscreen ? '退出沉浸' : '沉浸全屏' }}</span>
          </button>
        </div>
      </header>

      <div class="relations-toolbar">
        <div class="studio-segments studio-segments--compact" role="group" aria-label="关系展示范围">
          <AnimatedSelection />
          <button type="button" :aria-pressed="scope === 'nearby'" @click="scope = 'nearby'">当前人物</button>
          <button type="button" :aria-pressed="scope === 'work'" @click="scope = 'work'">作品全貌</button>
        </div>
        <StudioCheckbox v-model:checked="pendingOnly" label="只看待补人物">只看待补人物</StudioCheckbox>
        <StudioCheckbox v-model:checked="showSpoilers" label="显示剧透关系">显示剧透关系</StudioCheckbox>
        <div class="relations-toolbar-spacer"></div>
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :title="inspectorCollapsed ? '展开右侧说明栏' : '收起右侧说明栏以拓宽画布'"
          @click="inspectorCollapsed = !inspectorCollapsed"
        >
          <ArchiveIcon :name="inspectorCollapsed ? 'expand' : 'minus'" />
          <span>{{ inspectorCollapsed ? '展开说明栏' : '收起说明栏' }}</span>
        </button>
      </div>

      <div class="relations-layout" :class="{ 'is-inspector-collapsed': inspectorCollapsed }">
        <div class="relations-map">
          <div class="relations-map-head">
            <strong>{{ centerPerson?.name }}<span>为中心</span></strong>
            <span>{{ visiblePeople.length }} 人 · {{ visibleRelations.length }} 条关系</span>
          </div>

          <div
            :id="canvasId"
            class="relations-canvas"
            :class="{ 'has-focus-context': isAnyActive }"
            role="group"
            aria-label="人物关系画布，可用方向键移动，滚轮缩放，拖拽节点"
            :aria-describedby="helpId"
            tabindex="0"
            @keydown="keyboardPan"
          >
            <VueFlow
              :id="flowId"
              :nodes="nodes"
              :edges="edges"
              :nodes-draggable="true"
              :nodes-connectable="false"
              :edges-updatable="false"
              :delete-key-code="null"
              :selection-key-code="null"
              :multi-selection-key-code="null"
              :zoom-on-scroll="true"
              :zoom-on-pinch="true"
              :pan-on-scroll="false"
              :pan-on-drag="true"
              :zoom-on-double-click="true"
              :min-zoom=".2"
              :max-zoom="2.5"
              :fit-view-on-init="true"
              :fit-view-params="{ padding: .22, maxZoom: 1 }"
              @nodes-initialized="fit"
              @edge-click="selectRelation($event.edge.id)"
              @edge-mouse-enter="setHoveredRelation($event.edge.id)"
              @edge-mouse-leave="setHoveredRelation('')"
              @pane-click="selectRelation('')"
              @edges-change="edgeSelection"
            >
              <template #node-person="node">
                <CharacterRelationNode
                  :data="node.data"
                  @select="selectPerson"
                  @hover="(id, enter) => setHoveredPerson(enter ? id : '')"
                />
              </template>
            </VueFlow>

            <div class="relations-map-controls" role="group" aria-label="关系图缩放与布局控制">
              <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="放大关系图" :aria-controls="canvasId" @click="zoomIn({ duration: duration() })">
                <ArchiveIcon name="plus" />
              </button>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="缩小关系图" :aria-controls="canvasId" @click="zoomOut({ duration: duration() })">
                <ArchiveIcon name="minus" />
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="fit">
                <ArchiveIcon name="expand" />适应画布
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="resetView">
                回到主角
              </button>
            </div>
          </div>

          <p :id="helpId" class="relations-map-help">
            滚轮缩放，按住拖动漫游画布；人物支持自由拖拽摆放；双击空白自适应；鼠标悬停或点选人物聚焦关系圈。
          </p>
          <p v-if="!visibleRelations.length" class="relations-map-empty" role="status">
            {{ pendingOnly ? '当前范围内没有待补人物的关系，可切换作品全貌。' : '当前人物在此范围内暂无公开关系。' }}
          </p>
        </div>

        <aside v-if="!inspectorCollapsed" class="relations-inspector" aria-label="人物与关系说明">
          <section v-if="selectedRelation" :key="selectedRelation.id" v-content-motion:fade="selectedRelation.id" class="relation-description">
            <div class="relation-description-head">
              <span class="page-kicker">{{ selectedRelation.spoiler ? '剧透关系' : '原作关系' }}</span>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" title="收起说明栏" @click="inspectorCollapsed = true">
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
              <button class="btn btn-ghost btn-sm btn-icon" type="button" title="收起说明栏" @click="inspectorCollapsed = true">
                <ArchiveIcon name="minus" />
              </button>
            </div>
            <h3>{{ selectedPerson.name }}</h3>
            <p v-if="!selectedProfile">{{ graph.work }}中的人物，尚未建立角色档案。补入档案后，会接回这个人物及已有关系。</p>
            <p v-else>查看与{{ selectedPerson.name }}相关的原作关系，或进入人物档案。</p>
            <div class="relation-person-actions">
              <button class="btn btn-ghost btn-sm" type="button" @click="expandPerson(selectedPerson.id)">以此人为中心</button>
              <button v-if="selectedProfile" class="btn btn-primary btn-sm" type="button" @click="emit('openProfile', selectedProfile.id)">进入档案</button>
            </div>
            <a v-if="selectedConnections[0]" class="relation-evidence" :href="selectedConnections[0].evidence.url" target="_blank" rel="noopener noreferrer">{{ selectedConnections[0].evidence.title }} ↗</a>
          </section>

          <section v-else class="relation-description relation-description--idle">
            <div class="relation-description-head">
              <span class="page-kicker">全貌探索</span>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" title="收起说明栏" @click="inspectorCollapsed = true">
                <ArchiveIcon name="minus" />
              </button>
            </div>
            <h3>点击人物或连线</h3>
            <p>在画布中点击任意人物卡片或连线，在此查看详细人设背景、剧情阶段与官方证据。</p>
          </section>

          <section class="relation-list" aria-label="可见关系列表">
            <h3>关系一览</h3>
            <p v-if="!visibleRelations.length">当前范围暂无关系。</p>
            <button
              v-for="relation in visibleRelations"
              :key="relation.id"
              class="relation-list-item"
              type="button"
              :aria-pressed="selectedRelation?.id === relation.id"
              @click="selectRelation(relation.id)"
              @mouseenter="setHoveredRelation(relation.id)"
              @mouseleave="setHoveredRelation('')"
            >
              <span>{{ name(relation.source) }} {{ relation.directed ? '→' : '与' }} {{ name(relation.target) }}</span>
              <strong>{{ relation.label }}</strong>
              <small>{{ relation.stage }}</small>
            </button>
          </section>
        </aside>

        <div v-else class="relations-inspector-collapsed" role="button" tabindex="0" title="点击展开说明栏" @click="inspectorCollapsed = false" @keydown.enter="inspectorCollapsed = false">
          <ArchiveIcon name="character" />
          <span>展开说明</span>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped src="@/assets/css/character-relations.css"></style>
