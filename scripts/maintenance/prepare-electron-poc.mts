import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'

// Official 44.4.5 win32-x64 release checksum, verified against Electron's release
// SHASUMS256.txt and npm version metadata on 2026-09-27. No root npm installation.
const version = '44.4.5'
const archiveName = `electron-v${version}-win32-x64.zip`
const expected = '11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d'
const release = `https://github.com/electron/electron/releases/download/v${version}`
const { values } = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('Prepare isolated official Electron 44.4.5 runtime: --out <new runtime directory>; reuses matching local Electron cache, otherwise downloads the pinned official archive.')
  process.exit(0)
}
assert.equal(process.platform, 'win32', 'Electron PoC targets Windows x64')
assert.equal(process.arch, 'x64')
assert.ok(values.out, 'Missing --out')
const out = path.resolve(values.out)
assert.ok(!fs.existsSync(out), '--out must be new')
fs.mkdirSync(out, { recursive: true })
async function sha(file: string) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function official(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  assert.ok(response.ok, `${url}: HTTP ${response.status}`)
  return response
}
const checksums = await (await official(`${release}/SHASUMS256.txt`)).text()
const line = checksums.split('\n').find(entry => entry.endsWith(` *${archiveName}`) || entry.endsWith(`  ${archiveName}`))
assert.equal(line?.slice(0, 64), expected, 'Official checksum differs from the pinned release')
const metadata = await (await official(`https://registry.npmjs.org/electron/${version}`)).json() as { version: string }
assert.equal(metadata.version, version)
fs.writeFileSync(path.join(out, 'SHASUMS256.txt'), checksums)
const cache = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
const candidates = fs.existsSync(cache) ? fs.readdirSync(cache, { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => path.join(cache, entry.name, archiveName)).filter(fs.existsSync) : []
const archive = path.join(out, archiveName)
const cached = candidates.find(file => fs.statSync(file).isFile())
if (cached) fs.copyFileSync(cached, archive)
else {
  const response = await fetch(`${release}/${archiveName}`, { signal: AbortSignal.timeout(600_000) })
  assert.ok(response.ok && response.body, `Official archive HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(archive, { flags: 'wx' }))
}
assert.equal(await sha(archive), expected, 'Electron archive SHA-256 mismatch; not extracting')
const extracted = path.join(out, 'electron')
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:AICS_ELECTRON_ZIP -DestinationPath $env:AICS_ELECTRON_OUT"], {
  windowsHide: true, encoding: 'utf8', timeout: 180_000,
  env: { ...process.env, AICS_ELECTRON_ZIP: archive, AICS_ELECTRON_OUT: extracted },
})
assert.equal(result.status, 0, result.stderr || String(result.error))
const executable = path.join(extracted, 'electron.exe')
assert.ok(fs.existsSync(executable))
assert.equal(fs.readFileSync(path.join(extracted, 'version'), 'utf8').trim().replace(/^v/, ''), version)
const report = { version, verifiedAt: new Date().toISOString(), officialRelease: release,
  officialMetadata: `https://registry.npmjs.org/electron/${version}`, source: cached || `${release}/${archiveName}`,
  archive, archiveBytes: fs.statSync(archive).size, archiveSha256: expected,
  executable, executableSha256: await sha(executable), installed: false, productionProfileAccessed: false }
fs.writeFileSync(path.join(out, 'verified-runtime.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
