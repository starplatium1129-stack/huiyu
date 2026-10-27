import type { AnimeRig } from './types'

const root = '/vendor/anime25d/'
const psdErrors: Record<string, string> = {
  'PSDファイルが短すぎます': 'PSD 文件不完整，请重新导出',
  '対応するPSDファイルではありません（PSBは未対応）': '文件不是受支持的 PSD，暂不支持 PSB',
  'PSDのサイズは一辺16384px・2400万画素以内にしてください': 'PSD 单边不能超过 16384 像素，总面积不能超过 2400 万像素',
  'PSDをRGB・8bit/チャンネルで保存し直してください': '请将 PSD 重新保存为 RGB、每通道 8 位',
}
let scripts: Promise<void> | undefined
export function loadAnimeRenderer(): Promise<void> {
  return scripts ??= (async () => {
    for (const file of ['runtime.js', 'rigger.js', 'renderer.js', 'stage.js']) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = root + file
        script.onload = () => resolve()
        script.onerror = () => { script.remove(); reject(new Error('2.5D 渲染器加载失败，请重试')) }
        document.head.append(script)
      })
    }
  })().catch(error => { scripts = undefined; throw error })
}

export function parseAnimePsd(file: Blob, signal: AbortSignal, progress: (text: string) => void): Promise<AnimeRig> {
  if (file.size > 128 * 1024 * 1024) return Promise.reject(new Error('PSD 不能超过 128 MB'))
  return new Promise((resolve, reject) => {
    let fingerprint = ''
    const worker = new Worker(root + 'psd-worker.js')
    const finish = (error?: unknown, rig?: AnimeRig) => {
      worker.terminate()
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve({ ...rig!, fingerprint })
    }
    const abort = () => finish(new DOMException('已取消 PSD 加载', 'AbortError'))
    const timeout = window.setTimeout(() => finish(new Error('PSD 解析超时，请缩小图片或减少图层后重试')), 120_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }) => {
      if (data.progress) progress(data.progress)
      else if (data.error) {
        const message = String(data.error)
        const knownMessage = psdErrors[message] || (message.startsWith('请导入包含 face') ? message : '')
        if (!knownMessage) console.error('PSD 解析失败:', message)
        finish(new Error(knownMessage || 'PSD 解析失败，请检查文件格式和图层后重试'))
      }
      else if (data.rig) finish(undefined, data.rig)
    }
    worker.onerror = event => { event.preventDefault(); finish(new Error('PSD 解析进程失败，请检查文件或缩小图片')) }
    if (signal.aborted) { abort(); return }
    void file.arrayBuffer().then(async buffer => {
      const digest = await crypto.subtle.digest('SHA-256', buffer)
      fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (!signal.aborted) worker.postMessage({ buffer }, [buffer])
    }).catch(finish)
  })
}
