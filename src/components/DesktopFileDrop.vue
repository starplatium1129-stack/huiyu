<template>
  <StudioDialog v-model:open="choosing" size="sm" title="使用拖入的图片" closedby="closerequest"
    :described-by="descriptionId" @close="closed">
    <p :id="descriptionId" class="drop-file-name">{{ selection?.name }}</p>
    <template #footer>
      <div class="drop-actions">
        <button class="btn btn-ghost" type="button" @click="choosing = false">取消</button>
        <button class="btn btn-ghost" type="button" @click="useImage('edit-image')">用作图生图原图</button>
        <button class="btn btn-primary" type="button" autofocus @click="useImage('interrogate')">反推提示词</button>
      </div>
    </template>
  </StudioDialog>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, useId } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StudioDialog from '@/components/ui/StudioDialog.vue'
import { desktopFileKind, discardDesktopFiles, queueDesktopFiles, type DesktopFileAction } from '@/composables/useDesktopFileDrop'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const descriptionId = useId()
const choosing = ref(false)
const selection = shallowRef<File | null>(null)
let working = false
let disposed = false
let imageAction: 'interrogate' | 'edit-image' | null = null

function isFiles(event: DragEvent) { return event.dataTransfer?.types.includes('Files') ?? false }

function allowDrop(event: DragEvent) {
  if (!event.defaultPrevented && isFiles(event)) {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
}

async function deliver(action: DesktopFileAction, files: File[], authority = runtimeResourceIdentity()) {
  const target = action === 'card' ? '/chat' : '/prompt-builder'
  try {
    if (route.path !== target) await router.push(target)
    if (disposed || route.path !== target) return
    if (authority !== runtimeResourceIdentity()) {
      toast.warning('工作区已切换，请重新拖入文件。')
      return
    }
    queueDesktopFiles(action, files, () => toast.warning('当前页面无法接收文件，请用页面的导入入口重试。'))
  } catch { toast.warning('无法打开目标页面，请重试。') }
}

function useImage(action: 'interrogate' | 'edit-image') {
  if (!selection.value) return
  imageAction = action
  choosing.value = false
}

function closed() {
  const file = selection.value
  const action = imageAction
  selection.value = null
  imageAction = null
  if (file && action) void deliver(action, [file])
}

async function drop(event: DragEvent) {
  if (!isFiles(event) || event.defaultPrevented) return
  event.preventDefault()
  if (working || choosing.value || selection.value || document.querySelector('dialog[open]')) return
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  if (files.length > 12) { toast.warning('一次最多导入 12 份文件。'); return }
  working = true
  const authority = runtimeResourceIdentity()
  try {
    const kinds = []
    for (const file of files) kinds.push(await desktopFileKind(file))
    if (disposed || authority !== runtimeResourceIdentity()) return
    if (kinds.every(kind => kind === 'card')) await deliver('card', files, authority)
    else if (kinds[0] === 'image' && files.length === 1) {
      selection.value = files[0]
      choosing.value = true
    } else toast.warning('请分别拖入 Tavern 角色卡，或拖入一张不超过 16 MiB 的 PNG、JPEG 或 WebP。')
  } catch { toast.warning('无法读取拖入的文件，请重试。') }
  finally { working = false }
}

onMounted(() => {
  window.addEventListener('dragover', allowDrop)
  window.addEventListener('drop', drop)
})
onUnmounted(() => {
  disposed = true
  window.removeEventListener('dragover', allowDrop)
  window.removeEventListener('drop', drop)
  discardDesktopFiles()
})
</script>

<style scoped>
.drop-file-name { color: var(--text-secondary); overflow-wrap: anywhere; }
.drop-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--s-2); }
</style>
