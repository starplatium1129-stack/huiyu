# 疑难留档：hires 放大「奇怪」根因与 Remacri 接入（2026-08-20）

## 现象

用户在绘图页开 hires.fix 后，ComfyUI 放大的动漫图「很奇怪」——线条糊、脸发虚、有块状/噪感。

## 根因

1. **本地 Comfy 链路把 `Auto` / `Latent` 一律解析成「潜空间 nearest-exact 放大」**
   - 位置：`routes/generation.js` `buildWorkflow` 的 hires 分支（原 `graph['11'] = LatentUpscaleBy(upscale_method:'nearest-exact')`）。
   - 纯潜空间放大是低成本的近似插值：对动漫线条/脸这类高频细节，nearest-exact 出块状伪影，二阶段 KSampler 只会在原 latent 上重绘，细节补不回来。
   - 且此前 `E:\code\2\lora\AI\ComfyUI\models\upscale_models\` 目录是**空的**（只有占位文件），所以哪怕选择了 R-ESRGAN 系放大，Comfy 侧也没有模型文件可用，只能落回潜空间。

2. **主流动漫放大是 ESRGAN 像素级真超分 + 低 denoise 二阶段**
   - 2026-08 实测 Civitai「Upscaler」分类下载量：4x-UltraSharp（~25.6万）> Remacri 4x_foolhardy_Remacri（~17.3万）> 4x NMKD Superscale（~7.6万）> R-ESRGAN Anime6B（~4.1万）。
   - 动漫圈最常用 Remacri（线条锐、饱和度高、伪影少）。
   - 链路：低清 → VAEDecode → UpscaleModelLoader(Remacri) → ImageUpscaleWithModel(4x) → ImageScale 到目标尺寸(lanczos) → VAEEncode → 二阶段 KSampler(低 denoise) → VAEDecode。

## 修复

- 下载 `4x_foolhardy_Remacri.safetensors`（63.8MB）→ `E:\code\2\lora\AI\ComfyUI\models\upscale_models\`（源：Civitai model 147759 version 164821）。
- 新增共享探测模块 `routes/superres.js`：`availableSuperRes(config)` 按优先级 `[Remacri, R-ESRGAN 4x+ Anime6B.pth, RealESRGAN_x4plus.pth]` 探测本机文件。
- `routes/generation.js`：
  - `webuiUpscalers` 白名单加 `Remacri`；`SUPER_RES_UPSALERS` 集合。
  - `buildWorkflow`：`input.superResModel` 存在时走 ESRGAN 真超分链路（节点 11-16），否则走原潜空间 nearest-exact（保持显式 `Latent` 选项可回退）。
  - 路由层：`Auto` 在纯 Comfy 侧（WebUI 离线）优先解析为 `Remacri`（有模型时），无模型才回落 Latent；显式 `Remacri`/`R-ESRGAN 4x+` 而本机无模型 → 503 `SUPER_RES_MODEL_UNAVAILABLE`。
  - `status` 能力增加 `Remacri` 项与 `superResModel` 字段。
- 前端 `GenerationOutputControls.vue` upscaler 下拉加 `Remacri`。
- 测试 `scripts/tests/test-generation-routes.js`：新增 super-res 图断言（UpscaleModelLoader→VAEDecode→ImageUpscaleWithModel→ImageScale→VAEEncode→KSampler(16) → 最终 decode 消费 16）、离线 Auto→Remacri 路由断言。全部通过。
- **Anima 引擎同样接入（2026-08-20，用户主打引擎）**：`routes/anima.js` 在 `service.create()` 入队时探测本机 ESRGAN（`input.hiresFix && family!=='krea2'` 则注入 `input.superResModel`）；`buildWorkflow` 新增 `appendSuperResHires` 辅助（noLora/lora 两条 hires 分支共用），`superResModel` 存在时走节点 20–25 的 ESRGAN 像素级链路，否则保持原 `LatentUpscaleBy(bicubic)` 回退；`status().hires.superResModel` 暴露可用性；metadata `hiresUpscaler` 在启用 super-res 时标记为 `Remacri`。Anima 前端（`AnimaQuickPanel.vue`）只暴露倍率/重绘幅度，无需改 UI——默认自动走 Remacri。

## 验证

- `node scripts/tests/test-generation-routes.js` → `ok`。
- 真机：启动 ComfyUI（:8188）用同项目 `routes/generation.js` 的 `buildWorkflow` 各出一张：
  - `runtime/hires-compare/A_latent_2pass.png`（旧潜空间 1248×1824）
  - `runtime/hires-compare/B_remacri_superres.png`（Remacri 真超分 1248×1824）
  - 两图像素统计均正常（非空白），脚本 `scripts/maintenance/compare-hires-superres.js` 可复跑。
- **视觉终审（2026-08-20，image-inspect + gemini-3.7-flash-high）**：`node scripts/maintenance/image-inspect.js A B --mode group -o runtime/hires-compare/group-vision.md` 逐项对比后结论——**B（Remacri）完胜 A（潜空间）**：
  - 线条：A 边缘偏软毛糙，B 锐利紧实；
  - 五官：A 高光泛糊、暗部斑驳，B 眼睛通透清澈、轮廓利落；
  - 噪点：A 暗部有扩散微噪点/色块伪影，B 纯净无斑点；
  - 整体：A 像「未消噪的半成品」、磨砂厚涂感杂质多，B 达商业轻小说插画成品级。
- **Anima 真机对比（2026-08-20）**：`node scripts/maintenance/compare-hires-anima.js`（anima-aesthetic-v1.1, 2×, teaCache off）同 seed 出 `anima-A_latent_bicubic.png` 与 `anima-B_remacri_superres.png`（均 1664×2432），image-inspect group 终审结论「B 显著优于 A」——线稿锐利、五官聚焦、色块纯净、发丝/配饰轮廓结实，无硬伤。Anima 链路 Remacri 生效有据。
- ⚠️ key 修正记录：image-inspect 曾使用一枚已轮换的本地代理占位 key（具体值已从文档移除）；CLIProxyAPI 今日更换了 api-keys（明文见 `E:\code\反代\EasyCLIProxyAPI-*\cpa-core\config.yaml` 的 api-keys 段，此处刻意不抄录）。2026-08-22 安全清理：key 不再硬编码进脚本或文档，改为 `VISION_API_KEY` 环境变量或 gitignored 的 `runtime/vision-api-key.txt` 首行提供。手抄 key 曾因抄错一位导致 401，须以 config.yaml 原文为准。

## 踩坑

- ComfyUI 已有一实例占 8188（用系统 Python 启动，`get-netTCPConnection` 可见 PID），重复 `python main.py` 会报「Port 8188 is already in use」——启动前先探测。
- `ImageScale` 的 `upscale_method` 用 `lanczos`（Comfy 原生支持），缩放目标尺寸须 8 对齐（width*scale 取整到 8 的倍数）。
- 分享给其他协作者：若想要 Anime 引擎路线也接 Remacri，注意 `routes/anima.js` 的 hires 目前仍是 latent bicubic，可复刻 `routes/superres.js` 探测 + 同款超分节点（本次未动，避免超出用户请求范围）。
