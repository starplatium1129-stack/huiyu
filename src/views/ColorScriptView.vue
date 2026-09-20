<template>
  <article class="page" style="--page-max:1000px">
    <ArchivePageHero
      chapter="07"
      section="Chromatic record"
      shape="spark"
      label="色彩情绪的光谱粒子标记"
      caption="COLOR SCRIPT 07 / 08"
      compact
    >
      <div class="page-kicker">Color script</div>
      <h1 class="title">色彩情绪</h1>
      <p class="subtitle">翻开光色手帖，看看一束光、一抹颜色，怎样让故事有了心情。</p>
    </ArchivePageHero>
    <CreativeLibraryNav />

    <ColorLightNotebook @choose="chooseMood" />

    <p class="emphasis-plain mb-3">今日心境色板 · Mood Palette</p>
    <div class="mood-grid stagger-container" data-reveal data-reveal-delay="1">
      <button
        v-for="m in MOODS" :key="m.id"
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

    <Transition name="fade-up">
      <div v-if="selected" ref="resultPanel" class="result-panel card-level-3 show" tabindex="-1">
        <h3>
          <span class="mood-icon" :style="{ '--mood-color': selected.color }"><ArchiveIcon :name="selected.iconName" /></span>
          {{ selected.name }} → 色彩 → 光照
        </h3>
        <div class="palette">
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
        <div v-if="violations.length" class="art-warn show">
          <ArchiveIcon name="warning" /> 检测到 {{ violations.length }} 个不建议使用的标签：{{ violations.join('、') }}
        </div>
        <div class="prompt-label">自动翻译 Prompt</div>
        <div class="prompt-code" v-html="colorizedPrompt"></div>
        <div class="result-actions">
          <button class="btn btn-primary" type="button" @click="copyPrompt"><ArchiveIcon name="copy" /> 复制 Prompt</button>
          <button class="btn btn-ghost" type="button" @click="exportTxt"><ArchiveIcon name="download" /> 导出 .txt</button>
          <RouterLink :to="'/prompt-builder?mood=' + selected.id" class="btn btn-ghost">→ 带入工作台使用</RouterLink>
          <button class="btn btn-ghost" type="button" @click="selected = null"><ArchiveIcon name="refresh" /> 换一个情绪</button>
        </div>
      </div>
    </Transition>

    <h2 class="section-title spaced-lg">美术指导 · 色彩语言</h2>
    <p class="note mb-3">写下提示词前，先问自己：“这段文字是否准确勾勒出了心中的氛围与情绪？”</p>
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
    <p class="note mb-3">每一束光线都有出现的理由，它服务于此刻的空气、时间与叙事。</p>
    <div class="lighting-ref">
      <div v-for="l in LIGHTINGS" :key="l.name" class="lighting-mini">
        <div class="lighting-icon"><ArchiveIcon :name="l.iconName" /></div>
        <div class="lighting-name">{{ l.name }}</div>
        <div class="lighting-reason">{{ l.reason }}</div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import CreativeLibraryNav from '@/components/library/CreativeLibraryNav.vue'
import ColorLightNotebook from '@/components/library/ColorLightNotebook.vue'
import { ref, computed, nextTick } from 'vue'
import ArchivePageHero from '@/components/visual/ArchivePageHero.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { BANNED_TAGS } from '@/utils/promptPolicy'

useScrollReveal()

const GOOD_TAGS = ['soft colors','pastel tones','warm atmosphere','gentle palette','muted tones','harmonious colors','warm soft lighting','backlit glow']
const LIGHTINGS = [
  { iconName:'goldenhour' as const,  name:'夕阳',   reason:'放学/黄昏/温馨/回忆' },
  { iconName:'windowlight' as const, name:'窗光',   reason:'室内/安静/治愈/独处' },
  { iconName:'backlight' as const,   name:'逆光',   reason:'神秘/回忆/感动/剪影' },
  { iconName:'moonlight' as const,   name:'月光',   reason:'夜晚/孤独/宁静/思念' },
  { iconName:'lantern' as const,     name:'夜灯',   reason:'夜祭/温馨/安全感/传统' },
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
  { id:'joy',     iconName:'sun',       name:'快乐', en:'Joy',     color:'#FFD54F', palette:['#FFE082','#FFD54F','#FFB300','#FF8F00','#FFF8E1'], mapping:{'色相':'暖黄色 / 浅橙色 / 柔粉','光照':'Golden Hour / 午后阳光 / 明亮','氛围':'活力 / 温暖 / 清爽','天气':'晴天 / 微风'}, prompt:'warm yellow tones, golden hour, bright sunlight, cheerful atmosphere, soft breeze, warm color palette, vibrant but soft' },
  { id:'love',    iconName:'love',      name:'恋爱', en:'Love',    color:'#F06292', palette:['#F8BBD0','#F06292','#EC407A','#AD1457','#FFF0F5'], mapping:{'色相':'夕阳 / 粉色 / 暖光','光照':'Golden Hour / 逆光 / 柔光','氛围':'暧昧 / 心跳 / 羞涩','天气':'黄昏 / 樱花季'}, prompt:'pink tone, golden hour, warm light, backlit, romantic atmosphere, soft glow, blush, cherry blossom color, dreamy' },
  { id:'calm',    iconName:'leaf',      name:'平静', en:'Calm',    color:'#81C784', palette:['#C8E6C9','#81C784','#4CAF50','#2E7D32','#F1F8E9'], mapping:{'色相':'淡绿 / 青绿 / 奶白','光照':'阴天柔光 / 窗光 / 自然光','氛围':'安静 / 治愈 / 文艺','天气':'多云 / 雨后'}, prompt:'soft green tones, overcast light, window light, calm atmosphere, peaceful, gentle colors, clean aesthetic, healing' },
  { id:'sad',     iconName:'rain',      name:'忧伤', en:'Sad',     color:'#64B5F6', palette:['#BBDEFB','#64B5F6','#1E88E5','#0D47A1','#E3F2FD'], mapping:{'色相':'蓝色 / 灰蓝 / 冷调','光照':'月光 / 阴天 / 冷调窗光','氛围':'孤独 / 回忆 / 思念','天气':'雨天 / 阴天 / 夜晚'}, prompt:'blue tones, cool color palette, rainy day, overcast, melancholic atmosphere, lonely, nostalgic, soft blue light' },
  { id:'tension', iconName:'moonlight', name:'神秘', en:'Mystery', color:'#BA68C8', palette:['#E1BEE7','#BA68C8','#8E24AA','#4A148C','#F3E5F5'], mapping:{'色相':'紫蓝 / 深紫 / 冷调','光照':'月光 / 逆光 / 暗调','氛围':'神秘 / 距离 / 梦幻','天气':'夜晚 / 雾 / 雨'}, prompt:'purple and blue tones, moonlight, backlit, rim light, mysterious atmosphere, ethereal, dreamlike, cool shadows' },
  { id:'warmth',  iconName:'lantern',   name:'温馨', en:'Warmth',  color:'#FFB74D', palette:['#FFE0B2','#FFB74D','#F57C00','#E65100','#FFF3E0'], mapping:{'色相':'暖橙 / 橘红 / 米黄','光照':'夜灯 / 烛光 / 室内暖光','氛围':'安全感 / 家庭 / 治愈','天气':'夜晚 / 秋雨'}, prompt:'warm orange tones, lantern light, indoor warm light, cozy atmosphere, candlelight, safe feeling, homely, autumn warmth' },
]

const selected = ref<ColorMood | null>(null)
const resultPanel = ref<HTMLElement | null>(null)

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

<style scoped>
.emphasis-plain { color:var(--text-primary); font-weight:600; }
.mb-3 { margin-bottom:var(--s-3); }
.note { color:var(--text-muted); font-size:var(--fs-body-sm); }
.section-title { font-size:var(--fs-title-sm); font-weight:700; margin-bottom:var(--s-2); }
/* 章节间距:替代原先三处内联 style="margin-top:..." */
.section-title.spaced-lg { margin-top:var(--s-8); }
.section-title.spaced { margin-top:var(--s-6); }
.palette { display:flex; flex-wrap:wrap; gap:var(--s-2); margin-bottom:var(--s-4); }

.result-panel { padding:var(--s-5); border:1px solid var(--accent); border-radius:var(--r-xl); background:var(--bg-surface); margin-top:var(--s-5); }
.result-panel h3 { margin-bottom:var(--s-3); font-size:var(--fs-title-sm); }
/* 色号使用稳定阅读底色，不受任意深浅的样本色影响。 */
.palette-swatch { width:76px; overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); }
.palette-color { display:block; height:48px; background:var(--swatch); }
.palette-code { display:block; padding:var(--s-2) var(--s-1); text-align:center; color:var(--text-primary); font:500 var(--fs-body-sm)/var(--lh-label) var(--font-mono); }
.mapping-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:var(--s-3); margin-bottom:var(--s-4); }
.mapping-item { background:var(--bg-elevated); border:1px solid var(--border-soft); border-radius:var(--r-md); padding:var(--s-3); }
.mapping-label { font-size:var(--fs-label-sm); color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; margin-bottom:var(--s-1); }
.mapping-value { font-size:var(--fs-body); font-weight:600; }
.prompt-label { margin-bottom:var(--s-1); color:var(--accent); font-size:var(--fs-label-sm); font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
.prompt-code { padding:var(--s-3); background:var(--bg-elevated); border-radius:var(--r-md); font-family:var(--font-mono); font-size:var(--fs-mono-sm); line-height:var(--lh-loose); margin-bottom:var(--s-3); word-break:break-word; }
:deep(.violate) { color:var(--danger-text); text-decoration:underline wavy; }
.art-warn { display:none; align-items:center; gap:var(--s-2); background:color-mix(in srgb,var(--warning) 12%,transparent); border:1px solid var(--warning); border-radius:var(--r-md); padding:var(--s-2) var(--s-3); margin-bottom:var(--s-3); color:var(--warning-text); font-size:var(--fs-label); }
.art-warn.show { display:flex; }
.result-actions { display:flex; gap:var(--s-2); flex-wrap:wrap; }

.art-ref { display:grid; grid-template-columns:1fr 1fr; gap:var(--s-3); margin-bottom:var(--s-5); }
.art-ref-card { border-radius:var(--r-lg); padding:var(--s-4); border:1px solid var(--border-soft); }
.art-ref-card.good { background:color-mix(in srgb,var(--success) 6%,transparent); border-color:color-mix(in srgb,var(--success) 30%,transparent); }
.art-ref-card.bad { background:color-mix(in srgb,var(--danger) 6%,transparent); border-color:color-mix(in srgb,var(--danger) 30%,transparent); }
.art-ref-title { font-size:var(--fs-body); font-weight:700; margin-bottom:var(--s-2); }
.art-ref-card.good .art-ref-title { color:var(--success-text); }
.art-ref-card.bad .art-ref-title { color:var(--danger-text); }
.art-tag { display:inline-block; margin:2px 3px; padding:3px var(--s-3); border-radius:var(--r-pill); font-size:var(--fs-label-sm); font-weight:600; }
.art-tag.ok { background:color-mix(in srgb,var(--success) 12%,transparent); color:var(--success-text); }
.art-tag.no { background:color-mix(in srgb,var(--danger) 12%,transparent); color:var(--danger-text); }

.lighting-ref { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:var(--s-2); margin-bottom:var(--s-5); }
.lighting-mini { background:var(--bg-surface); border:1px solid var(--border-soft); border-radius:var(--r-md); padding:var(--s-3); text-align:center; }
.lighting-icon { margin-bottom:2px; font-size:var(--fs-title); }
.lighting-name { font-size:var(--fs-body-sm); font-weight:600; }
.lighting-reason { font-size:var(--fs-body-sm); color:var(--text-secondary); margin-top:var(--s-2); line-height:var(--lh-body); }

.fade-up-enter-active { transition:opacity var(--motion-route),transform var(--motion-route); }
.fade-up-enter-from { opacity:0; transform:translateY(12px); }

@media(max-width:768px) { .art-ref { grid-template-columns:1fr; } }
</style>
