/** Publisher metadata checked on 2026-09-30; no model weights were downloaded.
 * Revisions and digests describe the app's exact workflow, not each upstream's latest model.
 * Sources: https://huggingface.co/api/models/<repo>?blobs=true (CSV hashed separately).
 */
export interface ModelFile {
  path: string
  repo: string
  revision: string
  remotePath: string
  bytes: number
  sha256: string
  sourceUrl?: string
}

function file(repo: string, revision: string, relative: string, bytes: number, sha256: string, remotePath = relative): ModelFile {
  return { path: relative, repo, revision, remotePath, bytes, sha256 }
}

const WD_REPO = 'SmilingWolf/wd-v1-4-moat-tagger-v2'
const WD_REVISION = '8452cddf280b952281b6e102411c50e981cb2908'
export const WD14_FILES: readonly ModelFile[] = [
  file(WD_REPO, WD_REVISION, 'wd-v1-4-moat-tagger-v2.csv', 253906,
    '8c8750600db36233a1b274ac88bd46289e588b338218c2e4c62bbc9f2b516368', 'selected_tags.csv'),
  file(WD_REPO, WD_REVISION, 'wd-v1-4-moat-tagger-v2.onnx', 326197340,
    'b8cef913be4c9e8d93f9f903e74271416502ce0b4b04df0ff1e2f00df488aa03', 'model.onnx'),
]

const H3_REPO = 'Comfy-Org/MiniMax-H3'
const H3_REVISION = 'e5eb578a89295337b8ff433a035929ce0279e0b6'
export const H3_FILES: readonly ModelFile[] = [
  file(H3_REPO, H3_REVISION, 'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors', 20970379616,
    'e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a'),
  file(H3_REPO, H3_REVISION, 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 15687142551,
    '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6'),
  file(H3_REPO, H3_REVISION, 'vae/minimax_h3_video_vae_fp16.safetensors', 5207808496,
    '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522'),
  file(H3_REPO, H3_REVISION, 'vae/minimax_h3_audio_vae_fp32.safetensors', 605254808,
    '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48'),
  file(H3_REPO, H3_REVISION, 'loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 1956193000,
    '2339acdf19bfe123f46b971ea35d367a84adb85de43627e1eceafa5a5b2b111e'),
  file(H3_REPO, H3_REVISION, 'loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors', 1956192992,
    'c396a9a06f58399e9df9754b18299818d84a2ddd371724ba48fe4a41221437dc'),
]

const ANIMA_REPO = 'circlestone-labs/Anima'
const ANIMA_REVISION = 'f973fc41ec7545364ac9776c2440285f43ff2a30'
export const ANIMA_FILES: readonly ModelFile[] = [
  file(ANIMA_REPO, ANIMA_REVISION, 'diffusion_models/anima-base-v1.0.safetensors', 4182218328,
    'bd43b7cffe1ed1153d9c41e7beb2f18cb1273eafbaa3af3edd6a173dc90a006e', 'split_files/diffusion_models/anima-base-v1.0.safetensors'),
  file(ANIMA_REPO, ANIMA_REVISION, 'diffusion_models/anima-aesthetic-v1.1.safetensors', 4182230656,
    '3c1868387a3a1ff504bbb87c33678321965ead381fcf87afbd0264daa600c082', 'split_files/diffusion_models/anima-aesthetic-v1.1.safetensors'),
  file(ANIMA_REPO, ANIMA_REVISION, 'text_encoders/qwen_3_06b_base.safetensors', 1192135096,
    'cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba', 'split_files/text_encoders/qwen_3_06b_base.safetensors'),
  file(ANIMA_REPO, ANIMA_REVISION, 'vae/qwen_image_vae.safetensors', 253806246,
    'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f', 'split_files/vae/qwen_image_vae.safetensors'),
]

export const KREA_FILES: readonly ModelFile[] = [
  file('Comfy-Org/Krea-2', 'eb1eddd3983a54678545a9b2c178c5853b30f7be', 'diffusion_models/krea2_turbo_fp8_scaled.safetensors', 13141730784,
    'eb4dd8c612cfd10f64f25b057e6e6bbcb5737c94a7372177e456dbf7579502f1'),
  file('DreamFast/Qwen3-VL-4b-Heretic-ComfyUI', 'c5bd34e940564e4b5b64286694d72f47f429c126', 'text_encoders/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors', 4831492476,
    '7443c2b8df026a3271b3095d5d1dc07800dc5cf460b6e3586692253c7a7bc17c', 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors'),
  ANIMA_FILES[3]!,
]

const WAN_REPO = 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged'
const WAN_REVISION = 'ee6f4a40737a995bf5818954cfce6d59443b0f04'
export const WAN_FILES: readonly ModelFile[] = [
  file(WAN_REPO, WAN_REVISION, 'diffusion_models/wan2.2_ti2v_5B_fp16.safetensors', 9999658848,
    '456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e', 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors'),
  file(WAN_REPO, WAN_REVISION, 'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', 6735906897,
    'c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68', 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
  file(WAN_REPO, WAN_REVISION, 'vae/wan2.2_vae.safetensors', 1409400960,
    'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156', 'split_files/vae/wan2.2_vae.safetensors'),
]

// Civitai fixes identity by model-version and file IDs; some downloads require an account.
export const COMMUNITY_ANIMA_FILES: readonly ModelFile[] = [
  { ...file('', '3020110', 'diffusion_models/miaomiaoHarem_anima12.safetensors', 4182218328,
    '127f4ad350dfe011a7cce2f5042d194e4228a4f855cdb774eba1f0cc86ac893e'), sourceUrl: 'https://civitai.com/api/download/models/3020110?fileId=2925299' },
  { ...file('', '3248362', 'diffusion_models/miaomiaoHarem_anima16.safetensors', 4182218328,
    '6bbb6b6785b4eb0df467658ce47f5f52f1d11fe992b1375b3c67ff02becf193b'), sourceUrl: 'https://civitai.com/api/download/models/3248362?fileId=3131298' },
  { ...file('', '3065644', 'diffusion_models/AnimaYume_v10_final_base.safetensors', 4182219230,
    '5d2a1a1f8488cb2ce6f3647859ac4c6ff1f4a81c84d147100898fc3c2847fb88', 'animayume_v10BaseFinal.safetensors'), sourceUrl: 'https://civitai.com/api/download/models/3065644?fileId=2944325' },
  file('Gazingstars123/Anima-2.9B', '9f9cb502dbae7a616c3cc5a530633427fe735665', 'diffusion_models/Anima-2.9B-preview-v1.safetensors', 5843204206,
    '0b3020d1b906155f7eb30667622723e87160632c8c7a5f1c93bdce685f2a346d', 'Anima-2.9B-preview-v1.safetensors'),
]

export const KREA_STYLE_FILES: readonly ModelFile[] = [
  ['darkbrush', 'f47c4316dd93af66e0518c93b582f459571d4925b519133770c73a52cd5db7c6'],
  ['dotmatrix', '805aa30d863347222485b9d3ce81642dbc70a73cebc95ab57219d98b878fceec'],
  ['kidsdrawing', '8c1d45d204aeb4e34a7d9e16a7d473917592ba0048b03f4e03e037e3578ca500'],
  ['neondrip', 'a779c14435949eabae9ce0bface4320cad6672ef3547e8489107e3498d65e871'],
  ['rainywindow', '7063a6f15ec6112ad3c06d79097b2a30a3ea7d9072821cb36021010d55989fe5'],
  ['retroanime', 'ca42107783d9e517c5d62cb9a9db9ab2ba4887d90e9dad97a9d1a7fe6ff14c56'],
  ['softwatercolor', '3805e8655f19fbcac116542685e3f78f3a642e8fbfb857b5352bb32a4b3d445a'],
  ['sunsetblur', '194abdd531ca190d32799f26ab5bab634aa5ba3f07b7a60ffb282657db8bf3a0'],
  ['vintagetarot', '8cca96c56658fb3ac5269f9ef2245bd07cbf1b7a189f517c8763470bb1385f9f'],
].map(([style, sha256]) => file('Comfy-Org/Krea-2', KREA_FILES[0]!.revision, `loras/krea2_${style}.safetensors`, 469291992, sha256!))

export const WAI_FILE: ModelFile = { ...file('', '2883731', 'checkpoints/waiIllustriousSDXL_v170.safetensors', 6938040682,
  'f116b0c78ff441467b0cdc8f1936e1ed18ea31e9997c7b132b1b8db533f0bd04'), sourceUrl: 'https://civitai.com/api/download/models/2883731?fileId=2763986' }

export const COMFY_KNOWN_FILES = [...ANIMA_FILES, ...COMMUNITY_ANIMA_FILES, ...KREA_FILES, ...KREA_STYLE_FILES, ...WAN_FILES, ...H3_FILES, WAI_FILE]
export function officialUrl(entry: ModelFile): string {
  if (entry.sourceUrl) return entry.sourceUrl
  return `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.remotePath}`
}
