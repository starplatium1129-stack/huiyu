import { describe, expect, it } from 'vitest'
import { inspectModelFiles, MODEL_IMPORT_LIMITS, normalizeModelPath } from './modelInspector'

function file(path: string, contents: string | Uint8Array, folder = true): File {
  const result = new File([contents as BlobPart], path.split('/').at(-1)!)
  if (folder) Object.defineProperty(result, 'webkitRelativePath', { value: `selected/${path}` })
  return result
}
function png(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137,80,78,71,13,10,26,10], 0)
  bytes.set([73,72,68,82],12)
  new DataView(bytes.buffer).setUint32(16,width)
  new DataView(bytes.buffer).setUint32(20,height)
  return bytes
}
function fixture(refs: Record<string, unknown> = {}, extras: File[] = []): File[] {
  return [file('demo.model3.json', JSON.stringify({ Version: 3, FileReferences: { Moc: 'demo.moc3', Textures: ['texture.png'], ...refs },
    Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] }], HitAreas: [{ Id: 'HitHead', Name: 'Head' }] })),
  file('demo.moc3', 'MOC3fixture'), file('texture.png', png()), ...extras]
}
describe('local model static inspector', () => {
  it('hashes resources deterministically and reports candidates without inventing runtime ranges', async () => {
    const files = fixture({ DisplayInfo: 'demo.cdi3.json', Expressions: [{ Name: 'Smile', File: 'smile.exp3.json' }], Motions: { Idle: [{ File: 'idle.motion3.json' }] } }, [
      file('demo.cdi3.json', JSON.stringify({ Parameters: [{ Id: 'CustomMouth', Name: '自定义嘴' }] })),
      file('smile.exp3.json', JSON.stringify({ Parameters: [{ Id: 'ParamMouthForm', Value: 1 }] })),
      file('idle.motion3.json', JSON.stringify({ Curves: [{ Target: 'Parameter', Id: 'ParamAngleX' }] })),
    ])
    const result = await inspectModelFiles(files)
    expect(result.valid).toBe(true)
    expect(result.entryPath).toBe('demo.model3.json')
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect((await inspectModelFiles([...files].reverse())).fingerprint).toBe(result.fingerprint)
    expect(result.candidates.parameters).toContainEqual({ id: 'CustomMouth', name: '自定义嘴', sources: ['cdi'], semantics: [] })
    expect(result.issues).toEqual([expect.objectContaining({ code: 'runtime-required', severity: 'warning' })])
    expect(result.candidates.motions).toEqual([{ group: 'Idle', index: 0, path: 'idle.motion3.json' }])
  })
  it.each(['../escape.moc3', '/absolute.moc3', 'C:/user/a.moc3', 'https://host/a.moc3', '%2e%2e/a.moc3', 'a\\b.moc3', 'a/./b.moc3', 'a//b.moc3', 'a.moc3?x', 'CON.moc3'])('rejects unsafe reference %s', async reference => {
    expect(normalizeModelPath(reference)).toBeNull()
    expect((await inspectModelFiles(fixture({ Moc: reference }))).issues.some(issue => issue.code === 'unsafe-reference')).toBe(true)
  })
  it('rejects missing textures, cores, corrupt headers, duplicate paths and executable assets', async () => {
    for (const files of [fixture().slice(0,2), fixture({ Moc: 'missing.moc3' }), fixture({}, [file('TEXTURE.png', png())]), fixture({}, [file('run.js', 'alert(1)')]), [fixture()[0]!,file('demo.moc3','bad core'),fixture()[2]!]]) {
      expect((await inspectModelFiles(files)).valid).toBe(false)
    }
  })
  it('requires disambiguation and preserves nested relative references', async () => {
    const files = fixture().map(entry => file(`nested/${entry.name}`, new Uint8Array()))
    const originals = fixture()
    for (let i = 0; i < originals.length; i++) files[i] = file(`nested/${originals[i]!.name}`, new Uint8Array(await originals[i]!.arrayBuffer()))
    files.push(file('other.model3.json','{}'))
    expect((await inspectModelFiles(files)).issues[0]?.code).toBe('entry-required')
    expect((await inspectModelFiles(files,'nested/demo.model3.json')).valid).toBe(true)
  })
  it('rejects JSON parsing/depth/prototype attacks and oversized image headers', async () => {
    for (const contents of ['{', '{"__proto__":{}}', JSON.stringify({ x: Array.from({length:40}).reduce(value => ({x:value}), {} as object) })]) {
      expect((await inspectModelFiles(fixture({},[file('attack.json',contents)]))).valid).toBe(false)
    }
    const files = fixture(); files[2] = file('texture.png',png(65535,65535))
    expect((await inspectModelFiles(files)).issues.some(issue => issue.code === 'texture-size')).toBe(true)
  })
  it('enforces limits before reading bytes', async () => {
    const files = fixture()
    Object.defineProperty(files[1], 'size', { value: MODEL_IMPORT_LIMITS.fileBytes + 1 })
    expect((await inspectModelFiles(files)).issues.some(issue => issue.code === 'file-size')).toBe(true)
    expect((await inspectModelFiles(Array(513).fill(files[0]))).issues[0]?.code).toBe('file-count')
  })
  it('rejects remote motion audio and malformed optional reference containers', async () => {
    for (const refs of [{ Expressions: 'bad' }, { Motions: [] }, { Motions: { Idle: [{ File: 'idle.motion3.json', Sound: 'https://host/track.mp3' }] } }]) {
      const result = await inspectModelFiles(fixture(refs, [file('idle.motion3.json', '{}')]))
      expect(result.valid).toBe(false)
    }
  })
  it('rejects read failures and byte-length mismatch', async () => {
    for (const read of [async () => { throw new Error('private directory details') }, async () => new ArrayBuffer(1)]) {
      const files = fixture()
      Object.defineProperty(files[1], 'arrayBuffer', { value: read })
      const result = await inspectModelFiles(files)
      expect(result.valid).toBe(false)
      expect(JSON.stringify(result.issues)).not.toContain('private directory')
    }
  })
})
