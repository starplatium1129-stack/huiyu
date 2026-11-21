<script setup lang="ts">
import StudioDialog from '@/components/ui/StudioDialog.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ characterId?: string }>()

const steps = [
  {
    number: '1',
    icon: 'character',
    title: '挑选起点（不选也能画）',
    body: '在「选角色」中挑一位角色，可以直接画她的默认造型，也可以继续挑她的场景蓝图；如果想自己发挥，切到「自由画」点一张现成灵感卡片即可。',
  },
  {
    number: '2',
    icon: 'spark',
    title: '写画面或点氛围标签',
    body: '描述框支持中文或英文，选了角色或场景后也可以额外补充细节。不会写也没关系，直接点下方的氛围小标签就能一键加料，或留空直接点「开始绘制」试画一张。',
  },
  {
    number: '3',
    icon: 'download',
    title: '放大欣赏并下载保存',
    body: '画面由房主的电脑实时绘制。点击成品图可以无损放大看细节，底部会保留本次试玩的作品胶片；关闭或刷新页面后记录会清空，喜欢的作品记得点「下载原图」。',
  },
] as const
</script>

<template>
  <StudioDialog
    v-model:open="open"
    title="三步上手好友试玩"
    subtitle="无需配置参数或记忆英文词条，挑个灵感就能画"
    size="md"
    :character="props.characterId"
    close-label="关闭玩法说明"
  >
    <ol class="guest-helpList">
      <li v-for="step in steps" :key="step.number" class="guest-helpItem">
        <span class="guest-helpStep" aria-hidden="true">{{ step.number }}</span>
        <div class="guest-helpText">
          <strong><ArchiveIcon :name="step.icon" />{{ step.title }}</strong>
          <p>{{ step.body }}</p>
        </div>
      </li>
    </ol>

    <div class="guest-helpShortcut">
      <ArchiveIcon name="lightning" />
      <span>小技巧：在描述框内按 <kbd>Ctrl</kbd> + <kbd>Enter</kbd>（Mac 按 <kbd>⌘</kbd> + <kbd>Enter</kbd>）可直接开始绘制。</span>
    </div>

    <template #footer="{ close }">
      <button class="btn btn-primary" type="button" autofocus @click="close('')">知道了，去创作</button>
    </template>
  </StudioDialog>
</template>

<style scoped>
.guest-helpList {
  display: grid;
  gap: var(--s-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.guest-helpItem {
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
  padding: var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-base);
}

.guest-helpStep {
  display: grid;
  place-items: center;
  flex: none;
  inline-size: var(--s-6);
  block-size: var(--s-6);
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--character-accent, var(--accent)) 36%, transparent);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-label);
  font-weight: 700;
}

.guest-helpText {
  min-inline-size: 0;
}

.guest-helpText strong {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  color: var(--text-primary);
  font-size: var(--fs-body-sm);
  font-weight: 600;
}

.guest-helpText strong .archive-icon {
  color: var(--accent);
}

.guest-helpText p {
  margin: var(--s-1) 0 0;
  color: var(--text-secondary);
  font-size: var(--fs-label);
  line-height: var(--lh-body);
}

.guest-helpShortcut {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-block-start: var(--s-3);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
  line-height: var(--lh-body);
}

.guest-helpShortcut .archive-icon {
  flex: none;
  color: var(--accent);
}
</style>
