import path from 'node:path'
import { H3_FILES, officialUrl, type ModelFile } from '../lib/model-download-manifest'
import { downloadPlan, runModelDownloads } from '../lib/model-download'
import { errorMessage } from '../lib/runtime-errors'

export function h3Url(entry: ModelFile, source: 'official' | 'mirror' | 'modelscope'): string {
  if (source === 'mirror') return officialUrl(entry).replace('https://huggingface.co/', 'https://hf-mirror.com/')
  if (source === 'modelscope') return `https://www.modelscope.cn/models/${entry.repo}/resolve/master/${entry.remotePath}`
  return officialUrl(entry)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('models:download-h3 --models-root <ComfyUI/models> [--modelscope|--mirror] [--plan]\nSix exact workflow files, ~46.38 GB / 43.20 GiB. Default: pinned Comfy-Org Hugging Face source.\nRequires compatible ComfyUI, PyTorch cu130 and verified nodes/hardware. --plan performs no network/write.\nCtrl+C cancels; only verified bytes become final weights. Interrupted file restarts from zero.')
    return
  }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--models-root') {
      if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw Error('--models-root requires a path')
      index++
    } else if (!['--modelscope', '--mirror', '--plan'].includes(args[index]!)) throw Error(`Unknown argument: ${args[index]}`)
  }
  if (args.includes('--modelscope') && args.includes('--mirror')) throw Error('Choose one model source')
  const index = args.indexOf('--models-root')
  if (index < 0) throw Error('--models-root is required; select the actual ComfyUI/models directory')
  const root = path.resolve(args[index + 1]!)
  const source = args.includes('--mirror') ? 'mirror' : args.includes('--modelscope') ? 'modelscope' : 'official'
  const url = (entry: ModelFile) => h3Url(entry, source)
  if (args.includes('--plan')) { console.log(JSON.stringify(downloadPlan(root, H3_FILES, url), null, 2)); return }
  console.log(`H3 source: ${source}; target: ${root}`)
  await runModelDownloads(root, H3_FILES, url)
  console.log('H3 六个文件已通过字节校验；仍需 /api/video/status、节点与真实设备短片验收。')
}

if (require.main === module) void main().catch(error => {
  console.error(errorMessage(error)); if (process.exitCode !== 130) process.exitCode = 1
})
