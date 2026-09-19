import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors'

/**
 * scripts/maintenance/download-wd14.ts
 *
 * 一键下载本地 WD14 真实反推模型（wd-v1-4-moat-tagger-v2）。
 * 默认使用 hf-mirror.com（国内高速镜像），无需翻墙。
 * 下载完成后放进 runtime/models/interrogate/，自动点亮前端真实反推。
 *
 * 用法：
 *   node scripts/maintenance/download-wd14.js              # 默认从 hf-mirror.com 高速下载
 *   node scripts/maintenance/download-wd14.js --official  # 从 HuggingFace 官方源下载
 */

const fs: typeof import('fs') = require('fs')
const path: typeof import('path') = require('path')
const https: typeof import('https') = require('https')

const USE_OFFICIAL = process.argv.includes('--official')
const HOST = USE_OFFICIAL ? 'huggingface.co' : 'hf-mirror.com'
const REPO = 'SmilingWolf/wd-v1-4-moat-tagger-v2'

const TARGET_DIR = path.resolve(__dirname, '..', '..', 'runtime', 'models', 'interrogate')

const FILES = [
  {
    name: 'wd-v1-4-moat-tagger-v2.csv',
    remotePath: 'selected_tags.csv',
    label: '标签索引表 (CSV)',
  },
  {
    name: 'wd-v1-4-moat-tagger-v2.onnx',
    remotePath: 'model.onnx',
    label: 'ONNX 神经网络权重',
  },
]

function downloadFile(url: string, targetPath: string, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'huiyu-model-downloader' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const redirectUrl = new URL(res.headers.location, url).toString()
        downloadFile(redirectUrl, targetPath, label).then(resolve, reject)
        return
      }

      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} 获取失败: ${url}`))
        return
      }

      const total = Number(res.headers['content-length']) || 0
      let received = 0
      const tmpPath = `${targetPath}.tmp`
      const out = fs.createWriteStream(tmpPath)

      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total > 0) {
          const percent = Math.floor((received / total) * 100)
          const mbRec = (received / 1048576).toFixed(1)
          const mbTot = (total / 1048576).toFixed(1)
          process.stdout.write(`\r  ⬇️ [${percent}%] ${label}: ${mbRec} / ${mbTot} MB`)
        }
      })

      res.pipe(out)

      out.on('finish', () => {
        process.stdout.write('\n')
        out.close(() => {
          if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
          fs.renameSync(tmpPath, targetPath)
          resolve()
        })
      })

      out.on('error', err => {
        res.destroy()
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
        reject(err)
      })
    }).on('error', reject)
  })
}

async function main() {
  console.log(`=== 绘遇 HUIYU · WD14 反推模型一键下载 ===`)
  console.log(`下载源: https://${HOST}/${REPO}`)
  console.log(`目标路径: ${TARGET_DIR}\n`)

  fs.mkdirSync(TARGET_DIR, { recursive: true })

  let failed = 0
  for (const file of FILES) {
    const target = path.join(TARGET_DIR, file.name)
    if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
      console.log(`[已存在] ${file.label}: ${file.name} (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`)
      continue
    }

    const url = `https://${HOST}/${REPO}/resolve/main/${file.remotePath}`
    console.log(`[正在下载] ${file.label}...`)
    try {
      await downloadFile(url, target, file.label)
      console.log(`  ✔ 下载完成: ${file.name}`)
    } catch (e) {
      failed += 1
      console.error(`  ✘ 下载失败: ${runtimeErrorMessage(e)}`)
    }
  }

  console.log('')
  if (failed > 0) {
    console.error(`⚠️ 有 ${failed} 个文件未完成下载。可重新运行本脚本继续。`)
    process.exitCode = 1
  } else {
    console.log(`🎉 恭喜！WD14 本地真实反推模型已就绪！`)
    console.log(`👉 回到绘遇工作台刷新网页，反推按钮旁将点亮绿色的 [WD14 · 真实模型] 徽标！`)
  }
}

void main()
