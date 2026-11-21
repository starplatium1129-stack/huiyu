# Independent Anima Inference Worker

Local Diffusers `0.41.0` inference runtime for Anima image generation, img2img, LoRA adaptation, hires refinement, masked editing, and post-processing without importing or starting ComfyUI.

> **Verification boundary:** Host integration, model conversion, and code compilation do not substitute for device acceptance. Refer to [independent-inference.md](../../docs/guides/independent-inference.md) for user setup and [project-status.md](../../docs/project-status.md) for recorded hardware validation.

---

## 1. Environment & CLI Entrypoints

- **Runtime pins:** Python `3.11`, exact direct dependencies in `requirements.txt`, compatible CUDA Torch builds (`2.8.0`/`torchvision 0.23.0` or `2.9.1`/`0.24.1`), `Transformers 5.10.1`, `sentencepiece`, and `protobuf`.
- **Trusted loading:** Components are loaded strictly from local directories via pinned official Diffusers classes. Remote code, quantization configs, custom classes, and implicit downloads are rejected.

### Diagnostic & Execution Commands

```powershell
# Validate local Diffusers model directory layout and imports (no weights loaded)
python tools/inference/worker.py --validate /abs/path/to/modelDir

# Check bundled helpers, dependency pins, and CUDA device availability
python tools/inference/worker.py --diagnose

# Start persistent serial JSONL worker (auto-releases after 600s idle)
python tools/inference/worker.py --serve
```

### Required `modelDir` Layout

- `modular_model_index.json` or `model_index.json` with `_class_name: AnimaModularPipeline`
- `text_encoder/`, `text_conditioner/`, `transformer/`, `vae/`: `config.json` + complete indexed `safetensors` shards (any `missing_keys`, `mismatched_keys`, or `error_msgs` aborts before CUDA upload)
- `tokenizer/`: `tokenizer_config.json`, `vocab.json`, `merges.txt`
- `t5_tokenizer/`: `tokenizer_config.json` + `spiece.model` or `tokenizer.json`
- `scheduler/scheduler_config.json`: `FlowMatchEulerDiscreteScheduler`

---

## 2. Host Lifecycle, Residency & Memory Policies

- **Desktop GPU handoff:** Native GPU jobs stop any managed `llama.cpp` process before claiming VRAM. Entering chat/voice mode reserves all native admission permits before retiring an idle worker. Unconfirmed process retirement blocks further GPU jobs until runtime restart.
- **Asset leases & caching (`resident_anima.py`):**
  - On fixed local NTFS, open read-only handles and directory change notifications guard resident weights and adapters without re-hashing every job. Unsupported paths fall back to full-byte SHA-256 (CNG-accelerated on Windows). No mtime/size-only shortcuts are used.
  - Base switches keep byte-identical unadapted Qwen, VAE, and tokenizers where class/dtype match.
  - `native_upload.py` streams tensors into GPU memory via two reusable 32 MiB pinned staging slabs (≤ 64 MiB active staging).
  - `anima_text_cache.py` caches up to 4 entries / 16 MiB of raw CPU Qwen embeddings and T5 IDs/masks (cleared on base change/unload).
- **Memory & acceleration settings:**
  - `inference.memoryPolicy` / `HUIYU_INFERENCE_MEMORY`: `resident` (default) or `offload` (stage-boundary component offloading via `native_memory.py`, budgeted to free CUDA minus `max(1 GiB, total/4)`). Adapter models separately use `inference.adapterMemoryPolicy` / `HUIYU_NATIVE_ADAPTER_MEMORY` (default `offload`).
  - `inference.acceleration` / `HUIYU_INFERENCE_ACCELERATION`: `native` (default, bundled no-kv-repeat Cosmos attention processor), `sage`, `compiled-sage` (Cosmos attention block compile, SM89), or `compiled-fused-sage` (adds linear LoRA fusion with ≤ 32 MiB source-backed CPU restore buffers).

---

## 3. JSONL Protocol Contract

Write one JSON line per job to `stdin`; read structured JSONL events from `stdout` (`stderr` is diagnostic only).

### Requests

```json
{"id":"job-1","op":"generate","modelDir":"/models/anima-diffusers","outputPath":"/outputs/job-1.png","input":{"prompt":"a landscape","negativePrompt":"","width":1024,"height":1024,"steps":28,"cfg":4,"seed":42,"family":"anima","sampler":"euler","scheduler":"simple"}}
{"id":"job-1","op":"cancel"}
```

- **Trusted host fields:** `inputImagePath`, `maskImagePath`, `maskModelDir`, and `loras` are resolved and authorized by the host at top level (`input.loras` or input-level path aliases are rejected).
- **Cancellation:** Checked at safe stage/step boundaries. Cancelled jobs clean temporary resources and emit `cancelled` then `ready`. Unresponsive workers are retired by the host after a 10-second grace period.

### Events

| Event | Fields | Semantics |
| --- | --- | --- |
| `progress` | `id`, `step`, `total` | Emitted per actual scheduler step |
| `result` | `id`, `outputPath`, `modelReused` | Output atomically written to `outputPath` |
| `cancelled` | `id` | Job aborted cleanly at boundary |
| `error` | `id`, `code`, `message` | Execution or protocol failure (nonzero exit on single-shot) |
| `ready` | `id` | Worker clean and waiting for next job (`--serve` mode) |
| `diagnostic` | dependency/CUDA fields | Emitted once by `--diagnose` |

### Hard Input & Output Limits

- **Device & count:** CUDA required; single image per call (`PNG` output using zlib level 4, retrying level 6 if > 32 MiB).
- **Dimensions:** `64–4096` px, divisible by `16`.
- **Sampling:** `steps` `1–200`, `cfg` `0.5–30`, nonnegative 63-bit `seed`.
- **Finite guards:** VAE inputs, raw decoded latents/pixels, and Remacri raw tiles are verified finite before clamping or PIL conversion.

---

## 4. Sampling, Prompting & LoRA Rules

### Samplers & Schedules (`anima_sampling.py`)

- **Samplers:** `euler` and deterministic second-order `res_multistep` (`eta=0`, no CFG++).
- **Schedulers:** `simple`, `normal`, `sgm_uniform` with static `shift=3` and 1000-entry training table (`stochastic_sampling` is explicitly rejected).
- **Img2Img:** Requires `inputImagePath` (PNG/JPEG/WebP ≤ 4096×4096 px) and `denoisingStrength` in `(0, 1]` (default `0.75`). Computes a full `int(N / strength)` grid and executes its final `N` steps.

### Prompt Weighting (`anima_prompt_weights.py`)

- Supports `(text)` (`1.1×`), nested groups, `(text:weight)`, and escaped parentheses `\( \)`. Square brackets `[]` and `BREAK` remain literal text.
- Unbalanced parentheses, nonfinite weights, or sequences exceeding **512 tokens** fail explicitly instead of truncating.

### LoRAs (`anima_lora.py`)

- Up to **16** entries per job, `strength` in `[-2, 2]`, targeting `transformer` and/or `text_conditioner`.
- Supported layouts: Diffusers/PEFT (`lora_A`/`lora_B`), raw Anima `diffusion_model.*`, and validated linear Anima Kohya (`lora_unet_*.lora_down`/`.lora_up`/`.alpha`). DoRA, convolutional adapters, bias weights, and extra modules are rejected.
- Same-topology LoRA switches attempt packed in-place hotswap; incompatible topology falls back to clean adapter reload.

---

## 5. Hires Refinement, Upscaling & Post-Processing

- **Refinement (`refinement_options`):** Runs a second denoising pass (`seed + 1`) using a fresh scheduler.
- **Upscalers (`anima_upscale.py`):** Supports verified 23-block RRDB weights:
  - `4x_foolhardy_Remacri.safetensors`: 512/32 overlapping tiles (CUDA OOM retries 256/128), CPU FP32 weighted assembly; pixel-only unless masked.
  - `4x-UltraSharp.pth`: preset `1.5×`, `10` refinement steps, `denoise=0.8`, `CFG=5.5`, `Euler / Normal`, `Shift=3`.
- **Sharpening (`anima_postprocess.py`):** FP32 KJ RCAS executed in 128-row bands (default strength `0.75`) before final mask compositing.

---

## 6. Experimental Masked Editing

- **Manual masks:** Host passes `maskImagePath` matching `inputImagePath` orientation/dimensions. Both resize with contain/Lanczos/black padding; the workflow reads the **RGB red channel** with tapered 5-neighbour `growMaskBy` dilation (`masked_anima.py`). Empty masks fail before model load.
- **Automatic masks (CLIPSeg):** Requires a complete local `CIDAS/clipseg-rd64-refined` export at `models_root/clipseg-rd64-refined` (`config.json`, `model.safetensors`, `preprocessor_config.json`, tokenizer files).
  - `maskPrompt`: 1–32 `|`-separated phrases (≤ 4096 chars total, each ≤ 77 CLIP tokens).
  - `maskThreshold`: `[0.05, 0.95]` (default `0.45`); `growMaskBy`: `[0, 32]` (default `8` standalone).
  - Runs on CPU FP32 (`clipseg-single-image-vision-v1`) with AP smooth/grow/feather post-processing; retain `MASK_PROCESSING_LICENSE.txt`.

---

## 7. TeaCache Policy & Offline Conversion

- **Built-in TeaCache (`teacache_anima.py`):** Uses the bundled Apache-2.0 Anima polynomial at threshold `0.10` by default (explicit `false` or `0` disables it). First/last steps compute fully; separate residuals are kept per CFG branch. Retain `TEACACHE_LICENSE.txt`.
- **Calibrated maintenance profiles (`teacache_profile.py`):** Maintenance callers may supply an explicit `teaCacheProfilePath` (≤ 64 KiB) matching `runtime.huiyuInference: "lora-eval-v1"`, exact component/LoRA SHA-256 digests, resolution, sampling/mask revisions, and GPU name. Supports `v1` polynomial, `v2` `phase-envelope`, and maintenance-only `v3` `local-guard`.
- **Strict CPU checkpoint conversion (`scripts/maintenance/convert-anima-checkpoint.py`):**
  - Profiles: `anima-cosmos2b-v041` (28L Base/Aesthetic/MiaoMiao 1.2/1.6), `anima-cosmos29b-v041` (40L MiaoMiao 2.9B), `anima-yume2b-rope-v041` (28L Yume 1.0).
  - Accepts single `net.*` or `model.diffusion_model.*` namespaces; validates all keys/shapes without loading GPU tensors (`--apply` writes). See [independent-inference.md](../../docs/guides/independent-inference.md#经架构核验的离线转换).
