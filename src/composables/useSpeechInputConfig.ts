import { ref, shallowRef } from 'vue'
import { loadSpeechInputConfig, normalizeSpeechInputConfig } from '@/utils/speechInputConfig'

/** 读取失败只禁用当前页面的语音；原记录不写入、不删除，设置面板可显式重试。 */
export function useSpeechInputConfig() {
  const config = ref(normalizeSpeechInputConfig(null))
  const loadError = shallowRef<unknown>(null)

  function reload(): void {
    try {
      config.value = loadSpeechInputConfig()
      loadError.value = null
    } catch (error) {
      config.value = normalizeSpeechInputConfig(null)
      loadError.value = error
    }
  }

  reload()
  return { config, loadError, reload }
}
