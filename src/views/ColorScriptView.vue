<template>
  <article class="page color-script-page creative-library-page">
    <CreativeLibraryHeader title="色彩情绪" description="光照与调色预设" />

    <section class="color-selection" data-route-arrive aria-labelledby="mood-palette-title">
    <header class="color-section-heading"><div><h2 id="mood-palette-title">心境色板</h2></div><span v-if="selected" class="color-current"><ArchiveIcon name="success" />已选 {{ selected.name }}</span></header>
    <div ref="moodGrid" class="mood-grid color-mood-grid">
      <button
        v-for="m in MOODS" :key="m.id"
        :data-mood="m.id"
        type="button" class="mood-card"
        :class="{ active: selected?.id === m.id }"
        :aria-pressed="selected?.id === m.id"
        @click="chooseMood(m.id)"
      >
        <div class="mood-strip" aria-hidden="true">
          <div v-for="c in m.palette" :key="c" class="mood-swatch" :style="{ '--swatch': c }"></div>
        </div>
        <div class="mood-body">
          <div class="mood-name"><ArchiveIcon :name="m.iconName" /> {{ m.name }}</div>
          <div class="mood-en">{{ m.en }}</div>
          <span class="mood-choice-mark" aria-hidden="true"><ArchiveIcon :name="selected?.id === m.id ? 'success' : 'chevron-down'" /></span>
        </div>
        <CardEdgeLight />
      </button>
    </div>
    </section>

      <section v-if="selected" v-content-motion:fade="selected.id" ref="resultPanel" class="result-panel" tabindex="-1" aria-labelledby="current-palette-title">
        <header class="palette-result-heading">
          <div><p>当前色板</p><h2 id="current-palette-title"><ArchiveIcon :name="selected.iconName" />{{ selected.name }}</h2></div>
          <RouterLink :to="'/prompt-builder?mood=' + selected.id" class="btn btn-primary"><ArchiveIcon name="spark" />进入工作台</RouterLink>
        </header>
        <div class="palette-content">
          <div class="palette tw:flex tw:flex-wrap tw:gap-s-2">
            <button v-for="c in selected.palette" :key="c" type="button" class="palette-swatch" :aria-label="`复制色号 ${c}`" @click="copyWithFeedback(c, `已复制色号 ${c}`)">
              <span class="palette-color" :style="{ '--swatch': c }" aria-hidden="true"></span>
              <span class="palette-code">{{ c }}<ArchiveIcon name="copy" /></span>
            </button>
          </div>
          <div class="mapping-grid">
            <div v-for="(val, key) in selected.mapping" :key="key" class="mapping-item">
              <div class="mapping-label">{{ key }}</div>
              <div class="mapping-value">{{ val }}</div>
            </div>
          </div>
        </div>
        <div v-if="violations.length" class="art-warn show">
          <ArchiveIcon name="warning" /> 检测到 {{ violations.length }} 个不建议使用的标签：{{ violations.join('、') }}
        </div>
        <div class="prompt-label">色彩预设词条</div>
        <div class="prompt-code" v-html="colorizedPrompt"></div>
        <div class="result-actions tw:flex tw:flex-wrap tw:gap-s-2">
          <StudioCopyButton class="btn btn-ghost" label="复制 Prompt" :content-key="selected.id" :action="copyPrompt" />
          <button class="btn btn-ghost" type="button" @click="exportTxt"><ArchiveIcon name="download" /> 导出 .txt</button>
          <button class="btn btn-ghost" type="button" @click="resetMood"><ArchiveIcon name="refresh" /> 重新选择</button>
        </div>
      </section>

    <details class="color-reading" :open="notebookOpen" @toggle="onNotebookToggle">
      <StudioDisclosureSummary><ArchiveIcon name="book" /><span><strong>光色手帖</strong><small>色彩搭配与光影参考</small></span></StudioDisclosureSummary>
      <div class="color-reading-body" data-disclosure-content>
      <template v-if="notebookRevealed">
    <AsyncPanel :loader="loadNotebook" label="光色手帖" v-slot="{ component }"><component :is="component" @choose="chooseMood" /></AsyncPanel>
    <h2 class="section-title">美术指导 · 色彩语言</h2>
    <div class="art-ref">
      <div class="art-ref-card good">
        <div class="art-ref-title"><ArchiveIcon name="success" /> 推荐使用</div>
        <div>
          <span v-for="t in GOOD_TAGS" :key="t" class="art-tag ok">{{ t }}</span>
        </div>
      </div>
      <div class="art-ref-card bad">
        <div class="art-ref-title"><ArchiveIcon name="close" /> 避免使用</div>
        <div>
          <span v-for="t in BANNED_TAGS" :key="t" class="art-tag no">{{ t }}</span>
        </div>
      </div>
    </div>

    <h2 class="section-title spaced">光影指导 · 让光芒诉说故事</h2>
    <div class="lighting-ref">
      <div v-for="l in LIGHTINGS" :key="l.name" class="lighting-mini">
        <div class="lighting-icon"><ArchiveIcon :name="l.iconName" /></div>
        <div class="lighting-name">{{ l.name }}</div>
        <div class="lighting-reason">{{ l.reason }}</div>
      </div>
    </div>
      </template>
      </div>
    </details>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/mood.css'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import CreativeLibraryHeader from '@/components/library/CreativeLibraryHeader.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import { ref, computed, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { COLOR_MOODS } from '@/config/promptConstants'
import { BANNED_TAGS } from '@/utils/promptDiagnostics'
import { scrollBehavior } from '@/utils/motionPreference'
import { downloadBlob } from '@/utils/downloadBlob'
const loadNotebook = () => import('@/components/library/ColorLightNotebook.vue')

const GOOD_TAGS = ['soft colors','pastel tones','warm atmosphere','gentle palette','muted tones','harmonious colors','warm soft lighting','backlit glow']
const LIGHTINGS = [
  { iconName:'goldenhour' as const,  name:'夕阳',   reason:'放学/黄昏/温馨/回忆' },
  { iconName:'windowlight' as const, name:'窗光',   reason:'室内/安静/治愈/独处' },
  { iconName:'backlight' as const,   name:'逆光',   reason:'神秘/回忆/感动/剪影' },
  { iconName:'moonlight' as const,   name:'月光',   reason:'夜晚/孤独/宁静/思念' },
  { iconName:'lantern' as const,     name:'暖光',   reason:'夜祭/温馨/安全感/传统' },
  { iconName:'overcast' as const,    name:'阴天柔光', reason:'平静/文艺/清新/日常' },
]

// Display guidance is descriptive; every exported color token comes from the compiler preset.
const GUIDANCE: Record<string, Record<string, string>> = {
  joy: {'色相':'暖黄色 / 浅橙色 / 柔粉','光照':'Golden Hour / 午后阳光 / 明亮','氛围':'活力 / 温暖 / 清爽','天气':'晴天 / 微风'},
  love: {'色相':'夕阳 / 粉色 / 暖光','光照':'Golden Hour / 逆光 / 柔光','氛围':'暧昧 / 心跳 / 羞涩','天气':'黄昏 / 樱花季'},
  calm: {'色相':'淡绿 / 青绿 / 奶白','光照':'阴天柔光 / 窗光 / 自然光','氛围':'安静 / 治愈 / 文艺','天气':'多云 / 雨后'},
  sad: {'色相':'蓝色 / 灰蓝 / 冷调','光照':'月光 / 阴天 / 冷调窗光','氛围':'孤独 / 回忆 / 思念','天气':'雨天 / 阴天 / 夜晚'},
  tension: {'色相':'紫蓝 / 深紫 / 冷调','光照':'月光 / 逆光 / 暗调','氛围':'神秘 / 距离 / 梦幻','天气':'夜晚 / 雾 / 雨'},
  warmth: {'色相':'暖橙 / 橘红 / 米黄','光照':'夜灯 / 烛光 / 室内暖光','氛围':'安全感 / 家庭 / 治愈','天气':'夜晚 / 秋雨'},
}
const MOODS = COLOR_MOODS.map(mood => ({ ...mood, palette: mood.colors, mapping: GUIDANCE[mood.id] }))

const route = useRoute(), router = useRouter()
function routeMood() { return MOODS.find(mood => mood.id === route.query.mood) ?? null }
const selected = ref<(typeof MOODS)[number] | null>(routeMood())
const notebookOpen = ref(route.query.notebook === '1')
const notebookRevealed = ref(notebookOpen.value)
watch(notebookOpen, open => { if (open) notebookRevealed.value = true }, { flush: 'sync' })
let restoringReading = false
watch(() => [route.path, route.query.mood, route.query.notebook], () => {
  if (route.path !== '/color-script') return
  restoringReading = true
  selected.value = routeMood()
  notebookOpen.value = route.query.notebook === '1'
  restoringReading = false
}, { flush: 'sync' })
watch([selected, notebookOpen], ([mood, notebook]) => {
  if (restoringReading || route.path !== '/color-script') return
  const id = mood?.id ?? '', requested = typeof route.query.mood === 'string' ? route.query.mood : ''
  if (id === requested && notebook === (route.query.notebook === '1')) return
  const query = { ...route.query }
  if (id) query.mood = id
  else delete query.mood
  if (notebook) query.notebook = '1'
  else delete query.notebook
  void router.replace({ path: route.path, query, hash: route.hash })
}, { flush: 'sync' })
function onNotebookToggle(event: Event) {
  const panel = event.currentTarget
  if (route.path === '/color-script' && panel instanceof HTMLDetailsElement && panel.isConnected
    && !panel.closest('[inert]') && panel.open !== notebookOpen.value) notebookOpen.value = panel.open
}
const resultPanel = ref<HTMLElement | null>(null)
const moodGrid = ref<HTMLElement | null>(null)
async function resetMood() {
  const id = selected.value?.id
  selected.value = null
  await nextTick()
  const choice = moodGrid.value?.querySelector<HTMLButtonElement>(`[data-mood="${id}"]`)
  choice?.focus({ preventScroll: true })
  choice?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() })
}

async function chooseMood(id: string) {
  selected.value = MOODS.find(mood => mood.id === id) ?? null
  await nextTick()
  const panel = resultPanel.value
  if (!panel?.isConnected || panel.closest('[inert]')) return
  panel.focus({ preventScroll: true })
  panel.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
}

function esc(s: string) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

const violations = computed(() => {
  if (!selected.value) return []
  const lower = selected.value.prompt.toLowerCase()
  return BANNED_TAGS.filter(b => lower.includes(b.toLowerCase()))
})

const colorizedPrompt = computed(() => {
  if (!selected.value) return ''
  return selected.value.prompt.split(',').map(tk => {
    const t = tk.trim()
    const low = t.toLowerCase().replace(/[\s\/]+/g, '_')
    const bad = BANNED_TAGS.some(b => low === b.toLowerCase().replace(/[\s\/]+/g,'_') || low.includes(b.toLowerCase().replace(/[\s\/]+/g,'_')))
    return bad ? `<span class="violate">${esc(tk)}</span>` : esc(tk)
  }).join(',')
})

async function copyPrompt() {
  if (!selected.value) return false
  return copyWithFeedback(selected.value.prompt)
}

function exportTxt() {
  if (!selected.value) return
  const body = selected.value.prompt + '\n\n# mood: ' + selected.value.id + '\n# usage: 色彩词条片段；可通过“带入工作台使用”采用同一预设'
  downloadBlob(new Blob([body], { type: 'text/plain' }), 'color-' + selected.value.id + '.txt')
}

// 走全局 AppToast。原先手搓 DOM 并挂 class="cs-toast" —— 而 .cs-toast
// 在任何样式表里都没有定义，那个提示一直是页面底部的无样式裸文本。
</script>

<style scoped>@reference "../assets/css/tailwind.css";
.color-section-heading, .palette-result-heading { @apply tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-3 tw:mb-s-4; }
.color-section-heading h2, .palette-result-heading h2 { @apply tw:m-0; font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.color-section-heading p { margin:var(--s-2) 0 0; color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.color-current { display:inline-flex; align-items:center; gap:var(--s-2); color:var(--text-primary); font-size:var(--fs-label-sm); }
.color-current .archive-icon { width:16px; height:16px; }
.color-script-page { --palette-duration:var(--motion-route); --palette-shift:-6px; --palette-press:.97; }
.color-mood-grid { grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr)); }
.color-mood-grid .mood-card { position:relative; isolation:isolate; border-radius:var(--r-lg); box-shadow:inset 0 1px 0 var(--glass-highlight); }
.color-mood-grid .mood-card.active { border-color:var(--border-strong); box-shadow:var(--shadow-sm); }
.color-mood-grid .mood-strip { height:72px; gap:var(--s-1); padding:var(--s-3) var(--s-3) 0; overflow:hidden; background:var(--bg-base); }
.color-mood-grid .mood-swatch { height:100%; border-radius:var(--r-sm) var(--r-sm) 0 0; transition:transform var(--palette-duration) var(--spring-soft); }
.color-mood-grid .mood-swatch:nth-child(even) { transform:translateY(8px); }
.color-mood-grid .mood-body { position:relative; padding:var(--s-4); padding-right:40px; transform:none; transition:none; }
.color-mood-grid .mood-card.active .mood-body { background:var(--bg-elevated); box-shadow:none; }
.color-mood-grid .mood-name { display:flex; align-items:center; gap:var(--s-2); }
.color-mood-grid .mood-name .archive-icon { width:18px; height:18px; color:var(--text-secondary); }
.color-mood-grid .mood-en { margin-top:var(--s-1); }
.mood-choice-mark { position:absolute; right:var(--s-3); top:50%; display:grid; place-items:center; width:24px; height:24px; border:1px solid var(--border-soft); border-radius:var(--r-sm); color:var(--text-secondary); background:var(--bg-surface); transform:translateY(-50%); }
.mood-choice-mark .archive-icon { width:14px; height:14px; transform:rotate(-90deg); }
.active .mood-choice-mark { color:var(--text-primary); border-color:var(--border-strong); }
.active .mood-choice-mark .archive-icon { transform:none; }
.color-mood-grid .mood-card:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.color-mood-grid .mood-card:focus-visible .mood-body { box-shadow:none; }
.palette-result-heading > div > p { @apply tw:m-0 tw:mb-s-2 tw:text-accent tw:text-label-xs; }
.palette-result-heading h2 { @apply tw:flex tw:items-center tw:gap-s-2; }
.palette-result-heading h2 .archive-icon { @apply tw:text-accent; }
.palette-content { @apply tw:grid tw:gap-s-5 tw:mb-s-4; grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr)); align-items:start; }
.color-reading { @apply tw:mt-s-6; border:1px solid var(--border-soft); border-radius:var(--r-lg); padding-inline:var(--s-4); background:var(--bg-surface); }
.color-reading > summary { @apply tw:flex tw:items-center tw:gap-s-3 tw:min-h-[72px] tw:cursor-pointer; list-style:none; padding:var(--s-3); margin-inline:calc(-1 * var(--s-3)); border-radius:var(--r-md); }
.color-reading > summary::-webkit-details-marker { display:none; }
.color-reading > summary strong { @apply tw:text-primary tw:text-body tw:font-semibold; }
.color-reading > summary small { display:block; margin-top:var(--s-1); color:var(--text-secondary); font-size:var(--fs-label-sm); }
.color-reading > summary > .archive-icon:first-child { @apply tw:text-accent tw:w-[24px] tw:h-[24px]; }
.color-reading > summary > .archive-icon:last-child { @apply tw:ml-auto tw:text-muted; }
.color-reading > summary:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.color-reading-body { @apply tw:pb-s-5; }
.color-reading-body :deep(.light-notebook) { margin-top:var(--s-4); }
.section-title { @apply tw:text-title-sm tw:font-bold tw:mb-s-2; }
.section-title.spaced { @apply tw:mt-s-6; }

.result-panel { @apply tw:p-s-5; border:1px solid var(--border-soft); @apply tw:rounded-xl; background:var(--bg-surface); @apply tw:mt-s-5; }
.result-panel,.color-mood-grid .mood-card { scroll-margin-block:calc(var(--desktop-chrome-height,0px) + var(--app-navigation-height,80px) + var(--s-4)); }
/* 色号使用稳定阅读底色，不受任意深浅的样本色影响。 */
.palette-swatch { flex:1 1 88px; width:88px; overflow:hidden; padding:0; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); cursor:pointer; }
.palette-swatch:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.palette-color { display:block; height:56px; background:var(--swatch); transform-origin:bottom; transition:transform var(--palette-duration) var(--spring-soft); }
.palette-code { display:flex; align-items:center; justify-content:center; gap:var(--s-1); padding:var(--s-2) var(--s-1); color:var(--text-primary); font:500 var(--fs-label-xs)/var(--lh-label) var(--font-mono); }
.palette-code .archive-icon { flex:none; width:12px; height:12px; color:var(--text-secondary); }
.mapping-grid { @apply tw:grid; grid-template-columns:repeat(2,minmax(0,1fr)); @apply tw:gap-s-3; }
.mapping-item { background:var(--bg-elevated); border:1px solid var(--border-soft); @apply tw:rounded-md tw:p-s-3; }
.mapping-label { @apply tw:text-label-sm tw:text-muted tw:uppercase; letter-spacing:.05em; @apply tw:mb-s-1; }
.mapping-value { @apply tw:text-body tw:font-semibold; }
.prompt-label { @apply tw:mb-s-1 tw:text-accent tw:text-label-sm tw:font-semibold; letter-spacing:.06em; @apply tw:uppercase; }
.prompt-code { @apply tw:p-s-3; background:var(--bg-elevated); @apply tw:rounded-md tw:font-mono tw:text-mono-sm tw:leading-loose tw:mb-s-3; word-break:break-word; }
:deep(.violate) { @apply tw:text-danger-text; text-decoration:underline wavy; }
.art-warn { @apply tw:hidden tw:items-center tw:gap-s-2; background:color-mix(in srgb,var(--warning) 12%,transparent); border:1px solid var(--warning); @apply tw:rounded-md; padding:var(--s-2) var(--s-3); @apply tw:mb-s-3 tw:text-warning-text tw:text-label; }
.art-warn.show { @apply tw:flex; }

.art-ref { @apply tw:grid; grid-template-columns:1fr 1fr; @apply tw:gap-s-3 tw:mb-s-5; }
.art-ref-card { @apply tw:rounded-lg tw:p-s-4; border:1px solid var(--border-soft); }
.art-ref-card.good { background:color-mix(in srgb,var(--success) 6%,transparent); border-color:color-mix(in srgb,var(--success) 30%,transparent); }
.art-ref-card.bad { background:color-mix(in srgb,var(--danger) 6%,transparent); border-color:color-mix(in srgb,var(--danger) 30%,transparent); }
.art-ref-title { @apply tw:text-body tw:font-bold tw:mb-s-2; }
.art-ref-card.good .art-ref-title { @apply tw:text-success-text; }
.art-ref-card.bad .art-ref-title { @apply tw:text-danger-text; }
.art-tag { @apply tw:inline-block; margin:2px 3px; padding:3px var(--s-3); @apply tw:rounded-pill tw:text-label-sm tw:font-semibold; }
.art-tag.ok { background:color-mix(in srgb,var(--success) 12%,transparent); @apply tw:text-success-text; }
.art-tag.no { background:color-mix(in srgb,var(--danger) 12%,transparent); @apply tw:text-danger-text; }

.lighting-ref { @apply tw:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr)); @apply tw:gap-s-2 tw:mb-s-5; }
.lighting-mini { background:var(--bg-surface); border:1px solid var(--border-soft); @apply tw:rounded-md tw:p-s-3 tw:text-center; }
.lighting-icon { @apply tw:mb-[2px] tw:text-title; }
.lighting-name { @apply tw:text-body-sm tw:font-semibold; }
.lighting-reason { @apply tw:text-body-sm tw:text-secondary tw:mt-s-2 tw:leading-body; }


@media (hover:hover) and (pointer:fine) {
  .color-mood-grid .mood-card:hover:not(:focus-visible) .mood-swatch:nth-child(even) { transform:translateY(calc(8px + var(--palette-shift))); }
  .palette-swatch:hover:not(:focus-visible) .palette-color { transform:translateY(var(--palette-shift)); }
}
.palette-swatch:active:not(:focus-visible) .palette-color { transform:scale(var(--palette-press)); transition-duration:var(--motion-press); }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .color-script-page { --palette-duration:0s; --palette-shift:0px; --palette-press:1; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .color-script-page { --palette-duration:0s; --palette-shift:0px; --palette-press:1; }
@media (forced-colors:active) { .color-mood-grid .mood-card.active { outline:2px solid Highlight; } .palette-swatch:focus-visible,.color-mood-grid .mood-card:focus-visible { outline:2px solid Highlight; } }
@media(max-width:768px) { .art-ref { grid-template-columns:1fr; } }
@media(max-width:540px) { .mapping-grid { grid-template-columns:1fr; } }
</style>
