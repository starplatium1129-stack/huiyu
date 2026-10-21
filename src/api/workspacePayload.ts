/** Reads need no encoder. JSON commands, migration bytes and artwork chunks
 * load their request-body encoding only when the first body is sent. */
export function workspacePayload(command: Record<string, unknown>, workspaceId: string, path: string) {
  const binary = command.kind === 'uploadChunk' || command.kind === 'uploadMediaChunk'
  if (binary) {
    if (!(command.data instanceof Blob)) throw new Error('图片上传分块无效')
    return { path: path + '?' + new URLSearchParams({ protocolVersion: '1', workspaceId, offset: String(command.offset) }),
      headers: { 'Content-Type': 'application/octet-stream' }, body: command.data }
  }
  let data = command.data
  // Migration still owns a JSON protocol; its binary records are independent
  // of the artwork upload endpoints and retain their existing encoding.
  if (data instanceof Uint8Array) {
    let value = ''
    for (let offset = 0; offset < data.length; offset += 32768) value += String.fromCharCode(...data.subarray(offset, offset + 32768))
    data = btoa(value)
  }
  return { path, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...command, ...(data === undefined ? {} : { data }), protocolVersion: 1, workspaceId }) }
}
