import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter, once } from 'node:events'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { downloadModel, matchesModel, runModelDownloads } from '../lib/model-download'
import { H3_FILES, WD14_FILES, type ModelFile } from '../lib/model-download-manifest'
import { h3Url } from '../maintenance/download-minimax-h3'
import { inspectModelFile, checkModels } from '../maintenance/check-models-environment'
import pixaiManifest from '../../tools/interrogate/pixai-manifest.json'

const bytes = Buffer.from('synthetic model fixture, no real weight or inference')
const entry: ModelFile = { path: 'model.bin', repo: 'fixture', revision: 'fixture', remotePath: 'model.bin',
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }

async function fixture(run: (root: string, url: string, requests: string[]) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-model-download-'))
  const requests: string[] = []
  const server = http.createServer((request, response) => {
    const route = request.url || '/'
    requests.push(route)
    if (route === '/redirect') { response.writeHead(302, { location: '/good' }); response.end(); return }
    if (route === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); return }
    if (route === '/stall') { response.writeHead(200, { 'content-length': bytes.length }); response.write(bytes.subarray(0, 1)); return }
    if (route === '/truncated') { response.writeHead(200, { 'content-length': bytes.length }); response.write(bytes.subarray(0, 2)); setImmediate(() => response.destroy()); return }
    const body = route === '/bad-hash' ? Buffer.alloc(bytes.length) : route === '/short' ? bytes.subarray(0, 3) : bytes
    response.writeHead(200, { 'content-length': body.length }); response.end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  try { await run(root, `http://127.0.0.1:${address.port}`, requests) } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('huiyu-model-download-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

test('verified download publishes exact bytes; repeat uses SHA-256 without another request', async () => {
  await fixture(async (root, url, requests) => {
    const target = path.join(root, entry.path)
    assert.equal(await downloadModel(url + '/redirect', target, entry), 'downloaded')
    assert.deepEqual(fs.readFileSync(target), bytes)
    assert.equal(await matchesModel(target, entry), true)
    assert.equal(await downloadModel(url + '/good', target, entry), 'verified-existing')
    assert.deepEqual(requests, ['/redirect', '/good'])
    assert.deepEqual(fs.readdirSync(root), ['model.bin'])
  })
})

test('same-size corrupt or partial final weight is replaced only after a verified download', async () => {
  await fixture(async (root, url) => {
    const target = path.join(root, entry.path)
    fs.writeFileSync(target, Buffer.alloc(bytes.length))
    assert.equal(await matchesModel(target, entry), false)
    await downloadModel(url + '/good', target, entry)
    assert.deepEqual(fs.readFileSync(target), bytes)
    fs.writeFileSync(target, bytes.subarray(0, 2))
    await downloadModel(url + '/good', target, entry)
    assert.deepEqual(fs.readFileSync(target), bytes)
  })
})

for (const route of ['/bad-hash', '/short', '/truncated', '/loop']) {
  test(`failed ${route} response preserves prior file and removes partials`, async () => {
    await fixture(async (root, url) => {
      const target = path.join(root, entry.path)
      fs.writeFileSync(target, 'prior incomplete download')
      await assert.rejects(downloadModel(url + route, target, entry))
      assert.equal(fs.readFileSync(target, 'utf8'), 'prior incomplete download')
      assert.deepEqual(fs.readdirSync(root), ['model.bin'])
    })
  })
}

test('idle timeout and user cancellation release stalled transfers', async () => {
  await fixture(async (root, url) => {
    const target = path.join(root, entry.path)
    await assert.rejects(downloadModel(url + '/stall', target, entry, { timeoutMs: 20, totalTimeoutMs: 1000 }))
    const cancel = new AbortController()
    const transfer = downloadModel(url + '/stall', target, entry, { signal: cancel.signal, onProgress() { cancel.abort() } })
    await assert.rejects(transfer)
    assert.deepEqual(fs.readdirSync(root), [])
  })
})

test('download lock rejects reentry and successful completion removes the lock', async () => {
  await fixture(async (root, url) => {
    const lock = path.join(root, '.huiyu-model-download.lock')
    fs.writeFileSync(lock, '{}')
    await assert.rejects(runModelDownloads(root, [entry], () => url + '/good'), /lock exists/)
    fs.unlinkSync(lock)
    await runModelDownloads(root, [entry], () => url + '/good')
    assert.equal(fs.existsSync(lock), false)
  })
})

test('H3 download manifest covers both runtime sampling LoRAs and the exact six requirements', () => {
  const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../runtime-rs/src/video/catalog.json'), 'utf8')).constants
  const model = catalog.MODEL_CATALOG.find((model: { id: string }) => model.id === 'minimax-h3')
  assert.deepEqual([...H3_FILES.map(file => file.path)].sort(), model.requirements.map((parts: string[]) => parts.join('/')).sort())
  for (const file of [...H3_FILES, ...WD14_FILES]) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    assert.match(file.revision, /^[a-f0-9]{40}$/)
    assert.ok(file.bytes > 0)
  }
  for (const file of H3_FILES.filter(file => file.path.startsWith('loras/'))) {
    assert.match(h3Url(file, 'official'), new RegExp(`/resolve/${file.revision}/loras/`))
    assert.equal(file.repo, 'Comfy-Org/MiniMax-H3')
  }
})

test('model inspection distinguishes empty, partial and same-size corruption', async () => {
  await fixture(async root => {
    const target = path.join(root, entry.path)
    assert.equal((await inspectModelFile(root, entry.path, entry)).state, 'missing')
    fs.writeFileSync(target, '')
    assert.equal((await inspectModelFile(root, entry.path, entry)).state, 'missing')
    fs.writeFileSync(target, 'incomplete')
    assert.equal((await inspectModelFile(root, entry.path, entry)).state, 'size-mismatch')
    fs.writeFileSync(target, Buffer.alloc(bytes.length))
    assert.equal((await inspectModelFile(root, entry.path, entry, true)).state, 'hash-mismatch')
    fs.writeFileSync(target, bytes)
    assert.equal((await inspectModelFile(root, entry.path, entry, true)).state, 'sha256-match')
  })
})

test('offline inventory follows PixAI receipt and override roots without combining model directories', async () => {
  await fixture(async root => {
    const app = path.join(root, 'app')
    const ai = path.join(root, 'custom-ai')
    const scan = path.join(root, 'scan-only')
    const translation = path.join(root, 'translation')
    const source = path.resolve(__dirname, '../..')
    for (const relative of ['runtime-rs/src/images/catalog.json', 'runtime-rs/src/images/endfield-lora.json', 'runtime-rs/src/video/catalog.json',
      'runtime-rs/native-dependencies.windows-x64.json', 'tools/interrogate/pixai-manifest.json']) {
      fs.mkdirSync(path.dirname(path.join(app, relative)), { recursive: true })
      fs.copyFileSync(path.join(source, relative), path.join(app, relative))
    }
    fs.mkdirSync(translation, { recursive: true })
    fs.writeFileSync(path.join(translation, 'config.json'), '{}')
    const runtime = path.join(root, 'runtime')
    const receipt = { schemaVersion: 1, python: path.join(root, 'python.exe'), modelDir: path.join(root, 'selected-model'),
      depsDir: path.join(root, 'deps'), torchSitePackages: path.join(root, 'site-packages') }
    const write = (file: string, content: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
    write(path.join(runtime, 'pixai/runtime-config.json'), JSON.stringify(receipt))
    const otherModel = path.join(ai, 'PixAI/model')
    write(path.join(ai, 'PixAI/runtime-config.json'), JSON.stringify({ ...receipt, modelDir: otherModel }))
    write(path.join(otherModel, 'model.safetensors'), 'model in an unselected directory')
    const preprocessor = pixaiManifest.files.find(file => file.path === 'preprocessor_config.json')!
    write(path.join(receipt.modelDir, preprocessor.path), Buffer.alloc(preprocessor.bytes))
    for (const file of [receipt.python, path.join(app, 'tools/interrogate/pixai_worker.py'),
      path.join(receipt.depsDir, 'timm/__init__.py'), path.join(receipt.torchSitePackages, 'torch/__init__.py')]) write(file, 'must not execute')
    const env = { AI_WORKSPACE_ROOT: ai, COMFYUI_MODELS_ROOT: scan, AICS_TRANSLATION_MODEL: translation,
      AICS_RUNTIME_ROOT: runtime, OLLAMA_MODELS: path.join(root, 'ollama') }
    const reference = { refAudioPath: path.join(root, 'reference.wav'), promptText: 'isolated voice fixture' }
    const gptProfile = { ...reference, gptWeightsPath: path.join(root, 'voice.ckpt'), sovitsWeightsPath: path.join(root, 'voice.pth') }
    const voxProfile = { ...reference, loraWeightsPath: path.join(root, 'voice-lora.safetensors') }
    for (const file of [reference.refAudioPath, gptProfile.gptWeightsPath, gptProfile.sovitsWeightsPath, voxProfile.loraWeightsPath]) write(file, 'no audio or model loading')
    write(path.join(runtime, 'config.json'), JSON.stringify({ voices: { nene: gptProfile } }))
    const report = await checkModels(app, env, false, false)
    assert.equal(report.roots.gatewayPathMatchesScan, false)
    assert.equal(report.roots.runtimeComfyRoot, path.join(ai, 'ComfyUI/models'))
    assert.equal(report.translation.directory, translation)
    assert.equal(report.inference, 'not-run')
    assert.ok(report.imageModels.length >= 7)
    assert.equal(report.videoModels.find(model => model.id === 'wan2.2-14b')?.adapter, 'unavailable')
    assert.ok(report.imageModels.every(model => model.files.every(file => file.state === 'missing')))
    assert.equal(report.pixai.receipt.state, 'loaded')
    assert.equal(report.pixai.paths.modelDir, receipt.modelDir)
    assert.equal(report.pixai.files.find(file => file.path === 'model.safetensors')?.state, 'missing')
    assert.equal(report.pixai.files.find(file => file.path === preprocessor.path)?.state, 'bytes-match')
    assert.equal(report.pixai.python.state, 'file-present')
    assert.equal(report.pixai.dependencies.torch.state, 'file-present')
    assert.equal(report.pixai.dependencies.timm.state, 'file-present')
    assert.equal(report.voiceProfiles[0]?.engine, 'gpt-sovits')
    assert.deepEqual(report.voiceProfiles[0]?.files.map(file => [file.path, file.state]),
      [['reference.wav', 'file-present'], ['voice.ckpt', 'file-present'], ['voice.pth', 'file-present']])
    write(path.join(runtime, 'config.json'), JSON.stringify({ ttsEngine: 'voxcpm2', voices: { nene: voxProfile } }))
    const invalidReceipt = path.join(root, 'invalid-pixai.json')
    write(invalidReceipt, '{invalid')
    const invalid = await checkModels(app, { ...env, AICS_PIXAI_CONFIG: invalidReceipt }, false, false)
    assert.equal(invalid.pixai.receipt.state, 'invalid')
    assert.equal(invalid.pixai.paths.modelDir, path.join(runtime, 'pixai/model'))
    assert.equal(invalid.pixai.python.state, 'missing')
    assert.equal(invalid.voiceProfiles[0]?.engine, 'voxcpm2')
    assert.equal(invalid.voiceProfiles[0]?.referenceTextConfigured, true)
    assert.deepEqual(invalid.voiceProfiles[0]?.files.map(file => [file.path, file.state]),
      [['reference.wav', 'file-present'], ['voice-lora.safetensors', 'file-present']])
    fs.unlinkSync(voxProfile.loraWeightsPath)
    const overridden = await checkModels(app, { ...env, AICS_PIXAI_CONFIG: invalidReceipt, AICS_PIXAI_MODEL_DIR: receipt.modelDir }, true, false)
    assert.equal(overridden.pixai.paths.modelDir, receipt.modelDir)
    assert.equal(overridden.pixai.files.find(file => file.path === preprocessor.path)?.state, 'hash-mismatch')
    assert.equal(overridden.voiceProfiles[0]?.files[1]?.state, 'missing')
  })
})

test('PixAI check reuses its target receipt, honors overrides and leaves plan read-free', async () => {
  await fixture(async root => {
    const entry = path.resolve(__dirname, '../maintenance/prepare-pixai.js')
    const code = fs.readFileSync(entry, 'utf8'), originalRequire = createRequire(entry)
    const receiptPath = path.join(root, 'runtime-config.json')
    const saved = { schemaVersion: 1, python: path.join(root, 'saved-python.exe'), torchSitePackages: path.join(root, 'saved-torch') }
    const calls: Array<[string, string | undefined]> = []
    const noSideEffects = () => { throw Error('check/plan must not download, install or write') }
    const run = (args: string[], env: NodeJS.ProcessEnv = {}, allowReads = true) => {
      const io = Object.create(fs)
      for (const name of ['existsSync', 'readFileSync'] as const) io[name] = (...values: unknown[]) => {
        assert.ok(allowReads, 'plan must not inspect the selected target')
        return Reflect.apply(fs[name], fs, values)
      }
      for (const name of ['writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync']) io[name] = noSideEffects
      const module = { exports: {} }
      return vm.runInNewContext(code + '\nmain();', {
        module, exports: module.exports, __dirname: path.dirname(entry),
        process: { ...process, argv: ['node', entry, '--target-dir', root, ...args], env }, console: { log() {} },
        require: (name: string) => name === 'node:fs' ? io : name === '../lib/model-download' ? {
          ...originalRequire(name), matchesModel: async () => true, runModelDownloads: noSideEffects,
        } : name === '../lib/pixai-prepare' ? {
          ...originalRequire(name), adoptCandidate: noSideEffects, installTimm: noSideEffects,
          resolvePython: async (python: string, site?: string) => {
            calls.push([python, site]); return { python, pythonVersion: '3.11.0', torchSitePackages: site || path.join(root, 'discovered-torch') }
          },
          checkPython: async () => ({ simulated: true }),
        } : originalRequire(name),
      }) as Promise<void>
    }
    const initial = JSON.stringify(saved)
    fs.writeFileSync(receiptPath, initial)
    await run(['--check'])
    assert.deepEqual(calls.at(-1), [saved.python, saved.torchSitePackages])
    const env = { AICS_PIXAI_PYTHON: path.join(root, 'env-python.exe'), AICS_PIXAI_TORCH_SITE_PACKAGES: path.join(root, 'env-torch') }
    await run(['--check'], env)
    assert.deepEqual(calls.at(-1), [env.AICS_PIXAI_PYTHON, env.AICS_PIXAI_TORCH_SITE_PACKAGES])
    const cliPython = path.join(root, 'cli-python.exe'), cliSite = path.join(root, 'cli-torch')
    await run(['--check', '--python', cliPython, '--torch-site-packages', cliSite], env)
    assert.deepEqual(calls.at(-1), [cliPython, cliSite])
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), initial, 'check never rewrites the prepared configuration')
    fs.writeFileSync(receiptPath, JSON.stringify({ ...saved, python: 'relative-python.exe' }))
    await assert.rejects(run(['--check']), /Invalid PixAI saved configuration/)
    assert.equal(calls.length, 3, 'invalid saved paths fail before Python execution')
    await run(['--plan'], {}, false)
    assert.equal(calls.length, 3, 'plan never resolves Python')
    fs.unlinkSync(receiptPath)
    await run(['--check'], { AI_WORKSPACE_ROOT: root })
    assert.deepEqual(calls.at(-1), [path.join(root, 'ComfyUI/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), undefined])
  })
})

test('PixAI Python stopping waits for termination, rejects late success and cleans its handlers', async () => {
  const entry = path.resolve(__dirname, '../lib/pixai-prepare.js')
  const code = fs.readFileSync(entry, 'utf8'), originalRequire = createRequire(entry)
  for (const cause of ['SIGINT', 'SIGTERM', 'timeout', 'overflow'] as const) {
    const fakeProcess = Object.assign(new EventEmitter(), { env: {}, exitCode: undefined as number | undefined })
    let kills = 0, cleared = 0, settled = false
    let expire: () => void = () => { throw Error('expected the Python deadline to be registered') }
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill() { kills++; return true } })
    const module = { exports: {} as typeof import('../lib/pixai-prepare') }
    vm.runInNewContext(code, { module, exports: module.exports, process: fakeProcess,
      require: (name: string) => name === 'node:child_process' ? { spawn: () => child } : originalRequire(name),
      setTimeout: (callback: () => void, milliseconds: number) => {
        assert.equal(milliseconds, 30_000); expire = callback; return 'fixture-deadline'
      },
      clearTimeout: (timer: unknown) => { assert.equal(timer, 'fixture-deadline'); cleared++ },
    })
    const result = module.exports.pythonJson('must-not-execute-python', 'fixture-only').then(
      () => { settled = true; return { error: undefined } },
      (error: Error) => { settled = true; return { error } },
    )
    child.stdout.emit('data', Buffer.from('{"fixture":true}'))
    if (cause === 'timeout') expire()
    else if (cause === 'overflow') child.stdout.emit('data', Buffer.alloc(64 * 1024, 'x'))
    else fakeProcess.emit(cause)
    // A later deadline/signal cannot replace the first stopping reason.
    if (cause === 'SIGINT' || cause === 'SIGTERM') expire()
    else fakeProcess.emit('SIGINT')
    child.stdout.emit('data', { toString() { throw Error('stopped Python output must not accumulate') } })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, false, `${cause}: wait for child termination before releasing ownership`)
    assert.equal(kills, 1, `${cause}: stop the owned child once`)
    if (cause === 'SIGTERM') child.emit('error', Error('late child error'))
    else child.emit('close', 0)
    const completed = await result
    assert.ok(completed.error, `${cause}: terminated work must not report success`)
    assert.match(completed.error.message, cause === 'timeout' ? /timed out after 30 seconds/
      : cause === 'overflow' ? /exceeds 64 KiB/ : /cancelled/)
    assert.equal(fakeProcess.exitCode, cause === 'SIGINT' || cause === 'SIGTERM' ? 130 : undefined)
    assert.equal(cleared, 1)
    assert.equal(fakeProcess.listenerCount('SIGINT'), 0)
    assert.equal(fakeProcess.listenerCount('SIGTERM'), 0)
  }
})
