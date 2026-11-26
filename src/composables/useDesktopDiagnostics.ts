import { ref } from 'vue'
import { getDesktopRecovery } from '@/platform/desktop/recovery'
import { useToast } from '@/composables/useToast'

const exporting = ref(false)

export function useDesktopDiagnostics() {
  const recovery = getDesktopRecovery()
  const toast = useToast()
  async function exportDiagnostics() {
    if (!recovery || exporting.value) return
    exporting.value = true
    try {
      if (await recovery.exportDiagnostics()) toast.success('脱敏诊断包已保存')
    } catch {
      toast.error('诊断包未保存，请检查保存位置后重试')
    } finally {
      exporting.value = false
    }
  }
  return { exporting, exportDiagnostics }
}
