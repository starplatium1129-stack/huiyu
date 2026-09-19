import fs from 'node:fs'
import path from 'node:path'

export type ModelManifest = Record<string, any>

/** Author paths are data: reject URLs, encoded separators, traversal and junction escapes. */
export function modelFile(directory: string, reference: string): string {
  if (typeof reference !== 'string' || !reference || /[:%?#\0]/.test(reference)
    || path.isAbsolute(reference) || reference.replace(/\\/g, '/').split('/').includes('..')) throw new Error('Invalid model reference')
  const root = fs.realpathSync(directory)
  const file = fs.realpathSync(path.resolve(directory, reference))
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error('Invalid model file')
  return file
}

export function modelFormat(model: ModelManifest): 'cubism2' | 'cubism3' {
  if (model.Version === 3 && typeof model.FileReferences?.Moc === 'string'
    && Array.isArray(model.FileReferences.Textures) && model.FileReferences.Textures.length) return 'cubism3'
  if (typeof model.model === 'string' && Array.isArray(model.textures) && model.textures.length) return 'cubism2'
  throw new Error('Model requires a core and at least one texture')
}

/** Mutates only the caller's parsed copy. Both runtimes share reference validation/URL rewriting. */
export function mapModelReferences(model: ModelManifest, map: (file: string) => string): void {
  const modern = modelFormat(model) === 'cubism3'
  const refs = modern ? model.FileReferences : model
  for (const key of modern ? ['Moc', 'Physics', 'Pose', 'DisplayInfo'] : ['model', 'physics', 'pose']) {
    if (refs[key]) refs[key] = map(refs[key])
  }
  const textureKey = modern ? 'Textures' : 'textures'
  refs[textureKey] = refs[textureKey].map(map)
  for (const item of refs[modern ? 'Expressions' : 'expressions'] || []) {
    const key = modern ? 'File' : 'file'
    item[key] = map(item[key])
  }
  for (const motions of Object.values(refs[modern ? 'Motions' : 'motions'] || {}) as any[][]) {
    for (const item of motions) {
      for (const key of modern ? ['File', 'Sound'] : ['file', 'sound']) if (item[key]) item[key] = map(item[key])
    }
  }
}

export function inspectModelFiles(directory: string, model: ModelManifest): string[] {
  const missing: string[] = []
  mapModelReferences(structuredClone(model), reference => {
    try { modelFile(directory, reference) } catch { missing.push(reference) }
    return reference
  })
  return missing
}
