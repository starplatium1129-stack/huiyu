<template>
  <article class="page color-script-page creative-library-page">
    <CreativeLibraryHeader title="色彩情绪" description="选一种心情，把这一幕的色彩与光照带入工作台。" />

    <section class="color-selection" aria-labelledby="mood-palette-title">
    <header class="color-section-heading"><h2 id="mood-palette-title">今日心境色板</h2><p>六种情绪，从你想讲述的片刻开始。</p></header>
    <div ref="moodGrid" class="mood-grid color-mood-grid">
      <button
        v-for="m in MOODS" :key="m.id"
        :data-mood="m.id"
        type="button" class="mood-card"
        :class="{ active: selected?.id === m.id }"
        :aria-pressed="selected?.id === m.id"
        :style="{ '--mood-color': m.color }"
        @click="select(m)"
      >
        <div class="mood-strip">
          <div v-for="c in m.palette" :key="c" class="mood-swatch" :style="{ '--swatch': c }"></div>
        </div>
        <div class="mood-body">
          <div class="mood-name"><ArchiveIcon :name="m.iconName" /> {{ m.name }}</div>
          <div class="mood-en">{{ m.en }}</div>
        </div>
      </button>
    </div>
    </section>

    <Transition name="fade-up">
      <section v-if="selected" ref="resultPanel" class="result-panel" tabindex="-1" aria-labelledby="current-palette-title">
        <header class="palette-result-heading">
          <div><p>当前色板</p><h2 id="current-palette-title"><ArchiveIcon :name="selected.iconName" />{{ selected.name }}的色彩与光照</h2></div>
          <RouterLink :to="'/prompt-builder?mood=' + selected.id" class="btn btn-primary"><ArchiveIcon name="spark" />带入工作台使用</RouterLink>
        </header>
        <div class="palette-content">
          <div class="palette tw:flex tw:flex-wrap tw:gap-s-2">
            <div v-for="c in selected.palette" :key="c" class="palette-swatch">
              <span class="palette-color" :style="{ '--swatch': c }" aria-hidden="true"></span>
              <span class="palette-code">{{ c }}</span>
            </div>
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
        <div class="prompt-label">自动翻译 Prompt</div>
        <div class="prompt-code" v-html="colorizedPrompt"></div>
        <div class="result-actions tw:flex tw:flex-wrap tw:gap-s-2">
          <button class="btn btn-ghost" type="button" @click="copyPrompt"><ArchiveIcon name="copy" /> 复制 Prompt</button>
          <button class="btn btn-ghost" type="button" @click="exportTxt"><ArchiveIcon name="download" /> 导出 .txt</button>
          <button class="btn btn-ghost" type="button" @click="resetMood"><ArchiveIcon name="refresh" /> 换一个情绪</button>
        </div>
      </section>
    </Transition>
    <p v-if="!selected" class="color-selection-hint"><ArchiveIcon name="palette" />选中一种情绪后，在这里查看色板与光照，再带入工作台。</p>

    <details class="color-reading">
      <summary><ArchiveIcon name="book" /><span><strong>光色手帖</strong><small>光源对照、氛围观察与提示词用法</small></span><ArchiveIcon name="chevron-down" /></summary>
      <div class="color-reading-body">
    <ColorLightNotebook @choose="chooseMood" />
    <h2 class="section-title">美术指导 · 色彩语言</h2>
    <p class="note tw:mb-s-3 tw:text-body-sm tw:text-muted">写下提示词前，先问自己：“这段文字是否准确勾勒出了心中的氛围与情绪？”</p>
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
    <p class="note tw:mb-s-3 tw:text-body-sm tw:text-muted">每一束光线都有出现的理由，它服务于此刻的空气、时间与叙事。</p>
    <div class="lighting-ref">
      <div v-for="l in LIGHTINGS" :key="l.name" class="lighting-mini">
        <div class="lighting-icon"><ArchiveIcon :name="l.iconName" /></div>
        <div class="lighting-name">{{ l.name }}</div>
        <div class="lighting-reason">{{ l.reason }}</div>
      </div>
    </div>
      </div>
    </details>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/mood.css'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import CreativeLibraryHeader from '@/components/library/CreativeLibraryHeader.vue'
import ColorLightNotebook from '@/components/library/ColorLightNotebook.vue'
import { ref, computed, nextTick } from 'vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { BANNED_TAGS } from '@/utils/promptPolicy'

const GOOD_TAGS = ['soft colors','pastel tones','warm atmosphere','gentle palette','muted tones','harmonious colors','warm soft lighting','backlit glow']
const LIGHTINGS = [
  { iconName:'goldenhour' as const,  name:'夕阳',   reason:'放学/黄昏/温馨/回忆' },
  { iconName:'windowlight' as const, name:'窗光',   reason:'室内/安静/治愈/独处' },
  { iconName:'backlight' as const,   name:'逆光',   reason:'神秘/回忆/感动/剪影' },
  { iconName:'moonlight' as const,   name:'月光',   reason:'夜晚/孤独/宁静/思念' },
  { iconName:'lantern' as const,     name:'暖光',   reason:'夜祭/温馨/安全感/传统' },
  { iconName:'overcast' as const,    name:'阴天柔光', reason:'平静/文艺/清新/日常' },
]

interface ColorMood {
  id: string
  iconName: ArchiveIconName
  name: string
  en: string
  color: string
  palette: string[]
  mapping: Record<string, string>
  prompt: string
}

const MOODS: ColorMood[] = [
  { id:'joy',     iconName:'sun',       name:'快乐', en:'Joy',     color:'#FFD54F', palette:['#FFE082','#FFD54F','#FFB300','#FF8F00','#FFF8E1'], mapping:{'色相':'暖黄色 / 浅橙色 / 柔粉','光照':'Golden Hour / 午后阳光 / 明亮','氛围':'活力 / 温暖 / 清爽','天气':'晴天 / 微风'}, prompt:'warm yellow tones, warm color palette, vibrant but soft' },
  { id:'love',    iconName:'love',      name:'恋爱', en:'Love',    color:'#F06292', palette:['#F8BBD0','#F06292','#EC407A','#AD1457','#FFF0F5'], mapping:{'色相':'夕阳 / 粉色 / 暖光','光照':'Golden Hour / 逆光 / 柔光','氛围':'暧昧 / 心跳 / 羞涩','天气':'黄昏 / 樱花季'}, prompt:'pink tones, warm color palette, gentle colors' },
  { id:'calm',    iconName:'leaf',      name:'平静', en:'Calm',    color:'#81C784', palette:['#C8E6C9','#81C784','#4CAF50','#2E7D32','#F1F8E9'], mapping:{'色相':'淡绿 / 青绿 / 奶白','光照':'阴天柔光 / 窗光 / 自然光','氛围':'安静 / 治愈 / 文艺','天气':'多云 / 雨后'}, prompt:'soft green tones, muted tones, gentle palette' },
  { id:'sad',     iconName:'rain',      name:'忧伤', en:'Sad',     color:'#64B5F6', palette:['#BBDEFB','#64B5F6','#1E88E5','#0D47A1','#E3F2FD'], mapping:{'色相':'蓝色 / 灰蓝 / 冷调','光照':'月光 / 阴天 / 冷调窗光','氛围':'孤独 / 回忆 / 思念','天气':'雨天 / 阴天 / 夜晚'}, prompt:'blue tones, cool color palette, muted tones' },
  { id:'tension', iconName:'moonlight', name:'神秘', en:'Mystery', color:'#BA68C8', palette:['#E1BEE7','#BA68C8','#8E24AA','#4A148C','#F3E5F5'], mapping:{'色相':'紫蓝 / 深紫 / 冷调','光照':'月光 / 逆光 / 暗调','氛围':'神秘 / 距离 / 梦幻','天气':'夜晚 / 雾 / 雨'}, prompt:'purple and blue tones, cool color palette' },
  { id:'warmth',  iconName:'lantern',   name:'温馨', en:'Warmth',  color:'#FFB74D', palette:['#FFE0B2','#FFB74D','#F57C00','#E65100','#FFF3E0'], mapping:{'色相':'暖橙 / 橘红 / 米黄','光照':'夜灯 / 烛光 / 室内暖光','氛围':'安全感 / 家庭 / 治愈','天气':'夜晚 / 秋雨'}, prompt:'warm orange tones, warm color palette, gentle colors' },
]

const selected = ref<ColorMood | null>(null)
const resultPanel = ref<HTMLElement | null>(null)
const moodGrid = ref<HTMLElement | null>(null)
async function resetMood() {
  const id = selected.value?.id
  selected.value = null
  await nextTick()
  moodGrid.value?.querySelector<HTMLButtonElement>(`[data-mood="${id}"]`)?.focus()
}

async function chooseMood(id: string) {
  selected.value = MOODS.find(mood => mood.id === id) ?? null
  await nextTick()
  resultPanel.value?.focus({ preventScroll: true })
  resultPanel.value?.scrollIntoView({ block: 'nearest' })
}

function esc(s: string) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function norm(t: string) { return t.split(',').map(s => s.trim().replace(/[\s-]+/g,'_')).join(', ') }

const violations = computed(() => {
  if (!selected.value) return []
  const lower = selected.value.prompt.toLowerCase()
  return BANNED_TAGS.filter(b => lower.includes(b.toLowerCase()))
})

const colorizedPrompt = computed(() => {
  if (!selected.value) return ''
  return norm(selected.value.prompt).split(',').map(tk => {
    const t = tk.trim()
    const low = t.toLowerCase().replace(/[\s\/]+/g, '_')
    const bad = BANNED_TAGS.some(b => low === b.toLowerCase().replace(/[\s\/]+/g,'_') || low.includes(b.toLowerCase().replace(/[\s\/]+/g,'_')))
    return bad ? `<span class="violate">${esc(t)}</span>` : esc(t)
  }).join(',')
})

function select(m: ColorMood) { selected.value = m }

function copyPrompt() {
  if (!selected.value) return
  const text = selected.value.prompt
  void copyWithFeedback(text)
}

function exportTxt() {
  if (!selected.value) return
  const body = selected.value.prompt + '\n\n# mood: ' + selected.value.id + '\n# usage: 复制到 Prompt Builder v5 Step 4 色彩氛围'
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
  a.download = 'color-' + selected.value.id + '.txt'
  a.click()
  URL.revokeObjectURL(a.href)
}

// 走全局 AppToast。原先手搓 DOM 并挂 class="cs-toast" —— 而 .cs-toast
// 在任何样式表里都没有定义，那个提示一直是页面底部的无样式裸文本。
</script>

<style scoped>@reference "../assets/css/tailwind.css";
.color-section-heading, .palette-result-heading { @apply tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-s-3 tw:mb-s-4; }
.color-section-heading h2, .palette-result-heading h2 { @apply tw:m-0; font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); }
.color-section-heading p { @apply tw:m-0 tw:text-secondary tw:text-body-sm; }
.color-mood-grid { grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr)); }
.palette-result-heading > div > p { @apply tw:m-0 tw:mb-s-2 tw:text-accent tw:text-label-xs; }
.palette-result-heading h2 { @apply tw:flex tw:items-center tw:gap-s-2; }
.palette-result-heading h2 .archive-icon { @apply tw:text-accent; }
.palette-content { @apply tw:grid tw:gap-s-5 tw:mb-s-4; grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr)); align-items:start; }
.color-selection-hint { @apply tw:flex tw:items-center tw:gap-s-2 tw:text-secondary tw:text-body-sm tw:leading-body; padding-block:var(--s-4); }
.color-selection-hint .archive-icon { @apply tw:text-accent; }
.color-reading { @apply tw:mt-s-6; border-top:1px solid var(--border-soft); border-bottom:1px solid var(--border-soft); }
.color-reading > summary { @apply tw:flex tw:items-center tw:gap-s-3 tw:min-h-[72px] tw:cursor-pointer; list-style:none; padding-block:var(--s-3); }
.color-reading > summary::-webkit-details-marker { display:none; }
.color-reading > summary > span { @apply tw:grid tw:gap-s-1; }
.color-reading > summary strong { @apply tw:text-primary tw:text-body tw:font-semibold; }
.color-reading > summary small { @apply tw:text-secondary tw:text-body-sm; }
.color-reading > summary > .archive-icon:first-child { @apply tw:text-accent tw:w-[24px] tw:h-[24px]; }
.color-reading > summary > .archive-icon:last-child { @apply tw:ml-auto tw:text-muted; }
.color-reading[open] > summary > .archive-icon:last-child { transform:rotate(180deg); }
.color-reading > summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.color-reading-body { @apply tw:pb-s-5; }
.color-reading-body :deep(.light-notebook) { margin-top:var(--s-4); }
.section-title { @apply tw:text-title-sm tw:font-bold tw:mb-s-2; }
.section-title.spaced { @apply tw:mt-s-6; }

.result-panel { @apply tw:p-s-5; border:1px solid var(--accent); @apply tw:rounded-xl; background:var(--bg-surface); @apply tw:mt-s-5; }
/* 色号使用稳定阅读底色，不受任意深浅的样本色影响。 */
.palette-swatch { flex:1 1 76px; @apply tw:w-[76px] tw:overflow-hidden; border:1px solid var(--border-soft); @apply tw:rounded-md; background:var(--bg-surface); }
.palette-color { @apply tw:block tw:h-[48px]; background:var(--swatch); }
.palette-code { @apply tw:block; padding:var(--s-2) var(--s-1); @apply tw:text-center tw:text-primary; font:500 var(--fs-body-sm)/var(--lh-label) var(--font-mono); }
.mapping-grid { @apply tw:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr)); @apply tw:gap-s-3; }
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

.fade-up-enter-active { transition:opacity var(--motion-route),transform var(--motion-route); }
.fade-up-enter-from { opacity:0; transform:translateY(12px); }

@media(max-width:768px) { .art-ref { grid-template-columns:1fr; } }
</style>
