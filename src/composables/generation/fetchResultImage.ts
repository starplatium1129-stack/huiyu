import { runtimeFetch as fetch } from '@/platform/runtimeUrl'
export async function fetchResultImage(url: string, signal: AbortSignal): Promise<Blob> {
    if (signal.aborted) throw new Error('请求已取消')
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
      const contentType = String(response.headers.get('content-type') || '')
      if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`)
      if (!contentType.startsWith('image/')) throw new Error('网关返回的结果不是图片')
      const blob = await response.blob()
      if (!blob.size) throw new Error('生成结果为空')
      return blob
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal.aborted ? '请求已取消' : '图片读取超时（30 秒）')
      throw error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }
