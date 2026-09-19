import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readLocalCompanions } from '../../services/live2d-local'
import { modelFile } from '../../services/live2d-manifest'

const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

/** Personal deployment only. Creator assets never enter the distributable installer. */
export function syncLocalLive2d(source: string, target: string, apply = false) {
  const sourceRoot = path.resolve(source), targetRoot = path.resolve(target)
  if (targetRoot === sourceRoot || targetRoot.startsWith(sourceRoot + path.sep) || sourceRoot.startsWith(targetRoot + path.sep)) throw new Error('Local model roots overlap')
  const entries = readLocalCompanions(sourceRoot)
  const prepared = entries.map(entry => {
    const directory = path.join(sourceRoot, entry.character.id)
    const receiptBytes = fs.readFileSync(modelFile(directory, 'companion.json'))
    const receipt = JSON.parse(receiptBytes.toString('utf8'))
    const files = new Map<string, Buffer>()
    for (const file of entry.files) {
      const bytes = fs.readFileSync(modelFile(directory, file))
      if (hash(bytes) !== receipt.hashes?.[file]) throw new Error('Local model file changed: ' + file)
      files.set(file, bytes)
    }
    files.set('companion.json', receiptBytes)
    return { id: entry.character.id, files }
  })
  if (!apply) return prepared.map(entry => ({ id: entry.id, state: 'preview' }))
  fs.mkdirSync(targetRoot, { recursive: true })
  if (fs.realpathSync(targetRoot) !== targetRoot) throw new Error('Local model destination must not be a link')
  return prepared.map(entry => {
    const destination = path.join(targetRoot, entry.id)
    if (fs.existsSync(destination) && [...entry.files].every(([file, bytes]) => {
      try { return hash(fs.readFileSync(modelFile(destination, file))) === hash(bytes) } catch { return false }
    })) return { id: entry.id, state: 'unchanged' }
    const staging = fs.mkdtempSync(path.join(targetRoot, '.sync-'))
    for (const [file, bytes] of entry.files) {
      const output = path.join(staging, file)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, bytes, { flag: 'wx' })
      if (hash(fs.readFileSync(output)) !== hash(bytes)) throw new Error('Local model sync mismatch')
    }
    const previous = fs.existsSync(destination) ? path.join(targetRoot, `.previous-${entry.id}-${crypto.randomUUID()}`) : undefined
    if (previous) fs.renameSync(destination, previous)
    try { fs.renameSync(staging, destination) }
    catch (error) { if (previous) fs.renameSync(previous, destination); throw error }
    return { id: entry.id, state: 'synced' }
  })
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const value = (flag: string) => { const at = args.indexOf(flag); if (at < 0 || !args[at + 1]) throw new Error('Missing ' + flag); return args[at + 1] }
  console.log(JSON.stringify(syncLocalLive2d(value('--source'), value('--target'), args.includes('--apply')), null, 2))
}
