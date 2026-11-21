<template>
<section class="panel-card share-panel" aria-labelledby="control-share-title">
        <header class="panel-summary"><span class="panel-heading" id="control-share-title" role="heading" aria-level="2">好友试玩</span><span class="summary-state" role="status">{{ shareStatus }}</span></header>
        <div data-disclosure-content class="share-content">

        <p class="security-note">好友用浏览器打开邀请链接，你的电脑负责出图。试玩期间请保持绘遇运行、电脑联网。</p>

        <button
          class="btn share-start"
          :class="tunnelActive ? 'btn-danger' : 'btn-primary'"
          type="button"
          :disabled="!!shareAction || (!tunnelActive && (opBusy || !statusUsable))"
          @click="tunnelActive ? doStop() : doStart()"
        >{{ mainBtnLabel }}</button>

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
            <div class="access-title">{{ tunnelManaged ? '固定域名邀请' : '临时邀请' }}</div>
            <div class="link-value" :class="{ waiting: !shareLink }">{{ inviteDisplay }}</div>
            <div class="inline-actions tw:flex tw:gap-s-2">
              <StudioCopyButton class="btn btn-ghost btn-sm" label="复制链接" :content-key="shareLink" :disabled="!shareLink" :action="() => copyWithFeedback(shareLink)" />
            </div>
          </div>
        </div>
        <div class="uptime">{{ uptime }}</div>
        <p class="security-note">{{ tunnelManaged ? '网络恢复后可继续使用原链接。手动停止后，旧邀请立即失效。' : '临时链接可能随重连更换。固定域名可保留同一个链接。' }}</p>

        <!-- 前端构建：分享伺服 dist/，源码改动后需重建 -->
        <details class="build-card" :data-stale="webBuildStale ? 'true' : 'false'">
          <StudioDisclosureSummary>更新分享页面</StudioDisclosureSummary>
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
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import { useControlContext } from '@/composables/useControlContext'
const { status, actions } = useControlContext()
const { tunnelActive, statusLoaded, statusError, tunnelStatus, tunnelManaged, shareLink, localLink, uptime, webBuild, opBusy } = status
const { doStart, doStop, buildWeb, buildingWeb, shareAction } = actions
const statusUsable = computed(() => statusLoaded.value && !statusError.value)
const mainBtnLabel = computed(() => {
  if (shareAction.value === 'start') return '正在开启…'
  if (shareAction.value === 'stop') return '正在停止…'
  return tunnelActive.value ? '停止好友试玩' : '开启好友试玩'
})
const shareStatus = computed(() => {
  if (!statusUsable.value) return '状态待确认'
  if (tunnelStatus.value === 'connecting') return '正在连接公网'
  return tunnelStatus.value === 'active' ? '可通过公网访问' : '未开启'
})
const inviteDisplay = computed(() => {
  if (shareLink.value) return shareLink.value.split(/[?#]/, 1)[0]
  return tunnelActive.value ? '通过公网检查后即可复制' : '开启后生成邀请链接'
})
const webBuildStale = computed(() => !!webBuild.value && webBuild.value.stale && webBuild.value.distReady)
const buildLabel = computed(() => {
  if (!webBuild.value) return '构建状态未知'
  if (!webBuild.value.distReady) return '尚未构建'
  if (webBuild.value.stale) return '构建已过期'
  return '构建已是最新'
})
const buildDesc = computed(() => {
  if (!webBuild.value || !webBuild.value.distReady) return '请更新桌面端或构建网页，以安装好友试玩页面。'
  const built = webBuild.value.builtAt ? '于 ' + new Date(webBuild.value.builtAt).toLocaleString('zh-CN') + ' 构建' : ''
  if (webBuild.value.stale) return built + '，之后源码有更新。重新构建并开启试玩即可使用新版。'
  return built + '。进行中的分享继续使用开启时的版本。'
})
</script>
