<template>
  <div class="control-panel-stack">
    <section class="control-start" aria-labelledby="control-start-title">
      <div class="control-start-copy">
        <span class="panel-kicker">画室入门</span>
        <h2 id="control-start-title">准备绘图环境</h2>
        <p>自动配置推荐底模；聊天与扩展工具可按需随时添加。</p>
        <div class="control-start-actions">
          <RouterLink class="btn btn-primary" :to="{ path: '/control', hash: '#control-setup' }"><ArchiveIcon name="download" />配置绘图模型</RouterLink>
          <RouterLink class="btn btn-quiet" to="/scene-explorer">浏览灵感场景<ArchiveIcon name="chevron-down" class="control-forward-icon" /></RouterLink>
        </div>
      </div>
      <img :src="modelArt" width="512" height="512" class="control-start-art" alt="" />
      <ol class="control-start-steps" aria-label="入门流程">
        <li><span>1</span><div><strong>选择目录</strong><small>确认磁盘空间</small></div></li>
        <li><span>2</span><div><strong>自动配置</strong><small>推荐底模起步</small></div></li>
        <li><span>3</span><div><strong>开始绘制</strong><small>选角色与场景</small></div></li>
      </ol>
    </section>
    <section class="control-health" aria-labelledby="control-health-title" :aria-busy="serviceChecking">
      <span class="control-health-mark"><ArchiveIcon :name="statusError ? 'warning' : 'info'" /></span>
      <div><h2 id="control-health-title">{{ overviewFeedback.title }}</h2><p>{{ overviewFeedback.note }}</p></div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="serviceChecking || opBusy" @click="pollStatus(true)"><ArchiveIcon name="refresh" />{{ serviceChecking ? '检测中…' : '刷新状态' }}</button>
    </section>
    <section aria-labelledby="control-next-title">
      <div class="control-section-heading"><h2 id="control-next-title">按需添加能力</h2></div>
      <div class="control-feature-grid">
        <RouterLink v-for="feature in features" :key="feature.id" class="control-feature" data-control-motion :to="{ query: route.query, hash: '#' + feature.id }">
          <ArchiveIcon :name="feature.icon" />
          <div><h3>{{ feature.title }}</h3><p>{{ feature.description }}</p><span>{{ feature.action }}<ArchiveIcon name="chevron-down" class="control-forward-icon" /></span></div>
        </RouterLink>
      </div>
    </section>
    <div class="control-bottom-links">
      <RouterLink data-control-motion :to="{ query: route.query, hash: '#control-services' }"><ArchiveIcon name="gear" />服务与连接</RouterLink>
      <RouterLink data-control-motion :to="{ query: route.query, hash: '#control-personalization' }"><ArchiveIcon name="palette" />外观设置</RouterLink>
      <RouterLink data-control-motion to="/prompt-builder"><ArchiveIcon name="spark" />进入绘制</RouterLink>
    </div>
  </div>
</template>
<script setup lang="ts">
import { useRoute } from 'vue-router'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useControlContext } from '@/composables/useControlContext'
import modelOriginal from '@/assets/illustrations/atelier-model-spot.webp'
import { useThemeIllustration } from '@/composables/useThemeIllustration'
const route = useRoute()
const { status } = useControlContext()
const { overviewFeedback, serviceChecking, statusError, opBusy, pollStatus } = status
const modelArt = useThemeIllustration(modelOriginal, 'model')
const features: Array<{ id: string; icon: ArchiveIconName; title: string; description: string; action: string }> = [
  { id: 'setup-chat-options', icon: 'chat', title: '角色互动', description: '接入本地或云端大模型，与角色开启对话。', action: '配置聊天' },
  { id: 'control-interrogate', icon: 'search', title: '提示词反推', description: '解析参考图片，提取风格与描述词。', action: '配置反推' },
  { id: 'control-library', icon: 'image', title: '素材画册', description: '管理角色立绘、场景卡片与离线素材。', action: '管理素材' },
]
</script>
