/**
 * scripts/maintenance/check-models-environment.ts
 *
 * 绘遇 HUIYU · 模型资产与硬件运行环境一键体检工具。
 * 扫描显卡、显存、内存，以及反推、绘图底模、编码器、VAE 和自训 LoRA。
 *
 * 用法：
 *   node scripts/maintenance/check-models-environment.js
 */

const os: typeof import('os') = require('os')
const fs: typeof import('fs') = require('fs')
const path: typeof import('path') = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')

interface GpuInfo {
  name: string
  vramMb: number
}

function detectGpu(): GpuInfo | null {
  try {
    const stdout = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
    const line = stdout.trim().split('\n')[0]
    if (line) {
      const parts = line.split(',')
      if (parts.length >= 2) {
        return {
          name: parts[0].trim(),
          vramMb: parseInt(parts[1].trim(), 10) || 0,
        }
      }
    }
  } catch {
    // 无 nvidia-smi 或非 NVIDIA 显卡
  }
  return null
}

function candidateComfyDirs(): string[] {
  const dirs: string[] = []
  if (process.env.COMFYUI_MODELS_ROOT) dirs.push(process.env.COMFYUI_MODELS_ROOT)
  if (process.env.AI_WORKSPACE_ROOT) {
    dirs.push(path.join(process.env.AI_WORKSPACE_ROOT, 'ComfyUI', 'models'))
  }
  dirs.push(path.resolve(ROOT, '..', 'AI', 'ComfyUI', 'models'))
  dirs.push(path.resolve(ROOT, '..', 'ComfyUI', 'models'))
  dirs.push('D:\\AI-CG-Studio\\AI\\ComfyUI\\models')
  dirs.push('D:\\ComfyUI\\models')
  dirs.push('C:\\ComfyUI\\models')
  return [...new Set(dirs)].filter(d => fs.existsSync(d))
}

function checkFileExists(dirs: string[], subPath: string): { found: boolean; fullPath?: string; sizeMb?: number } {
  for (const dir of dirs) {
    const full = path.join(dir, subPath)
    if (fs.existsSync(full)) {
      try {
        const stats = fs.statSync(full)
        return { found: true, fullPath: full, sizeMb: Math.round(stats.size / 1048576) }
      } catch {
        return { found: true, fullPath: full }
      }
    }
  }
  return { found: false }
}

function main() {
  console.log('==================================================================')
  console.log('            绘遇 HUIYU · 硬件环境与模型资产全景体检                ')
  console.log('==================================================================\n')

  // 1. 硬件配置与档位评估
  console.log('【1. 硬件配置与推荐档位】')
  const totalMemGb = Math.round(os.totalmem() / (1024 * 1024 * 1024))
  const cpus = os.cpus()
  console.log(`  • 系统内存 (RAM): ${totalMemGb} GB`)
  console.log(`  • 处理器 (CPU)  : ${cpus[0]?.model || '未知'} (${cpus.length} 核心)`)

  const gpu = detectGpu()
  if (gpu) {
    const vramGb = (gpu.vramMb / 1024).toFixed(1)
    console.log(`  • 独立显卡 (GPU): ${gpu.name} (${gpu.vramMb} MB / 约 ${vramGb} GB VRAM)`)
    if (gpu.vramMb >= 16000) {
      console.log(`  ⭐ 当前定位: 【发烧短片档】 - 可完全驾驭 Wan 2.2 / MiniMax H3 视频生成与批量大并发`)
    } else if (gpu.vramMb >= 10000) {
      console.log(`  ⭐ 当前定位: 【黄金推荐档】 - 可完全驾驭 Anima 旗舰画质 + 高清修复 + GPT-SoVITS 原声`)
    } else if (gpu.vramMb >= 6000) {
      console.log(`  ⭐ 当前定位: 【轻量入门档】 - 可运行 SD 1.5 与 Anima 基础分辨率（832x1216）直出`)
    } else {
      console.log(`  ⭐ 当前定位: 【基础档】 - 显存较低，建议使用无 LoRA 轻量模式或连接外部服务器`)
    }
  } else {
    console.log(`  • 独立显卡 (GPU): 未检测到 NVIDIA 显卡或驱动`)
    console.log(`  ⭐ 当前定位: 【纯 CPU / 浏览档】 - 场景浏览、蓝图、故事、WD14 CPU 反推 (0.3s) 完全可用！`)
  }
  console.log('')

  // 2. WD14 本地反推模型检查
  console.log('【2. 本地真实反推引擎 (WD14 Tagger)】')
  const interrogateDir = path.join(ROOT, 'runtime', 'models', 'interrogate')
  const onnxFile = path.join(interrogateDir, 'wd-v1-4-moat-tagger-v2.onnx')
  const csvFile = path.join(interrogateDir, 'wd-v1-4-moat-tagger-v2.csv')
  const onnxReady = fs.existsSync(onnxFile) && fs.statSync(onnxFile).size > 1024
  const csvReady = fs.existsSync(csvFile) && fs.statSync(csvFile).size > 1024

  if (onnxReady && csvReady) {
    const sizeMb = Math.round(fs.statSync(onnxFile).size / 1048576)
    console.log(`  [✔ 已就绪] WD14 真实反推模型 (${sizeMb} MB) @ ${interrogateDir}`)
  } else {
    console.log(`  [✘ 未就绪] 尚未下载 WD14 反推模型 (当前运行在启发式兜底模式)`)
    console.log(`  💡 快捷安装: 在终端运行 npm run workflow -- models:download-wd14`)
  }
  console.log('')

  // 3. ComfyUI 核心开源底模与编码器检查
  console.log('【3. ComfyUI 核心绘图模型 (开源底座)】')
  const comfyDirs = candidateComfyDirs()
  if (!comfyDirs.length) {
    console.log(`  [ℹ 未检测到 ComfyUI 目录]`)
    console.log(`    若您安装了 ComfyUI，可设置环境变量 COMFYUI_MODELS_ROOT 指向其 models/ 文件夹。`)
  } else {
    console.log(`  已找到 ComfyUI models 目录: ${comfyDirs[0]}`)
    // 底模检查
    const miaomiao12 = checkFileExists(comfyDirs, path.join('diffusion_models', 'miaomiaoHarem_anima12.safetensors'))
    const miaomiao16 = checkFileExists(comfyDirs, path.join('diffusion_models', 'miaomiaoHarem_anima16.safetensors'))
    const animaBase = checkFileExists(comfyDirs, path.join('diffusion_models', 'anima-base-v1.0.safetensors'))
    if (miaomiao12.found) {
      console.log(`  [✔ 已就绪] Anima 绘图底模: MiaoMiao v1.2 (${miaomiao12.sizeMb} MB)`)
    } else if (miaomiao16.found) {
      console.log(`  [✔ 已就绪] Anima 绘图底模: MiaoMiao v1.6 (${miaomiao16.sizeMb} MB)`)
    } else if (animaBase.found) {
      console.log(`  [✔ 已就绪] Anima 绘图底模: Anima Base v1.0 (${animaBase.sizeMb} MB)`)
    } else {
      console.log(`  [✘ 缺失] Anima 绘图底模 (需放 diffusion_models/miaomiaoHarem_anima12.safetensors)`)
    }

    // 文本编码器
    const qwenText = checkFileExists(comfyDirs, path.join('text_encoders', 'qwen_3_06b_base.safetensors'))
    if (qwenText.found) {
      console.log(`  [✔ 已就绪] Qwen 文本编码器 (${qwenText.sizeMb} MB)`)
    } else {
      console.log(`  [✘ 缺失] Qwen 文本编码器 (需放 text_encoders/qwen_3_06b_base.safetensors)`)
    }

    // VAE
    const qwenVae = checkFileExists(comfyDirs, path.join('vae', 'qwen_image_vae.safetensors'))
    if (qwenVae.found) {
      console.log(`  [✔ 已就绪] 图像 VAE 编解码器 (${qwenVae.sizeMb} MB)`)
    } else {
      console.log(`  [✘ 缺失] 图像 VAE (需放 vae/qwen_image_vae.safetensors)`)
    }
  }
  console.log('')

  // 4. 看板娘专属自训 LoRA 说明
  console.log('【4. 本站独家自训 LoRA (绫地宁宁 / 四季夏目)】')
  if (comfyDirs.length) {
    const nene = checkFileExists(comfyDirs, path.join('loras', 'ayachi_nene_v21_anima.safetensors'))
    const natsume = checkFileExists(comfyDirs, path.join('loras', 'shiki_natsume_v21_anima.safetensors'))
    if (nene.found && natsume.found) {
      console.log(`  [✔ 已就绪] 宁宁与夏目 v21 自训专属 LoRA 均已就绪`)
    } else {
      console.log(`  [ℹ 独家资产提示] 专属 LoRA 为站长主力机精炼资产，目前未公开。`)
      console.log(`    系统已原生启用【无 LoRA 兼容模式】，且 158 位热门动漫角色无需 LoRA 即可完美出图！`)
    }
  } else {
    console.log(`  [ℹ 独家资产提示] 专属 LoRA 为站长主力机精炼资产。非主力机环境原生支持无 LoRA 创作。`)
  }

  console.log('\n==================================================================')
  console.log('📖 完整配置说明与模型下载直链请阅读: docs/guides/setup-and-models.md')
  console.log('==================================================================')
}

main()
