import path from 'node:path'
import { WD14_FILES, officialUrl, type ModelFile } from '../lib/model-download-manifest'
import { downloadPlan, runModelDownloads } from '../lib/model-download'
import { errorMessage } from '../lib/runtime-errors'

export function wd14Url(entry: ModelFile, source: 'official' | 'mirror' | 'modelscope'): string {
  if (source === 'mirror') return officialUrl(entry).replace('https://huggingface.co/', 'https://hf-mirror.com/')
  if (source === 'modelscope') return `https://www.modelscope.cn/models/fireicewolf/wd-v1-4-moat-tagger-v2/resolve/master/${entry.remotePath}`
  return officialUrl(entry)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('models:download-wd14 [--target-dir <writable directory>] [--official|--modelscope|--mirror] [--plan]\nDefault: pinned Hugging Face publisher; ~311 MiB ONNX + CSV. --plan prints metadata without network or writes.\nCtrl+C cancels. Bytes and SHA-256 must match before a final file is installed.')
    return
  }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--target-dir') {
      if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw Error('--target-dir requires a path')
      index++
    } else if (!['--official', '--modelscope', '--mirror', '--plan'].includes(args[index]!)) throw Error(`Unknown argument: ${args[index]}`)
  }
  const sources = ['--official', '--modelscope', '--mirror'].filter(flag => args.includes(flag))
  if (sources.length > 1) throw Error('Choose one model source')
  const source = args.includes('--mirror') ? 'mirror' : args.includes('--modelscope') ? 'modelscope' : 'official'
  const index = args.indexOf('--target-dir')
  const root = path.resolve(index >= 0 ? args[index + 1]! : process.env.AICS_WD14_MODEL_DIR || path.join(__dirname, '../../runtime/models/interrogate'))
  const url = (entry: ModelFile) => wd14Url(entry, source)
  if (args.includes('--plan')) { console.log(JSON.stringify(downloadPlan(root, WD14_FILES, url), null, 2)); return }
  console.log(`WD14 source: ${source}; target: ${root}`)
  await runModelDownloads(root, WD14_FILES, url)
  console.log('WD14 文件已通过字节校验。检查 /api/interrogate/status 和一张真实反推；原生 DLL 与设备状态需另验。')
}

if (require.main === module) void main().catch(error => {
  console.error(errorMessage(error)); if (process.exitCode !== 130) process.exitCode = 1
})
