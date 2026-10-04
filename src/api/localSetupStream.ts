/** The two setup operations are request-owned streams: abort closes the reader
 * and the runtime's existing drop guard stops the worker. */
export async function readLocalSetupStream<T>(response: Response, signal: AbortSignal, consume: (event: unknown) => T | undefined): Promise<T> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    throw new Error(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : `模型操作请求失败（${response.status}）`)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('模型操作返回了无效响应')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', terminal: T | undefined
  const line = (value: string) => { if (value.trim()) terminal = consume(JSON.parse(value)) }
  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancelReader, { once: true })
  try {
    while (terminal === undefined) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      buffer += decoder.decode(part.value, { stream: !part.done })
      if (buffer.length > 64 * 1024) throw new Error('模型操作响应过大')
      const lines = buffer.split('\n'); buffer = lines.pop()!
      for (const value of lines) { line(value); if (terminal !== undefined) break }
      if (part.done) { if (terminal === undefined && buffer.trim()) line(buffer); break }
    }
    if (terminal === undefined) throw new Error('模型操作意外中断，未收到完整结果')
    return terminal
  } finally {
    signal.removeEventListener('abort', cancelReader)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
