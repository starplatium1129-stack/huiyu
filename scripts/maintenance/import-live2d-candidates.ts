import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { inspectModelFiles, mapModelReferences, modelFile, modelFormat, type ModelManifest } from '../../services/live2d-manifest'
import { localLive2dRoot } from '../../services/live2d-local'

interface Candidate {
  id: string; name: string; shortName?: string; directory: string; entry?: string; blocked?: string
  author?: string; terms?: string; persona?: string; greeting?: string
  dropExpressions?: string[]; idle?: string[]; tap?: string[]; tapGroup?: string
  layout?: { scale: number; anchorX: number; bottomOffset: number }
  unpackedEntry?: string
  parameterIds?: string[]
  emotionParams?: Record<string, Record<string, number>>
}
const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

function walk(directory: string, prefix = ''): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('Model links are not supported')
    const name = prefix + entry.name
    return entry.isDirectory() ? walk(path.join(directory, entry.name), name + '/') : [name]
  })
}

export function prepareCandidate(root: string, candidate: Candidate) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(candidate.id) || ['nene', 'natsume'].includes(candidate.id)
    || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(candidate.directory)) throw new Error('Invalid candidate identity or directory')
  if (!candidate.entry && !candidate.unpackedEntry) return { id: candidate.id, state: 'blocked', blocked: candidate.blocked }
  const sourceRoot = path.join(root, 'assets/live2d-candidates', candidate.directory)
  if (fs.realpathSync(sourceRoot) !== path.resolve(sourceRoot)) throw new Error('Candidate directory must not be a link')
  if (candidate.unpackedEntry && !candidate.unpackedEntry.startsWith('runtime/live2d-unpacked/')) throw new Error('Invalid unpacked source')
  const source = candidate.unpackedEntry ? modelFile(root, candidate.unpackedEntry) : modelFile(sourceRoot, candidate.entry!)
  const directory = path.dirname(source)
  const model: ModelManifest = json(source)
  const format = modelFormat(model)
  const modern = format === 'cubism3'
  const allFiles = walk(directory)
  const repairs: string[] = []
  const refs = modern ? model.FileReferences : model
  const controllerIds = (name: string): string[] => (model.Controllers?.[name]?.Items || []).map((p: { Id: string }) => p.Id)
  const declaredBlink = model.Groups?.find((group: { Name: string }) => group.Name === 'EyeBlink')?.Ids || controllerIds('EyeBlink')
  if (modern) {
    // ViewerEX controllers are not Cubism expressions or motions. Preserve their
    // explicit blink channel, then keep the runtime manifest free of viewer commands.
    if (model.Controllers) {
      model.Groups ||= []
      if (!model.Groups.some((group: { Name: string }) => group.Name === 'EyeBlink') && declaredBlink.length) model.Groups.push({ Target: 'Parameter', Name: 'EyeBlink', Ids: declaredBlink })
      delete model.Controllers; delete model.Options; delete model.Type; delete refs.PhysicsV2
      repairs.push('Converted ViewerEX manifest to Cubism runtime references')
    }
    refs.Expressions = (refs.Expressions || []).filter((expression: { File: string }) => {
      if (!candidate.dropExpressions?.includes(expression.File)) return true
      if (fs.existsSync(path.join(directory, expression.File))) throw new Error('Declared missing expression now exists; review import recipe')
      repairs.push('Removed absent expression: ' + expression.File)
      return false
    })
    for (const file of allFiles.filter(file => file.endsWith('.exp3.json'))) {
      if (!refs.Expressions.some((entry: { File: string }) => entry.File === file)) {
        refs.Expressions.push({ Name: path.basename(file, '.exp3.json'), File: file })
        repairs.push('Registered expression: ' + file)
      }
    }
    refs.Motions ||= {}
    if (refs.Motions['']) { delete refs.Motions['']; repairs.push('Replaced empty motion group with explicit Idle / Tap') }
    if (candidate.idle) refs.Motions.Idle = candidate.idle.map(File => ({ File }))
    if (candidate.tap) refs.Motions.Tap = candidate.tap.map(File => ({ File }))
  }
  const missing = inspectModelFiles(directory, model)
  if (missing.length) throw new Error(`${candidate.id}: missing dependencies ${missing.join(', ')}`)
  const vtubeFile = allFiles.find(file => file.endsWith('.vtube.json'))
  const vtube = vtubeFile ? json(modelFile(directory, vtubeFile)) : {}
  const parameters: Array<Record<string, any>> = vtube.ParameterSettings || []
  const mouth = parameters.find(p => p.Input === 'MouthOpen')
  const cdi = modern && refs.DisplayInfo ? json(modelFile(directory, refs.DisplayInfo)) : {}
  const ids = new Set<string>([...(cdi.Parameters || []).map((p: { Id: string }) => p.Id), ...(candidate.parameterIds || [])])
  const mouthId = mouth?.OutputLive2D || (modern ? 'ParamMouthOpenY' : 'PARAM_MOUTH_OPEN_Y')
  const blink = modern ? (declaredBlink.length ? declaredBlink : ['ParamEyeLOpen', 'ParamEyeROpen'].filter(id => ids.has(id))) : ['PARAM_EYE_L_OPEN', 'PARAM_EYE_R_OPEN']
  const focus = modern ? ['ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY'].filter(id => ids.has(id)) : ['PARAM_ANGLE_X', 'PARAM_ANGLE_Y', 'PARAM_EYE_BALL_X', 'PARAM_EYE_BALL_Y']
  const id = candidate.id
  const manifest = id + (modern ? '.model3.json' : '.model.json')
  const avatarId = `avatar-${id}-local`
  const profileId = `profile-${id}-local-v1`
  const motions = modern ? refs.Motions : refs.motions
  const tap = candidate.tapGroup && motions?.[candidate.tapGroup]?.length ? candidate.tapGroup : undefined
  const profile = {
    schemaVersion: 1, profileId, profileVersion: '1.0.0', avatarId,
    backendCompatibility: modern ? ['browser', 'native'] : ['browser'],
    parameterBindings: {
      mouth: !modern || ids.has(mouthId) ? { id: mouthId, scale: 1, range: [0, 1] } : undefined,
      blink, focus,
    },
    ...(tap ? {
      interactions: { Head: { group: tap, hint: '回应你的招呼', duration: 6000 } },
      defaultInteractionId: 'Head', stageHitZones: [{ interactionId: 'Head', minY: 0, maxY: 1 }],
    } : {}),
    interactionHint: tap ? '移动鼠标可跟随视线；点击角色可互动' : '移动鼠标可跟随视线',
    emotionParams: Object.assign(Object.fromEntries(Object.entries({
      neutral: {}, happy: { ParamMouthForm: 0.65, ParamEyeLSmile: 0.65, ParamEyeRSmile: 0.65 },
      gentle: { ParamMouthForm: 0.3, ParamEyeLSmile: 0.25, ParamEyeRSmile: 0.25 },
      shy: { ParamMouthForm: 0.15, ParamBrowLY: 0.15, ParamBrowRY: 0.15 },
      sad: { ParamMouthForm: -0.4, ParamBrowLY: -0.3, ParamBrowRY: -0.3 },
      serious: { ParamMouthForm: -0.2, ParamBrowLForm: -0.4, ParamBrowRForm: -0.4 },
    }).map(([emotion, params]) => [emotion, Object.fromEntries(Object.entries(params).filter(([id]) => ids.has(id)))])), candidate.emotionParams || {}),
    verification: { status: 'needs-confirmation', reason: '已核对模型依赖；能力按实际参数映射，设备及音画同步验收分别记录。' },
  }
  const files = new Set<string>()
  mapModelReferences(structuredClone(model), reference => { files.add(reference); return reference })
  const avatar = {
    id: avatarId, characterId: id, name: '本机模型', modelPath: `/api/live2d-local/${id}/${manifest}`,
    version: '1.0.0', profileId, defaultOutfitId: 'default', outfits: [{ id: 'default', label: '原版服装' }],
    expressions: modern ? refs.Expressions.map((e: { Name: string; File: string }) => ({
      id: e.Name, label: e.Name,
      parameterIds: (json(modelFile(directory, e.File)).Parameters || []).map((p: { Id: string }) => p.Id),
    })) : [],
    license: { author: candidate.author, terms: candidate.terms },
  }
  const character = {
    id, name: candidate.name, shortName: candidate.shortName, defaultAvatarId: avatarId, personaPrompt: candidate.persona,
    tags: ['local-import'],
    presentation: {
      id, name: candidate.name, caption: `${candidate.author} · ${candidate.terms}`, description: candidate.greeting,
      image: `/assets/characters/popular-${id}.png`, icon: 'character', greeting: candidate.greeting,
      roomCode: 'LOCAL · LIVE2D', roomMood: '一起聊聊今天的生活与灵感',
      starters: ['今天想和你聊一会儿', '一起想想新的创作灵感吧'], voice: '', accent: 'var(--accent)',
      live2dLayout: candidate.layout || { scale: 1, anchorX: 0.5, bottomOffset: 0 },
    },
  }
  const contents = new Map([...files].map(file => [file, fs.readFileSync(modelFile(directory, file))]))
  contents.set(manifest, Buffer.from(JSON.stringify(model, null, 2) + '\n'))
  contents.set('SOURCE.md', fs.readFileSync(modelFile(sourceRoot, 'SOURCE.md')))
  const receipt = { character, avatar, profile, manifest, files: [...contents.keys()], format, repairs,
    sourceSha256: sha256(fs.readFileSync(source)),
    hashes: Object.fromEntries([...contents].map(([file, bytes]) => [file, sha256(bytes)])),
  }
  return { id, receipt, contents }
}

export function importCandidates(root: string, apply = false, only?: string[], refresh = false) {
  const candidates: Candidate[] = json(path.join(root, 'data/live2d-candidates.json'))
  if (only?.some(id => !candidates.some(candidate => candidate.id === id))) throw new Error('Unknown candidate ID')
  return candidates.filter(c => !only || only.includes(c.id)).map(candidate => {
    const prepared = prepareCandidate(root, candidate)
    if (!prepared.receipt || !prepared.contents) return prepared
    const target = path.join(localLive2dRoot(root), candidate.id)
    let state = 'preview'
    if (apply) {
      let previous: string | undefined
      if (fs.existsSync(target)) {
        const prior = json(modelFile(target, 'companion.json'))
        const matches = JSON.stringify(prior) === JSON.stringify(prepared.receipt)
        if (!matches && !refresh) throw new Error(`Existing import differs: ${candidate.id}; use --refresh to retain and replace it`)
        for (const [file, hash] of Object.entries(prior.hashes)) {
          if (sha256(fs.readFileSync(modelFile(target, file))) !== hash) throw new Error(`Existing import damaged: ${file}`)
        }
        if (matches) state = 'unchanged'
        else previous = path.join(localLive2dRoot(root), `.previous-${candidate.id}-${crypto.randomUUID()}`)
      }
      if (state !== 'unchanged') {
        fs.mkdirSync(localLive2dRoot(root), { recursive: true })
        if (fs.realpathSync(localLive2dRoot(root)) !== path.resolve(localLive2dRoot(root))) throw new Error('Import root must not be a link')
        const staging = fs.mkdtempSync(path.join(localLive2dRoot(root), '.import-'))
        for (const [file, bytes] of prepared.contents) {
          const output = path.join(staging, file)
          fs.mkdirSync(path.dirname(output), { recursive: true })
          fs.writeFileSync(output, bytes, { flag: 'wx' })
          if (sha256(fs.readFileSync(output)) !== sha256(bytes)) throw new Error('Import copy mismatch')
        }
        fs.writeFileSync(path.join(staging, 'companion.json'), JSON.stringify(prepared.receipt, null, 2) + '\n', { flag: 'wx' })
        if (previous) fs.renameSync(target, previous)
        try { fs.renameSync(staging, target) }
        catch (error) { if (previous) fs.renameSync(previous, target); throw error }
        state = previous ? 'refreshed' : 'imported'
      }
    }
    return { id: candidate.id, state, format: prepared.receipt.format, files: prepared.contents.size, repairs: prepared.receipt.repairs }
  })
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const rootAt = args.indexOf('--root')
  const idsAt = args.indexOf('--ids')
  console.log(JSON.stringify(importCandidates(rootAt >= 0 ? path.resolve(args[rootAt + 1]) : path.resolve(__dirname, '../..'), args.includes('--apply'), idsAt >= 0 ? args[idsAt + 1].split(',') : undefined, args.includes('--refresh')), null, 2))
}
