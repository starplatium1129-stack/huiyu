<template>
  <div class="control-panel-stack">
    <section class="control-start" aria-labelledby="control-start-title">
      <div class="control-start-copy">
        <span class="panel-kicker">画室入门</span>
        <h2 id="control-start-title">准备绘图环境</h2>
        <div class="control-start-actions">
          <RouterLink class="btn btn-primary" to="/control#control-inference"><ArchiveIcon name="download" />{{ drawingReady ? '管理绘图模型' : '一键准备本机绘图' }}</RouterLink>
          <RouterLink class="btn btn-ghost" to="/control#control-voice"><ArchiveIcon name="sound" />语音（{{ activeVoiceEngine }}）</RouterLink>
          <RouterLink class="btn btn-quiet" to="/scene-explorer">浏览场景<ArchiveIcon name="chevron-down" class="control-forward-icon" /></RouterLink>
        </div>
      </div>
      <img :src="modelArt" width="512" height="512" class="control-start-art" alt="" />
      <ol class="control-start-steps" aria-label="入门流程">
        <li :data-done="drawingReady">
          <span><ArchiveIcon v-if="drawingReady" name="success" /><template v-else>1</template></span>
          <div><strong>绘图引擎</strong><small>{{ drawingReady ? '已就绪' : '安装 Anima 底模' }}</small></div>
        </li>
        <li :data-done="voiceOrChatReady">
          <span><ArchiveIcon v-if="voiceOrChatReady" name="success" /><template v-else>2</template></span>
          <div><strong>语音与聊天</strong><small>{{ voiceOrChatReady ? activeVoiceEngine : '按需配置' }}</small></div>
        </li>
        <li>
          <span>3</span>
          <div><strong>开始创作</strong><small>画室 · 角色聊天</small></div>
        </li>
      </ol>
    </section>
    <section class="control-health" aria-labelledby="control-health-title" :aria-busy="serviceChecking">
      <span class="control-health-mark"><ArchiveIcon :name="statusError ? 'warning' : 'info'" /></span>
      <div><h2 id="control-health-title">{{ overviewFeedback.title }}</h2><p>{{ overviewFeedback.note }}</p></div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="serviceChecking || opBusy" @click="pollStatus(true)"><ArchiveIcon name="refresh" />{{ serviceChecking ? '检测中…' : '刷新状态' }}</button>
    </section>
    <section aria-labelledby="control-next-title">
      <div class="control-section-heading">
        <h2 id="control-next-title">快捷入口</h2>
      </div>
      <div class="control-feature-grid">
        <RouterLink v-for="feature in features" :key="feature.id" class="control-feature" data-control-motion :to="{ query: route.query, hash: '#' + feature.id }">
          <div class="control-feature-head">
            <ArchiveIcon :name="feature.icon" />
            <h3>{{ feature.title }}</h3>
            <span class="control-feature-badge">{{ feature.badge }}</span>
          </div>
          <p>{{ feature.description }}</p>
          <span class="control-feature-action">{{ feature.action }}<ArchiveIcon name="chevron-down" class="control-forward-icon" /></span>
        </RouterLink>
      </div>
    </section>
    <div class="control-bottom-links">
      <RouterLink data-control-motion :to="{ query: route.query, hash: '#control-services' }"><ArchiveIcon name="gear" />服务与连接</RouterLink>
      <RouterLink data-control-motion :to="{ query: route.query, hash: '#control-personalization' }"><ArchiveIcon name="palette" />外观设置</RouterLink>
      <RouterLink data-control-motion to="/prompt-builder"><ArchiveIcon name="spark" />进入绘图画室</RouterLink>
      <RouterLink data-control-motion to="/chat"><ArchiveIcon name="chat" />进入角色聊天</RouterLink>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useControlContext } from '@/composables/useControlContext'
import modelOriginal from '@/assets/illustrations/atelier-model-spot.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'

const route = useRoute()
const { status } = useControlContext()
const {
  overviewFeedback, serviceChecking, statusError, opBusy, pollStatus,
  nativeRuntimeFilesReady, comfyOnline, imageProvider, ttsOnline, activeVoiceEngine, llamaOnline, ollamaOnline,
} = status
const modelArt = useThemeIllustration(modelOriginal, 'model')

const drawingReady = computed(() =>
  imageProvider.value === 'comfy'
    ? comfyOnline.value
    : nativeRuntimeFilesReady.value || comfyOnline.value,
)
const voiceOrChatReady = computed(() => ttsOnline.value || llamaOnline.value || ollamaOnline.value)

const features = computed<Array<{ id: string; icon: ArchiveIconName; title: string; badge: string; description: string; action: string }>>(() => [
  {
    id: 'control-inference',
    icon: 'download',
    title: '绘图与模型',
    badge: drawingReady.value ? '已就绪' : '推荐',
    description: 'Anima 原生运行库 · 底模 · 断点续传',
    action: '配置绘图',
  },
  {
    id: 'control-voice',
    icon: 'sound',
    title: '语音与朗读',
    badge: activeVoiceEngine.value,
    description: '系统朗读 · 云端接口 · 本地语音包',
    action: '语音配置',
  },
  {
    id: 'setup-chat-options',
    icon: 'chat',
    title: '本地聊天与进阶',
    badge: llamaOnline.value || ollamaOnline.value ? '已连接' : '按需',
    description: '本机 Qwen 模型 · ComfyUI 管理',
    action: '配置聊天',
  },
  {
    id: 'control-share',
    icon: 'upload',
    title: '好友试玩与画册',
    badge: '分享',
    description: '临时试玩链接 · 局域网访问',
    action: '分享设置',
  },
])
</script>
