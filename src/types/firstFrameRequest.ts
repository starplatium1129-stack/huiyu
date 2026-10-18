/** Saved before submission; edits and failed result mounting never replace this key. */
export interface FirstFrameRequest {
  key: string
  transport: 'direct' | 'runtime'
  authority: string
  state: 'pending' | 'succeeded' | 'failed' | 'cancelled'
  input: { prompt: string; modelId: 'krea2-turbo-fp8'; width: number; height: number }
}
export function readFirstFrameRequest(value: FirstFrameRequest): FirstFrameRequest {
  if (!value || typeof value.key !== 'string' || !/^[\w-]{1,160}$/.test(value.key) || !['direct', 'runtime'].includes(value.transport)
    || typeof value.authority !== 'string' || !['pending', 'succeeded', 'failed', 'cancelled'].includes(value.state)
    || !value.input || typeof value.input.prompt !== 'string' || !value.input.prompt.trim() || value.input.modelId !== 'krea2-turbo-fp8'
    || ![1024, 1536].includes(value.input.width) || ![1024, 1536].includes(value.input.height)
    || value.input.width === 1536 && value.input.height === 1536) throw new Error('首帧请求凭据无法读取；已停止生成，请核对原草稿。')
  return { key: value.key, transport: value.transport, authority: value.authority, state: value.state,
    input: { prompt: value.input.prompt, modelId: value.input.modelId, width: value.input.width, height: value.input.height } }
}
