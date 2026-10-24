<template>
<section class="panel-card share-panel" aria-labelledby="control-share-title">
        <header class="panel-summary"><span><span class="panel-kicker">按需开启</span><span class="panel-heading" id="control-share-title" role="heading" aria-level="2">分享与访问</span></span><span class="summary-state">{{ !statusLoaded || statusError ? '状态待确认' : tunnelActive ? '分享中' : '仅本机' }}</span></header>
        <div data-disclosure-content class="share-content">

        <div class="tunnel-toggle-row">
          <div class="tunnel-toggle-label">
            <span id="tunnel-switch-label" class="tunnel-toggle-text">允许创建公网分享链接</span>
            <span class="tunnel-toggle-hint">{{ tunnelActive ? (tunnelEnabled ? '朋友可通过临时链接访问' : '分享仍在运行，点击下方停止后仅本机可访问') : tunnelEnabled ? '启动后生成临时链接，当前仅本机可访问' : '当前仅本机可访问' }}</span>
          </div>
          <ToggleSwitch
            class="tunnel-switch-control"
            :model-value="tunnelEnabled"
            :disabled="actionBusy || opBusy"
            aria-labelledby="tunnel-switch-label"
            @update:model-value="toggleTunnel"
          />
        </div>

        <button
          class="btn share-start"
          :class="tunnelActive ? 'btn-danger' : 'btn-primary'"
          type="button"
          :disabled="actionBusy || opBusy || (!tunnelActive && (savingConfig || !tunnelEnabled || !statusUsable))"
          @click="tunnelActive ? doStop() : doStart()"
        >{{ !tunnelActive && !tunnelEnabled ? '仅本机访问' : mainBtnLabel }}</button>

        <div class="access-grid tw:grid tw:gap-s-3">
          <div class="access-card">
            <div class="access-title">本机地址</div>
            <div class="link-value">{{ localLink }}</div>
            <div class="inline-actions tw:flex tw:gap-s-2">
              <StudioCopyButton class="btn btn-ghost btn-sm" label="复制地址" :content-key="localLink" :action="() => copyWithFeedback(localLink)" />
              <a class="btn btn-ghost btn-sm" :href="localLink" target="_blank" rel="noreferrer">打开</a>
            </div>
          </div>
          <div class="access-card">
            <div class="access-title">分享链接</div>
            <div class="link-value" :class="{ waiting: !shareLink }">{{ shareLink || (tunnelStatus === 'disabled' ? '未生成公网链接' : '等待分享链接…') }}</div>
            <div class="inline-actions tw:flex tw:gap-s-2">
              <StudioCopyButton class="btn btn-ghost btn-sm" label="复制链接" :content-key="shareLink" :disabled="!shareLink" :action="() => copyWithFeedback(shareLink)" />
            </div>
          </div>
        </div>
        <div class="uptime">{{ uptime }}</div>
        <p class="security-note">分享链接可以使用你电脑上的创作服务，请只发给信任的人。</p>

        <!-- 前端构建：分享伺服 dist/，源码改动后需重建 -->
        <details class="build-card" :data-stale="webBuildStale ? 'true' : 'false'">
          <StudioDisclosureSummary>高级 · 更新分享页面</StudioDisclosureSummary>
          <div data-disclosure-content>
          <div class="build-head">
            <span class="build-kicker">分享页面</span>
            <strong>{{ buildLabel }}</strong>
          </div>
          <p class="build-desc">{{ buildDesc }}</p>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="buildingWeb || opBusy" @click="buildWeb">
            {{ buildingWeb ? '构建中…' : '重新构建前端' }}
          </button>
          </div>
        </details>
        </div>
      </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import { useControlContext } from '@/composables/useControlContext'
const { status, actions } = useControlContext()
const { tunnelActive, statusLoaded, statusError, tunnelStatus, shareLink, localLink, uptime, actionBusy, mainBtnLabel, webBuild, opBusy } = status
const { tunnelEnabled, toggleTunnel, savingConfig, doStart, doStop, buildWeb, buildingWeb } = actions
const statusUsable = computed(() => statusLoaded.value && !statusError.value)
const webBuildStale = computed(() => !!webBuild.value && webBuild.value.stale && webBuild.value.distReady)
const buildLabel = computed(() => {
  if (!webBuild.value) return '构建状态未知'
  if (!webBuild.value.distReady) return '尚未构建'
  if (webBuild.value.stale) return '构建已过期'
  return '构建已是最新'
})
const buildDesc = computed(() => {
  if (!webBuild.value || !webBuild.value.distReady) return '公网分享伺服的是构建产物；尚未构建时分享可能无法显示最新页面。'
  const built = webBuild.value.builtAt ? '于 ' + new Date(webBuild.value.builtAt).toLocaleString('zh-CN') + ' 构建' : ''
  if (webBuild.value.stale) return built + '，但源码此后有修改——分享出去的是旧版页面，请重新构建。'
  return built + '，与当前源码一致。'
})
</script>
