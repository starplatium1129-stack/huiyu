<script setup lang="ts">
import { useCompanionToolPermissions, type CompanionToolPermissions } from '@/composables/chat/useCompanionToolPermissions'
const { permissions, saving, error, update } = useCompanionToolPermissions()
const choices: Array<{ key: keyof CompanionToolPermissions; label: string }> = [
  { key: 'readFiles', label: '读取文件与图片' }, { key: 'writeFiles', label: '写入创作文件' },
  { key: 'captureScreen', label: '屏幕截图（逐次确认）' }, { key: 'commands', label: '执行命令（还需主机授权）' },
]
</script>

<template>
  <fieldset class="tool-permissions">
    <legend>本机工具权限 · 全窗口共享</legend>
    <div class="tool-permission-options">
      <button v-for="choice in choices" :key="choice.key" class="btn btn-ghost btn-sm" type="button"
        :aria-pressed="permissions[choice.key]" :disabled="saving" @click="update(choice.key, !permissions[choice.key])">
        {{ choice.label }}：{{ permissions[choice.key] ? '允许' : '关闭' }}
      </button>
    </div>
    <p>允许读取的文件内容会发送给本次聊天 API；截图需每次确认截取并发送。写入仅限 creations/ 创作目录。</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </fieldset>
</template>

<style scoped>
.tool-permissions { min-width:0; margin:0; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); }
.tool-permissions legend, .tool-permissions p { color:var(--text-secondary); font-size:var(--fs-body-sm); }
.tool-permissions p { margin:var(--s-2) 0 0; }
.tool-permission-options { display:flex; flex-wrap:wrap; gap:var(--s-2); }
</style>
