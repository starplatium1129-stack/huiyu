import fs from 'node:fs'
import path from 'node:path'
import { inspectModelFiles, modelFile, modelFormat } from './live2d-manifest'

export interface LocalCompanion {
  character: Record<string, any> & { id: string; personaPrompt: string }
  avatar: Record<string, any> & { modelPath: string }
  profile: Record<string, any>
  manifest: string
  files: string[]
}

export function localLive2dRoot(root: string, runtimeRoot?: string): string {
  return path.join(runtimeRoot || path.join(root, 'runtime'), 'live2d-imports')
}

/** Only completed local imports are discoverable; no candidate archives are served. */
export function readLocalCompanions(root: string): LocalCompanion[] {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(entry.name)) return []
    try {
      const directory = path.join(root, entry.name)
      if (fs.realpathSync(directory) !== path.resolve(directory)) return []
      const data = JSON.parse(fs.readFileSync(modelFile(directory, 'companion.json'), 'utf8')) as LocalCompanion
      if (data.character.id !== entry.name || ['nene', 'natsume'].includes(entry.name)
        || typeof data.character.personaPrompt !== 'string' || !Array.isArray(data.files)) return []
      const model = JSON.parse(fs.readFileSync(modelFile(directory, data.manifest), 'utf8'))
      modelFormat(model)
      if (inspectModelFiles(directory, model).length) return []
      return [data]
    } catch { return [] }
  })
}
