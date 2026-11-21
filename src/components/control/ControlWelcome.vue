<template>
  <div class="control-panel-stack">
    <section class="control-start" aria-labelledby="control-start-title">
      <div class="control-start-copy">
        <span class="panel-kicker">画室入门</span>
        <h2 id="control-start-title">准备绘图环境</h2>
        <p>推荐先一键配置本机 Anima 绘图模型；语音默认已开启「系统朗读」，本地聊天与云端音色随时可扩充。</p>
        <div class="control-start-actions">
          <RouterLink class="btn btn-primary" to="/control#control-inference"><ArchiveIcon name="download" />{{ drawingReady ? '管理绘图模型' : '一键准备本机绘图' }}</RouterLink>
          <RouterLink class="btn btn-ghost" to="/control#control-voice"><ArchiveIcon name="sound" />语音设置（{{ activeVoiceEngine }}）</RouterLink>
          <RouterLink class="btn btn-quiet" to="/scene-explorer">浏览灵感场景<ArchiveIcon name="chevron-down" class="control-forward-icon" /></RouterLink>
        </div>
      </div>
      <img :src="modelArt" width="512" height="512" class="control-start-art" alt="" />
      <ol class="control-start-steps" aria-label="入门流程">
        <li :data-done="drawingReady">
          <span><ArchiveIcon v-if="drawingReady" name="success" /><template v-else>1</template></span>
          <div><strong>准备绘图引擎</strong><small>{{ drawingReady ? '绘图环境已就绪' : '推荐一键安装 Anima 底模' }}</small></div>
        </li>
        <li :data-done="voiceOrChatReady">
          <span><ArchiveIcon v-if="voiceOrChatReady" name="success" /><template v-else>2</template></span>
          <div><strong>语音与聊天</strong><small>{{ voiceOrChatReady ? `语音当前：${activeVoiceEngine}` : '前往配置语音与聊天' }}</small></div>
        </li>
        <li>
          <span>3</span>
          <div><strong>进入创作</strong><small>打开绘图画室或角色聊天</small></div>
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
        <h2 id="control-next-title">核心功能与快捷入口</h2>
        <p>先确保基础画室与声音正常，再按需要扩展进阶工具。</p>
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
    badge: drawingReady.value ? '已就绪' : '新手推荐',
    description: '一键安装原生 Anima 绘图运行库与底模，支持自动镜像切换与断点续传。',
    action: '配置绘图',
  },
  {
    id: 'control-voice',
    icon: 'sound',
    title: '语音与朗读',
    badge: activeVoiceEngine.value,
    description: '默认开箱即用系统朗读，也支持硅基流动/OpenAI 语音接口与本地语音包导入。',
    action: '语音配置',
  },
  {
    id: 'setup-chat-options',
    icon: 'chat',
    title: '本地聊天与进阶',
    badge: llamaOnline.value || ollamaOnline.value ? '已连接' : '按需选用',
    description: '下载本机 Qwen 对话模型或管理 ComfyUI，独立磁盘校验避免误下大模型。',
    action: '配置聊天',
  },
  {
    id: 'control-share',
    icon: 'upload',
    title: '好友试玩与画册',
    badge: '分享工具',
    description: '一键生成好友临时体验链接，或前往资源中心管理离线立绘与场景素材。',
    action: '分享设置',
  },
])
</script>
