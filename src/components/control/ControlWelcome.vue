<template>
  <div class="control-panel-stack">
    <section class="control-start" aria-labelledby="control-start-title">
      <div class="control-start-copy">
        <span class="panel-kicker">第一次使用，从这里开始</span>
        <h2 id="control-start-title">为第一张画，准备好画室</h2>
        <p>一键自动配置推荐底模；聊天、语音与扩展工具可随创作需求随时按需添加。</p>
        <div class="control-start-actions">
          <RouterLink class="btn btn-primary" :to="{ path: '/control', hash: '#control-setup' }"><ArchiveIcon name="download" />准备绘图模型</RouterLink>
          <RouterLink class="btn btn-quiet" to="/scene-explorer">先逛逛灵感场景<ArchiveIcon name="chevron-down" class="control-forward-icon" /></RouterLink>
        </div>
      </div>
      <img :src="modelArt" width="512" height="512" class="control-start-art" alt="" />
      <ol class="control-start-steps" aria-label="入门流程">
        <li><span>1</span><div><strong>选择模型目录</strong><small>先确认磁盘可用空间</small></div></li>
        <li><span>2</span><div><strong>下载并自动配置</strong><small>推荐模型起步，中断可续传</small></div></li>
        <li><span>3</span><div><strong>开始创作</strong><small>选角色与场景，画出第一幕</small></div></li>
      </ol>
    </section>
    <section class="control-health" aria-labelledby="control-health-title" :aria-busy="serviceChecking">
      <span class="control-health-mark"><ArchiveIcon :name="statusError ? 'warning' : 'info'" /></span>
      <div><h2 id="control-health-title">{{ overviewFeedback.title }}</h2><p>{{ overviewFeedback.note }}</p></div>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="serviceChecking || opBusy" @click="pollStatus(true)"><ArchiveIcon name="refresh" />{{ serviceChecking ? '检测中…' : '刷新状态' }}</button>
    </section>
    <section aria-labelledby="control-next-title">
      <div class="control-section-heading"><h2 id="control-next-title">接下来，按需添加</h2><p>不必全部安装，先准备你想用的功能。</p></div>
      <div class="control-feature-grid">
        <RouterLink v-for="feature in features" :key="feature.id" class="control-feature" data-control-motion :to="{ query: route.query, hash: '#' + feature.id }">
          <ArchiveIcon :name="feature.icon" />
          <div><h3>{{ feature.title }}</h3><p>{{ feature.description }}</p><span>{{ feature.action }}<ArchiveIcon name="chevron-down" class="control-forward-icon" /></span></div>
        </RouterLink>
      </div>
    </section>
    <div class="control-bottom-links">
      <RouterLink data-control-motion :to="{ query: route.query, hash: '#control-services' }"><ArchiveIcon name="gear" />检查服务与连接</RouterLink>
      <RouterLink data-control-motion :to="{ query: route.query, hash: '#control-personalization' }"><ArchiveIcon name="palette" />调整画室外观</RouterLink>
      <RouterLink data-control-motion to="/prompt-builder"><ArchiveIcon name="spark" />已有模型，进入创作</RouterLink>
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
  { id: 'setup-chat-options', icon: 'chat', title: '与角色互动聊天', description: '接入本地大模型或云端 API，与喜欢的角色开启自由对话。', action: '配置本地聊天' },
  { id: 'control-interrogate', icon: 'search', title: '图片提示词反推', description: '智能分析参考图片，提炼出可用于二次创作的风格与标签描述。', action: '配置图片反推' },
  { id: 'control-library', icon: 'image', title: '离线素材画册', description: '导入并管理官方素材包与参考画册，无需联网随时翻阅。', action: '管理资源库' },
]
</script>
