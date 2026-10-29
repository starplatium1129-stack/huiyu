<script setup lang="ts">
import { ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import collectionArt from '@/assets/illustrations/atelier-collection-spot.webp'
import { openResourceAssistant } from '@/platform/desktop/resourceAssistant'
const opening = ref(false), error = ref('')
async function open() {
  if (opening.value) return
  opening.value = true; error.value = ''
  try { await openResourceAssistant() }
  catch { error.value = '安装助手未能打开，请重新启动绘遇后再试。' }
  finally { opening.value = false }
}
</script>
<template>
  <div class="resource-install-entry">
    <div class="resource-install-copy"><span>官方离线素材</span><h3>把素材画册装进绘遇</h3><p>选择 ZIP 自动解压，或直接使用已解压的文件夹。图片留在素材目录，按需加载，保留你的作品。</p><button class="btn btn-primary" type="button" :disabled="opening" @click="open"><ArchiveIcon name="download" />{{ opening ? '正在打开…' : '打开安装助手' }}</button><p v-if="error" role="alert" class="resource-install-error">{{ error }}</p><small>无需再次复制整包素材</small></div>
    <img :src="collectionArt" alt="" />
  </div>
</template>
<style scoped>
.resource-install-entry { display:flex; align-items:center; gap:var(--s-5); margin-block:var(--s-5); padding:var(--s-5); background:var(--bg-deep); border:1px solid var(--border-soft); border-radius:var(--r-lg); }
.resource-install-copy { flex:1; min-width:0; }
.resource-install-copy > span,.resource-install-copy small { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.resource-install-copy h3 { font-size:20px; margin:var(--s-2) 0; }
.resource-install-copy p { color:var(--text-secondary); font-size:var(--fs-label); line-height:1.8; margin:0 0 var(--s-4); max-width:38em; }
.resource-install-copy small { display:block; margin-top:var(--s-2); }
.resource-install-entry img { width:180px; height:180px; object-fit:contain; }
.resource-install-entry button:disabled { color:var(--text-disabled); opacity:1; }
.resource-install-copy .resource-install-error { margin-top:var(--s-3); color:var(--danger-text); }
@media (max-width:760px) { .resource-install-entry img { width:100px; height:100px; } }
</style>
