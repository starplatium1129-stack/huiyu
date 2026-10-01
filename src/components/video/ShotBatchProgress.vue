<template>
  <section class="video-panel shot-progress-panel" aria-live="polite">
    <div class="video-panel-heading">
      <div><span class="video-step">03 · 批量进度</span><h2>{{ statusLabel }}</h2></div>
      <span class="shot-progress-stats">{{ succeeded }} / {{ total }} 镜成功 · {{ failed }} 失败</span>
    </div>
    <div class="video-progress" role="progressbar" aria-label="分镜批次进度" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100"><i :style="{ '--progress': progressPercent + '%' }"></i></div>
    <p class="video-install-note">
      {{ linkLastFrame ? '镜头间已自动衔接上一镜尾帧；' : '已关闭尾帧衔接；' }}
      单镜约 2.5–6 分钟（standard 档），可离开页面，任务在后台继续。
    </p>
    <template v-if="concatUrl">
      <div class="shot-concat-heading"><strong>整片预览</strong><TaskMediaDownload class="btn btn-ghost" :src="concatUrl">下载整片 MP4</TaskMediaDownload></div>
      <StudioMediaPlayer class="shot-concat-player" kind="video" :src="concatUrl" label="整片预览" :transcript="transcript" />
    </template>
  </section>
</template>

<script setup lang="ts">
import StudioMediaPlayer from '@/components/ui/StudioMediaPlayer.vue'
import TaskMediaDownload from '@/components/tasks/TaskMediaDownload.vue'

defineProps<{
  statusLabel: string
  succeeded: number
  total: number
  failed: number
  progressPercent: number
  linkLastFrame: boolean
  concatUrl: string
  transcript: string
}>()
</script>

<style scoped>
@reference "../../assets/css/tailwind.css";
.shot-progress-panel { display:grid; gap:var(--s-3); padding:clamp(18px,2.4vw,28px); border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); }
.video-panel-heading { display:flex; flex-wrap:wrap; align-items:start; justify-content:space-between; gap:var(--s-3); }
.video-panel-heading h2 { margin:var(--s-1) 0 0; font-size:var(--fs-title-sm); }
.video-step { color:var(--accent); font:600 var(--fs-label-xs) var(--font-mono); letter-spacing:.08em; }
.shot-progress-stats { color:var(--text-secondary); font:500 var(--fs-label-sm)/var(--lh-body) var(--font-mono); }
.video-progress { height:4px; overflow:hidden; border-radius:var(--r-pill); background:var(--bg-deep); }
.video-progress i { display:block; width:100%; height:100%; transform-origin:left center; transform:scaleX(var(--progress,0%)); background:var(--accent); transition:transform var(--motion-hover) var(--ease-out); }
.video-install-note { margin:0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); }
.shot-concat-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-3); }
.shot-concat-player { --media-max-height:min(68vh,700px); width:100%; }
@media (prefers-reduced-motion:reduce) { .video-progress i { transition:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .video-progress i { transition:none; }
</style>
