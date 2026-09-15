import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

// MiniMax H3（ComfyUI 官方量化组合 + lightx2v Turbo LoRA）模型下载脚本。
//
// 目标文件（与 routes/video.js 的 minimax-h3 requirements 一一对应）：
//   diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors   ~21GB
//   text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors          ~15.7GB
//   vae/minimax_h3_video_vae_fp16.safetensors                           ~5.2GB
//   vae/minimax_h3_audio_vae_fp32.safetensors                           ~0.6GB
//   loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors    ~2GB
//     （lightx2v/Minimax-h3-Turbo 官方蒸馏 LoRA，8 步代替原生 20 步）
//
// 用法：
//   node scripts/maintenance/download-minimax-h3.js --modelscope  # ModelScope（国内最快，推荐）
//   node scripts/maintenance/download-minimax-h3.js               # Hugging Face 直连
//   node scripts/maintenance/download-minimax-h3.js --mirror      # hf-mirror.com 加速
//   node scripts/maintenance/download-minimax-h3.js --models-root "D:/ComfyUI/models"
// 已存在且非空的文件自动跳过；中断后重跑会从零继续（不覆盖已完成文件）。

var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');
var https: typeof import('https') = require('https');

var DEFAULT_REPO = 'Comfy-Org/MiniMax-H3';
var MODE_MODELSCOPE = process.argv.includes('--modelscope');
var MODE_MIRROR = process.argv.includes('--mirror');

// [安装目录, 文件名, 仓库（缺省 Comfy-Org/MiniMax-H3）, ModelScope 路径前缀（null = 仓库根目录；缺省 = 安装目录）]
var FILES = [
  ['diffusion_models', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
  ['text_encoders', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
  ['vae', 'minimax_h3_video_vae_fp16.safetensors'],
  ['vae', 'minimax_h3_audio_vae_fp32.safetensors'],
  ['loras', 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 'lightx2v/Minimax-h3-Turbo', null],
];

function modelRoot() {
  var flagIndex = process.argv.indexOf('--models-root');
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return path.resolve(process.argv[flagIndex + 1]);
  }
  // 与 routes/video.js 的 modelRoot 默认一致：<项目根>/../AI/ComfyUI/models
  return path.resolve(__dirname, '..', '..', '..', 'AI', 'ComfyUI', 'models');
}

function fileUrl(file: any) {
  var repo = file[2] || DEFAULT_REPO;
  var fileName = encodeURIComponent(file[1]);
  if (MODE_MODELSCOPE) {
    var scopePath = file[3] === undefined ? file[0] + '/' + fileName : (file[3] === null ? fileName : file[3] + '/' + fileName);
    return 'https://www.modelscope.cn/models/' + repo + '/resolve/master/' + scopePath;
  }
  var host = MODE_MIRROR ? 'hf-mirror.com' : 'huggingface.co';
  return 'https://' + host + '/' + repo + '/resolve/main/' + file[0] + '/' + fileName;
}

function download(url: any, target: any) {
  return new Promise<any>(function (resolve: any, reject: any) {
    https.get(url, { headers:{ 'user-agent': 'aics-downloader' } }, function (response: any) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), target).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('HTTP ' + response.statusCode + ' for ' + url));
        return;
      }
      var total = Number(response.headers['content-length']) || 0;
      var received = 0;
      var out = fs.createWriteStream(target);
      response.on('data', function (chunk: any) {
        received += chunk.length;
        if (total > 0) {
          var percent = Math.floor(received / total * 100);
          process.stdout.write('\r  ' + percent + '% (' + (received / 1048576).toFixed(0) + ' / ' + (total / 1048576).toFixed(0) + ' MB)');
        }
      });
      response.pipe(out);
      out.on('finish', function () {
        process.stdout.write('\n');
        out.close();
        resolve();
      });
      out.on('error', function (error: any) {
        response.destroy();
        reject(error);
      });
    }).on('error', reject);
  });
}

async function run() {
  var root = modelRoot();
  var source = MODE_MODELSCOPE ? 'ModelScope（www.modelscope.cn）' : (MODE_MIRROR ? 'hf-mirror.com' : 'huggingface.co');
  console.log('下载源:', source);
  console.log('目标目录:', root);
  console.log('');
  var failed = 0;
  for (var file of FILES) {
    var dir = path.join(root, file[0]);
    var target = path.join(dir, file[1]);
    fs.mkdirSync(dir, { recursive:true });
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      console.log('[跳过] ' + file[0] + '/' + file[1] + '（已存在）');
      continue;
    }
    var url = fileUrl(file);
    console.log('[下载] ' + file[0] + '/' + file[1]);
    try {
      await download(url, target);
    } catch (error) {
      failed += 1;
      console.error('[失败] ' + file[0] + '/' + file[1] + ': ' + runtimeErrorMessage(error));
    }
  }
  console.log('');
  if (failed) {
    console.error('完成，但有 ' + failed + ' 个文件下载失败；重跑本脚本可继续。');
    process.exitCode = 1;
  } else {
    console.log('全部完成。回到视频页点击「重新检测」即可启用 MiniMax H3。');
  }
}

run().catch(function (error: any) {
  console.error(error);
  process.exitCode = 1;
});
