<template>
  <div class="control-page">
    <RouteAtmosphere />
    <a class="skip-link" href="#control-main" @click.prevent="focusMain">跳到主要内容</a>
    <div class="control-layout">
      <aside class="control-rail" aria-label="控制面板导航">
        <RouterLink to="/" class="control-rail-brand"><BrandLogo class="nav-logo" /><span>控制面板</span></RouterLink>
        <nav class="control-rail-nav" aria-label="设置分区">
          <div v-for="group in groups" :key="group.label" class="control-nav-group">
            <p class="control-nav-label">{{ group.label }}</p>
            <RouterLink v-for="item in group.sections" :key="item.id" class="control-rail-link"
              :to="{ path: '/control', hash: '#' + item.id }" :aria-current="activeSection === item.id ? 'page' : undefined">
              <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span><span v-if="activeSection === item.id" class="control-nav-dot" aria-hidden="true" />
            </RouterLink>
          </div>
        </nav>
        <div class="control-rail-foot">
          <RouterLink class="control-home-link nav-local-home" to="/"><ArchiveIcon name="chevron-down" class="control-back-icon" />返回画室</RouterLink>
          <div class="control-utility-row"><TaskCenterButton /><AppThemeToggle /><AppSoundToggle /></div>
        </div>
      </aside>
      <div class="control-content">
        <header class="control-compact-nav">
          <RouterLink to="/" aria-label="返回绘遇"><BrandLogo class="nav-logo" /></RouterLink>
          <div class="control-utility-row"><TaskCenterButton /><AppThemeToggle /><AppSoundToggle /></div>
          <StudioSelect :model-value="activeSection" label="控制面板分区" :groups="compactOptions" @update:model-value="selectSection" @trigger-hidden="focusNavigation" />
        </header>
        <main id="control-main" class="control-shell" tabindex="-1">
          <ControlIntro :title="currentSection.label" :description="currentSection.description" :group="currentSection.group">
            <template #actions><RouterLink class="btn btn-ghost btn-sm" to="/guide"><ArchiveIcon name="book" />使用指南</RouterLink></template>
          </ControlIntro>
          <div v-if="statusError" class="control-alert" role="alert">
            <ArchiveIcon name="warning" /><span>{{ statusError }}。设置与服务状态待确认。</span>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="serviceChecking || opBusy" @click="pollStatus(true)">{{ serviceChecking ? '检测中…' : '重新连接' }}</button>
          </div>
          <ControlOperation :active-section="activeSection" />
          <!-- Retain opened panels so switching never discards downloads, recovery or unsaved drafts. -->
          <div v-for="item in controlSections" :key="item.id" v-show="activeSection === item.id"
            class="control-section" :data-control-section="item.id" v-content-motion:right="activeSection === item.id">
            <template v-if="visited.has(item.id) || item.id === 'control-setup' && localSetupRequested">
              <ControlWelcome v-if="item.id === 'control-overview'" />
              <ControlSetupPanel v-else-if="item.id === 'control-setup'" />
              <AsyncPanel v-else-if="item.id === 'control-interrogate'" :loader="loadInterrogateSetup" label="图片反推" v-slot="{ component }"><component :is="component" /></AsyncPanel>
              <ResourceLibraryPanel v-else-if="item.id === 'control-library'" />
              <div v-else-if="item.id === 'control-personalization'" class="control-panel-stack">
                <section class="panel-card"><div class="panel-kicker">随时调整 · 自动保存</div><h2 class="panel-heading">让画室更合你心意</h2><p class="control-section-note">主题、字号和动态效果可在外观面板中调整。</p><AppearancePreferences launcher-only /></section>
                <DesktopPreferences />
              </div>
              <ControlServicesPanel v-else-if="item.id === 'control-services'" />
              <ControlSharePanel v-else-if="item.id === 'control-share'" />
              <ControlLogsPanel v-else-if="item.id === 'control-logs'" :active="activeSection === item.id" />
            </template>
          </div>
        </main>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import AppearancePreferences from '@/components/AppearancePreferences.vue'
import BrandLogo from '@/components/BrandLogo.vue'
import TaskCenterButton from '@/components/tasks/TaskCenterButton.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AppSoundToggle from '@/components/AppSoundToggle.vue'
import AppThemeToggle from '@/components/AppThemeToggle.vue'
import DesktopPreferences from '@/components/DesktopPreferences.vue'
import ControlIntro from '@/components/ControlIntro.vue'
import ResourceLibraryPanel from '@/components/ResourceLibraryPanel.vue'
import RouteAtmosphere from '@/components/visual/RouteAtmosphere.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ControlWelcome from '@/components/control/ControlWelcome.vue'
import ControlSetupPanel from '@/components/control/ControlSetupPanel.vue'
import ControlServicesPanel from '@/components/control/ControlServicesPanel.vue'
import ControlSharePanel from '@/components/control/ControlSharePanel.vue'
import ControlLogsPanel from '@/components/control/ControlLogsPanel.vue'
import ControlOperation from '@/components/control/ControlOperation.vue'
import { controlSections, useControlNavigation } from '@/composables/useControlNavigation'
import { provideControlContext } from '@/composables/useControlContext'
import { useLocalSetupPanelLoading } from '@/composables/useLocalSetupPanelLoading'
const router = useRouter()
const { status } = provideControlContext()
const { statusError, serviceChecking, opBusy, pollStatus } = status
const { activeSection, currentSection, groups, visited, focusNavigation } = useControlNavigation(status.imageProvider)
const { localSetupRequested } = useLocalSetupPanelLoading()
const compactOptions = groups.map(group => ({ label: group.label, options: group.sections.map(section => ({ value: section.id, label: section.label })) }))
const loadInterrogateSetup = () => import('@/components/InterrogateSetupPanel.vue')
function selectSection(id: string | number) { void router.push({ path: '/control', hash: '#' + id }) }
function focusMain() { document.getElementById('control-main')?.focus({ preventScroll: true }) }
onMounted(status.startPolling)
onUnmounted(status.stopPolling)
</script>
<style src="@/assets/css/control-view.css"></style>
