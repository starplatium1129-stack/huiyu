<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioOrbitSpinner from '@/components/ui/StudioOrbitSpinner.vue'
import collectionArt from '@/assets/illustrations/atelier-collection-spot.webp'
import { formatSetupBytes } from '@/utils/localSetupPreparation'
import { useOfflineResourceAssistant } from '@/composables/useOfflineResourceAssistant'

const { state, available, busy, complete, canInstall, percent, elapsed, heading, detail, issue, refresh, pick, pickDirectory, install, cancel, finish } = useOfflineResourceAssistant()
const light = ref(window.matchMedia('(prefers-color-scheme: light)').matches)
watch(light, value => { document.documentElement.dataset.theme = value ? 'light' : 'dark'; document.documentElement.style.colorScheme = value ? 'light' : 'dark' }, { immediate: true })
const step = computed(() => complete.value ? 3 : state.value?.paused || ['preparing', 'installing'].includes(state.value?.stage ?? '') ? 2 : 1)
const steps = ['选择素材', '接入画室', '回到画室']
const rawError = computed(() => state.value?.error || '')
</script>

<template>
  <main class="installer">
    <header class="installer-topbar">
      <span class="installer-brand"><ArchiveIcon name="book" /><strong>绘遇 <span>HUIYU</span></strong><i />资源安装助手</span>
      <button class="btn btn-ghost btn-sm" type="button" :aria-label="light ? '切换深色主题' : '切换浅色主题'" @click="light = !light"><ArchiveIcon :name="light ? 'moon' : 'sun'" /><span>{{ light ? '深色' : '浅色' }}</span></button>
    </header>
    <div class="installer-layout">
      <aside class="installer-story">
        <img :src="collectionArt" alt="" class="installer-art" />
        <div class="installer-story-copy"><span class="installer-eyebrow">素材画册</span><h1>故事与画面</h1><p>角色与场景素材，随时翻阅。</p></div>
        <div class="installer-includes"><span><ArchiveIcon name="character" />角色图片</span><span><ArchiveIcon name="image" />场景卡片</span><span><ArchiveIcon name="book" />素材画册</span></div>
      </aside>
      <section class="installer-content" aria-labelledby="install-title">
        <ol class="installer-steps" aria-label="安装步骤"><li v-for="(label, index) in steps" :key="label" :data-active="step === index + 1" :data-done="step > index + 1" :aria-current="step === index + 1 ? 'step' : undefined"><span><ArchiveIcon v-if="step > index + 1" name="success" /><template v-else>{{ index + 1 }}</template></span>{{ label }}</li></ol>
        <div class="installer-title"><span class="installer-eyebrow">{{ complete ? '准备完成' : '离线素材' }}</span><h2 id="install-title">{{ heading }}</h2><p>{{ detail }}</p></div>
        <p v-if="!available" class="installer-notice" role="status">请从绘遇桌面端的「资源与素材」打开此助手。</p>
        <button v-if="!state?.preview && !state?.busy" class="installer-picker" type="button" :disabled="busy || !available" @click="pick"><span class="installer-picker-icon"><ArchiveIcon name="folder" /></span><strong>选择素材 ZIP</strong><span>选择离线素材包</span><span class="installer-picker-link">浏览本地文件 <ArchiveIcon name="send" /></span></button>
        <button v-if="!state?.paused && !state?.busy && !complete" class="btn btn-ghost installer-directory" type="button" :disabled="busy || !available" @click="state?.preview?.sourceType === 'directory' ? pick() : pickDirectory()"><ArchiveIcon name="folder" />{{ state?.preview?.sourceType === 'directory' ? '改用 ZIP 自动解压' : '使用已解压的文件夹' }}<ArchiveIcon name="send" /></button>
        <Transition name="installer-reveal" mode="out-in">
          <div v-if="state?.preview" :key="state.preview.releaseId" class="installer-package" :data-complete="complete">
            <div class="installer-package-heading"><span class="installer-package-icon"><ArchiveIcon :name="complete ? 'success' : 'folder'" /></span><div><span class="installer-tag">{{ state.preview.packageMode === 'delta' ? '增量素材包' : '完整素材包' }}</span><strong>{{ state.preview.releaseId }}</strong></div><button v-if="!state.paused && !complete" class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="state.preview.sourceType === 'directory' ? pickDirectory() : pick()">更换</button></div>
            <p class="installer-filename">{{ state.fileName }}</p>
            <dl class="installer-metrics"><div><dt>资源文件</dt><dd>{{ state.preview.files.toLocaleString() }}<small> 项</small></dd></div><div><dt>解压后大小</dt><dd>{{ formatSetupBytes(state.preview.bytes) }}</dd></div><div><dt>使用方式</dt><dd>{{ state.preview.sourceType === 'directory' || state.result?.directoryRoot ? '直接使用目录' : state.canResume ? '复用解压内容' : '自动解压' }}</dd></div></dl>
            <p v-if="state.preview.packageMode === 'delta'" class="installer-baseline">需要基础版本 {{ state.preview.baseReleaseId }}</p>
          </div>
        </Transition>
        <div v-if="state?.busy && state.phase !== 'choosing'" class="installer-progress" :aria-busy="true">
          <div class="installer-progress-heading"><StudioOrbitSpinner /><strong>{{ state.phase === 'extracting' ? '解压素材' : state.phase === 'connecting' ? '连接素材目录' : state.stage === 'preparing' ? '保存当前工作' : state.stage === 'checking' ? '识别发行清单' : '接入素材' }}</strong><span>{{ percent === null ? elapsed : `${percent}%` }}</span></div>
          <div class="installer-track" role="progressbar" aria-label="整包解压进度" :aria-valuenow="percent ?? undefined" :aria-valuemin="0" :aria-valuemax="100" :aria-valuetext="percent === null ? '正在处理，请稍候' : `${percent}%`"><span v-if="percent !== null" :style="{ transform: `scaleX(${percent / 100})` }" /></div>
          <div v-if="percent !== null" class="installer-volume"><span>{{ formatSetupBytes(state.done) }} / {{ formatSetupBytes(state.total) }}</span><span>已用 {{ elapsed }}</span></div>
        </div>
        <div v-if="issue" class="installer-notice" role="alert"><ArchiveIcon name="warning" /><div><strong>{{ issue }}</strong><details v-if="rawError && rawError !== issue"><summary>详细信息</summary><p>{{ rawError }}</p></details><button v-if="!state" class="btn btn-ghost btn-sm" type="button" @click="refresh">重新检查</button></div></div>
        <p v-if="complete && state?.result?.catalog?.included" class="installer-success" role="status"><ArchiveIcon name="success" /><span v-if="state.result.catalog.preservedNewer">素材已可用，人物与场景内容较新，已保留当前版本。</span><span v-else>人物与场景内容已同步{{ state.result.catalog.changed === undefined ? '' : `，更新 ${state.result.catalog.changed} 条记录` }}。</span></p>
        <p v-if="state?.preview?.directoryRoot || state?.result?.directoryRoot" class="installer-source">素材位置：{{ state.result?.directoryRoot || state.preview?.directoryRoot }}（请保留原文件夹）</p>
        <details v-if="state?.preview" class="installer-location"><summary>安装位置与来源</summary><dl><dt>个人资源目录</dt><dd>{{ state.preview.runtimeRoot }}</dd><dt>发行来源</dt><dd>{{ state.preview.trustedSource }}</dd></dl></details>
        <footer class="installer-footer">
          <p><ArchiveIcon name="lock" />保留自定义作品与内容</p>
          <div class="installer-actions">
            <button v-if="state?.busy" class="btn btn-ghost" type="button" :disabled="state.cancelRequested || busy && !state.busy" @click="cancel">{{ state.cancelRequested ? '正在取消…' : '取消安装' }}</button>
            <template v-else><button v-if="state?.paused || complete" class="btn" :class="complete ? 'btn-primary' : 'btn-ghost'" type="button" :disabled="busy" @click="finish"><ArchiveIcon name="send" />返回画室</button><button v-if="state?.preview && !complete" class="btn btn-primary" type="button" :disabled="!canInstall" @click="install"><ArchiveIcon name="download" />{{ state.preview.sourceType === 'directory' ? '直接使用此文件夹' : state.canResume || state.paused ? '继续安装' : '一键安装' }}</button></template>
          </div>
          <span v-if="state?.paused" class="installer-restart-note">返回画室将重启以生效。</span>
          <span v-else class="installer-restart-note">安装时自动保存，无需手动退出。</span>
        </footer>
      </section>
    </div>
  </main>
</template>

<style scoped>
.installer { min-height:100dvh; background:var(--bg-base); color:var(--text-primary); }
.installer-topbar { display:flex; align-items:center; justify-content:space-between; gap:var(--s-4); padding:var(--s-4) var(--s-6); border-bottom:1px solid var(--border-soft); background:var(--bg-surface); }
.installer-brand { display:flex; align-items:center; gap:var(--s-3); font-size:var(--fs-label); color:var(--text-secondary); }
.installer-brand > .archive-icon { color:var(--accent); font-size:24px; }
.installer-brand strong { color:var(--text-primary); font-size:var(--fs-body); }
.installer-brand strong span { font-size:var(--fs-label-xs); letter-spacing:.12em; margin-left:var(--s-1); }
.installer-brand i { height:16px; border-left:1px solid var(--border-strong); }
.installer-layout { display:grid; grid-template-columns:minmax(240px,.8fr) minmax(0,1.4fr); max-width:1200px; min-height:calc(100dvh - 73px); margin:auto; }
.installer-story { display:flex; flex-direction:column; padding:var(--s-6) var(--s-5) var(--s-5); border-right:1px solid var(--border-soft); }
.installer-art { width:100%; max-width:280px; aspect-ratio:1; object-fit:contain; align-self:center; }
.installer-story-copy { margin:var(--s-4) 0 var(--s-5); }
.installer-eyebrow { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.installer-story h1 { font-family:var(--font-serif); font-size:28px; line-height:1.5; font-weight:600; margin:var(--s-3) 0; }
.installer-story p { color:var(--text-secondary); font-size:var(--fs-label); line-height:1.9; margin:0; }
.installer-includes { display:flex; flex-wrap:wrap; gap:var(--s-3); margin-top:auto; color:var(--text-secondary); font-size:var(--fs-label-xs); }
.installer-includes span { display:flex; align-items:center; gap:var(--s-1); }
.installer-content { display:flex; flex-direction:column; padding:var(--s-6); min-width:0; }
.installer-steps { display:flex; justify-content:space-between; gap:var(--s-2); list-style:none; padding:0; margin:0 0 var(--s-6); }
.installer-steps li { display:flex; align-items:center; gap:var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-xs); }
.installer-steps li > span { display:grid; place-items:center; width:24px; height:24px; border:1px solid var(--border-strong); border-radius:50%; font-variant-numeric:tabular-nums; }
.installer-steps li[data-active=true] { color:var(--text-primary); font-weight:600; }
.installer-steps li[data-active=true] > span { background:var(--accent); border-color:var(--accent); color:var(--text-inverse); }
.installer-steps li[data-done=true] > span { color:var(--success-text); }
.installer-title h2 { margin:var(--s-2) 0 var(--s-3); font-size:24px; line-height:1.4; }
.installer-title > p { margin:0 0 var(--s-6); color:var(--text-secondary); font-size:var(--fs-label); line-height:1.8; }
.installer-picker { display:flex; flex-direction:column; align-items:center; gap:var(--s-2); width:100%; min-height:240px; padding:var(--s-6); border:1px dashed var(--border-strong); border-radius:var(--r-lg); background:var(--bg-surface); color:var(--text-primary); cursor:pointer; transition:transform var(--motion-control) var(--ease-out); }
.installer-picker-icon,.installer-package-icon { display:grid; place-items:center; border:1px solid var(--border-soft); background:var(--bg-elevated); border-radius:var(--r-lg); }
.installer-picker-icon { width:56px; height:56px; font-size:28px; margin-bottom:var(--s-2); color:var(--accent); }
.installer-picker > span:not(.installer-picker-icon) { color:var(--text-secondary); font-size:var(--fs-label); }
.installer-picker > .installer-picker-link { display:flex; align-items:center; gap:var(--s-2); margin-top:var(--s-4); color:var(--accent); }
.installer-directory { align-self:center; margin-top:var(--s-3); }
.installer-source { font-size:var(--fs-label-xs); color:var(--text-secondary); overflow-wrap:anywhere; line-height:1.8; }
.installer-package { padding:var(--s-5); border:1px solid var(--border-strong); border-radius:var(--r-lg); background:var(--bg-surface); box-shadow:var(--shadow-sm); }
.installer-package-heading { display:flex; align-items:center; gap:var(--s-3); min-width:0; }
.installer-package-icon { width:44px; height:44px; flex:none; font-size:24px; color:var(--accent); }
.installer-package-heading > div { display:grid; gap:var(--s-1); flex:1; min-width:0; }
.installer-package-heading strong { overflow-wrap:anywhere; font-size:var(--fs-label); }
.installer-tag { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.installer-filename { overflow-wrap:anywhere; color:var(--text-secondary); font-size:var(--fs-label-xs); margin:var(--s-3) 0 var(--s-4); }
.installer-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--s-3); margin:0; padding-top:var(--s-4); border-top:1px solid var(--border-soft); }
.installer-metrics dt { color:var(--text-secondary); font-size:var(--fs-label-xs); margin-bottom:var(--s-1); }
.installer-metrics dd { margin:0; font-size:var(--fs-label); font-weight:600; font-variant-numeric:tabular-nums; }
.installer-metrics small { font-weight:400; color:var(--text-secondary); }
.installer-baseline { color:var(--text-secondary); font-size:var(--fs-label-xs); overflow-wrap:anywhere; }
.installer-progress { margin-top:var(--s-5); }
.installer-progress-heading { display:flex; align-items:center; gap:var(--s-2); font-size:var(--fs-label); }
.installer-progress-heading strong { flex:1; font-weight:500; }
.installer-progress-heading > span { min-width:4ch; text-align:end; font-variant-numeric:tabular-nums; color:var(--text-secondary); }
.installer-track { height:6px; margin:var(--s-3) 0; background:var(--bg-elevated); border-radius:var(--r-pill); overflow:hidden; }
.installer-track > span { display:block; height:100%; width:100%; background:var(--accent); transform-origin:left; transition:transform var(--motion-control) var(--ease-out); }
.installer-volume { display:flex; justify-content:space-between; gap:var(--s-2); font-size:var(--fs-label-xs); color:var(--text-secondary); font-variant-numeric:tabular-nums; }
.installer-notice { display:flex; align-items:flex-start; gap:var(--s-2); padding:var(--s-3); margin-top:var(--s-4); border:1px solid var(--border-strong); border-radius:var(--r-md); color:var(--warning-text); font-size:var(--fs-label); line-height:1.7; overflow-wrap:anywhere; }
.installer-notice > .archive-icon { margin-top:4px; }
.installer-notice strong { font-weight:500; }
.installer-notice details { margin-top:var(--s-2); color:var(--text-secondary); }
.installer-notice details p { max-height:180px; overflow:auto; font-size:var(--fs-label-xs); white-space:pre-wrap; }
.installer-success { display:flex; align-items:center; gap:var(--s-2); color:var(--success-text); font-size:var(--fs-label); line-height:1.8; }
.installer-package[data-complete=true] .installer-package-icon { color:var(--success-text); }
.installer-location { margin:var(--s-4) 0 var(--s-6); font-size:var(--fs-label-xs); color:var(--text-secondary); }
.installer-location summary { cursor:pointer; padding-block:var(--s-2); }
.installer-location dl { padding:var(--s-3); background:var(--bg-surface); border-radius:var(--r-md); margin:var(--s-1) 0; }
.installer-location dd { margin:var(--s-1) 0 var(--s-3); overflow-wrap:anywhere; color:var(--text-primary); }
.installer-footer { margin-top:auto; padding-top:var(--s-6); }
.installer-footer > p { display:flex; align-items:center; gap:var(--s-2); margin:0 0 var(--s-4); color:var(--text-secondary); font-size:var(--fs-label-xs); }
.installer-actions { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:var(--s-3); }
.installer-actions .btn { min-height:44px; padding-inline:var(--s-5); }
.installer-restart-note { display:block; margin-top:var(--s-3); color:var(--text-secondary); font-size:var(--fs-label-xs); text-align:end; line-height:1.7; }
.installer button:disabled { color:var(--text-disabled); opacity:1; cursor:not-allowed; }
.installer :is(button, summary):focus-visible { outline:2px solid var(--text-secondary); outline-offset:3px; }
.installer-reveal-enter-active,.installer-reveal-leave-active { transition:transform var(--motion-control) var(--ease-out),opacity var(--motion-control) var(--ease-out); }
.installer-reveal-enter-from { transform:translateY(8px); opacity:0; }
.installer-reveal-leave-to { transform:translateY(-4px); opacity:0; }
@media (hover:hover) and (pointer:fine) { .installer-picker:not(:disabled):hover { transform:translateY(-2px); border-color:var(--accent); } }
@media (max-width:760px) { .installer-layout { grid-template-columns:1fr; } .installer-story { display:none; } .installer-content { min-height:calc(100dvh - 73px); padding:var(--s-6); } }
:global(:root:is([data-motion=reduce],[data-motion=reduced])) .installer :is(*, *::before, *::after) { transition:none; }
@media (prefers-reduced-motion:reduce) { :global(:root:not([data-motion=full])) .installer :is(*, *::before, *::after) { transition:none; } }
@media (forced-colors:active) { .installer-track { border:1px solid CanvasText; } .installer-track > span,.installer-steps li[data-active=true] > span { background:Highlight; color:HighlightText; } }
</style>
