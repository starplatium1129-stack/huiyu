<template>
  <section class="light-notebook" aria-labelledby="light-notebook-title">
    <header class="notebook-heading tw:flex tw:justify-between tw:gap-s-5 tw:mb-s-4">
      <div><p class="notebook-kicker tw:text-accent tw:text-body-sm tw:mb-s-2">光色观察 / 01—03</p><h2 id="light-notebook-title">先看光，再决定这一幕的心情</h2></div>
      <p>并排翻看画册，观察光源、冷暖与明暗怎样改变叙事。</p>
    </header>
    <div class="comparison-choices tw:flex tw:flex-wrap tw:gap-s-2" aria-label="选择光色对照">
      <button v-for="(pair, index) in PAIRS" :key="pair.name" type="button" :aria-pressed="active === index" @click="active = index">
        <span>0{{ index + 1 }}</span>{{ pair.name }}
      </button>
    </div>
    <p class="comparison-question tw:text-body tw:leading-body tw:text-secondary">{{ current.question }}</p>
    <div class="comparison-spread tw:grid tw:gap-s-5">
      <figure v-for="sample in current.samples" :key="sample.id" class="light-study tw:min-w-0 tw:m-0 tw:overflow-hidden tw:rounded-lg">
        <RouterLink v-if="available.has(sample.id) && !failed.has(sample.id)" class="study-image" :to="'/showcase?scene=' + sample.id" :aria-label="'查看参考原图：' + sample.title">
          <img :crossorigin="runtimeResourceCors()" :src="resolveRuntimeUrl('/scene-showcase/thumbs/' + sample.id + '.jpg')" :alt="sample.title + '，' + sample.light" width="560" height="818" loading="lazy" decoding="async" @error="failed.add(sample.id)" />
        </RouterLink>
        <div v-else class="study-image study-unavailable" :class="{ 'is-unconnected': !loading && !available.has(sample.id) }" role="status">
          <ArchiveIcon name="image" />
          <strong>{{ loading ? '正在翻开参考画册…' : failed.has(sample.id) ? '参考图片加载失败' : '这张参考暂时未能展示' }}</strong>
          <p>{{ loading ? '正在核对样张目录' : '可继续阅读观察笔记，或选用下方情绪色板。' }}</p>
        </div>
        <figcaption>
          <div class="study-label tw:flex tw:flex-wrap tw:justify-between tw:gap-s-2 tw:text-muted tw:text-body-sm"><span>画册参考 · {{ sample.id }}</span><span>{{ sample.tone }}</span></div>
          <h3>{{ sample.name }}</h3>
          <p class="study-title tw:text-secondary tw:text-body-sm">《{{ sample.title }}》</p>
          <dl>
            <div><dt>看光源</dt><dd>{{ sample.light }}</dd></div>
            <div><dt>看色调</dt><dd>{{ sample.color }}</dd></div>
            <div><dt>读氛围</dt><dd>{{ sample.feeling }}</dd></div>
          </dl>
          <button type="button" class="study-mood tw:inline-flex tw:items-center tw:gap-s-2 tw:min-h-[44px] tw:text-accent tw:text-body-sm tw:font-semibold tw:cursor-pointer" @click="emit('choose', sample.mood)">试试「{{ sample.moodName }}」色板<ArchiveIcon name="palette" /></button>
        </figcaption>
      </figure>
    </div>
    <p class="reference-note tw:flex tw:gap-s-2 tw:mt-s-4 tw:p-s-3 tw:rounded-sm tw:text-secondary tw:text-body-sm tw:leading-body"><ArchiveIcon name="image" /><span>以上为已有场景样张，供光色与构图参考；人物、场景和光源各不相同，不是同一画面的参数对照实验，也不代表下方色板的实测生成结果。点击画面可查看画册原图。</span></p>
  </section>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { useMoodReferences } from '@/composables/useMoodReferences'

const emit = defineEmits<{ choose: [mood: string] }>()
// Visually inspected published All-rated references. No recolouring or synthetic comparison.
const PAIRS = [
  { name: '暖金与雨蓝', question: '同样把人物放在画面中央，温度不同，故事的距离也会不同。', samples: [
    { id: 'sc003', title: '只告诉你的天台秘密', name: '夕照把日常染成暖金', tone: '暖调 · 户外', light: '低处夕阳照亮发丝与座椅，地面留下长影。', color: '橙金天空与深色制服拉开明度，粉色发带点出人物。', feeling: '开阔、温暖，像一天结束前想多停留一会儿。', mood: 'joy', moodName: '快乐' },
    { id: 'sc007', title: '雨声里的正式回答', name: '雨色让靠近更安静', tone: '冷调 · 雨夜', light: '雨幕与伞面散开环境光，背景灯光化成柔软亮点。', color: '蓝灰铺满街道与伞面，淡粉高光保留人物的温度。', feeling: '冷色也可以亲近；牵手与视线比背景更先被读到。', mood: 'sad', moodName: '忧伤' },
  ] },
  { name: '日窗与月夜', question: '观察相似的书架空间：亮部的面积和阴影的深浅，怎样改变安静的质感？', samples: [
    { id: 'sc004', title: '书架间的偶遇', name: '窗光打开安静的空间', tone: '明亮 · 窗光', light: '窗户在人物身后，暖光沿过道落在书架和地面。', color: '奶白亮部、木色书架与灰蓝制服，层次清晰而柔和。', feeling: '通透、日常，适合阅读与轻声交谈的片刻。', mood: 'calm', moodName: '平静' },
    { id: 'sc215', title: '月光书页里的小小勇气', name: '月夜把视线留给人物', tone: '暗调 · 冷光', light: '右侧斜入的冷光穿过书架，只照亮人物与一段地面。', color: '大片深蓝阴影托住浅色头发，紫粉成为少量点缀。', feeling: '幽静、带一点秘密；有限亮部让人物更加突出。', mood: 'tension', moodName: '神秘' },
  ] },
  { name: '轮廓与灯火', question: '温暖不只有一种表达：一整片逆光，或许多细小的灯光，都能讲述陪伴。', samples: [
    { id: 'sc070', title: '傍晚窗边的剪影', name: '逆光勾出片刻的轮廓', tone: '逆光 · 大光面', light: '明亮落地窗位于人物背后，脸部和室内保持较暗。', color: '金色窗光包围灰色衣裙，暗部给亮部留出呼吸。', feeling: '柔和、含蓄，先读到姿态，再读到表情。', mood: 'love', moodName: '恋爱' },
    { id: 'sc006', title: '平安夜的手作礼物', name: '点点灯火围住节日心意', tone: '暖灯 · 小光点', light: '道路两侧灯火与树上灯串围绕人物，形成远近层次。', color: '暖金灯火、红色衣装与冷白积雪，冷暖相互衬托。', feeling: '热闹中保留亲近，礼物与人物成为故事的落点。', mood: 'warmth', moodName: '温馨' },
  ] },
]
const active = ref(0)
const current = computed(() => PAIRS[active.value]!)
const { available, loading } = useMoodReferences(PAIRS.flatMap(pair => pair.samples.map(sample => sample.id)))
const failed = ref(new Set<string>())
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.light-notebook { margin-block:var(--s-6) var(--s-7); }
.notebook-heading { align-items:end; }
.notebook-kicker { letter-spacing:.06em; }
.notebook-heading h2 { @apply tw:m-0 tw:text-primary; font:500 var(--fs-title)/var(--lh-label) var(--font-serif); }
.notebook-heading > p { @apply tw:max-w-[280px] tw:text-secondary tw:text-body-sm tw:leading-body; }
.comparison-choices button { @apply tw:flex tw:items-center tw:gap-s-2 tw:min-h-[44px]; padding:var(--s-2) var(--s-4); border:1px solid var(--border-soft); @apply tw:rounded-pill tw:text-secondary; background:var(--bg-surface); @apply tw:text-body-sm tw:cursor-pointer; }
.comparison-choices button span { @apply tw:text-muted tw:font-mono; }
.comparison-choices button[aria-pressed="true"] { @apply tw:text-accent tw:border-accent; background:var(--accent-soft); @apply tw:font-semibold; }
.comparison-question { margin:var(--s-4) 0; }
.comparison-spread { grid-template-columns:repeat(2,minmax(0,1fr)); }
.light-study { border:1px solid var(--border-soft); background:var(--bg-surface); }
.study-image { @apply tw:flex tw:items-center tw:justify-center tw:w-full tw:h-[360px]; background:var(--bg-elevated); @apply tw:overflow-hidden; }
.study-image img { @apply tw:block tw:w-full tw:h-full tw:object-contain; }
.study-unavailable { @apply tw:p-s-5 tw:flex-col tw:gap-s-3 tw:text-center tw:text-secondary tw:text-body-sm tw:leading-body; }
.study-unavailable .archive-icon { @apply tw:w-[36px] tw:h-[36px] tw:text-accent; }
.study-unavailable.is-unconnected { @apply tw:h-auto tw:min-h-[140px]; }
figcaption { padding:var(--s-4) var(--s-5); }
.light-study h3 { margin:var(--s-3) 0 var(--s-1); font:500 var(--fs-title-sm)/var(--lh-label) var(--font-serif); @apply tw:text-primary; }
dl { margin:var(--s-4) 0 var(--s-2); @apply tw:grid tw:gap-s-3; }
dl > div { @apply tw:grid; grid-template-columns:4em minmax(0,1fr); @apply tw:gap-s-2 tw:text-body-sm tw:leading-body; }
dt { @apply tw:text-primary tw:font-semibold; }
dd { @apply tw:m-0 tw:text-secondary; }
.study-mood { border:0; background:transparent; padding:var(--s-2) 0; }
.reference-note { align-items:start; background:var(--bg-base); }
.reference-note .archive-icon { @apply tw:shrink-0 tw:mt-[3px]; }
button:focus-visible, a:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; }
@media(max-width:768px) { .notebook-heading { @apply tw:flex-col; align-items:start; @apply tw:gap-s-3; } .notebook-heading > p { max-width:none; } .comparison-spread { @apply tw:gap-s-3; } figcaption { @apply tw:p-s-4; } dl > div { grid-template-columns:1fr; @apply tw:gap-s-1; } .study-image { @apply tw:h-[280px]; } }
@media(max-width:480px) { .comparison-spread { grid-template-columns:1fr; } .study-image { @apply tw:h-[340px]; } .notebook-heading h2 { @apply tw:text-title-sm; } }
</style>
