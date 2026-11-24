# Native Inference Workers

Native workers for image and video generation, editing, and studio export. The Anima reference below covers the local Diffusers `0.41.0` pipeline, including LoRA, masked editing and refinement.

> **Verification boundary:** Host integration, model conversion, and code compilation do not substitute for device acceptance. Refer to [independent-inference.md](../../docs/guides/independent-inference.md) for user setup and [project-status.md](../../docs/project-status.md) for recorded hardware validation.

---

## Shared Primitives

Check these helpers before introducing another loader, memory owner, worker loop, or metrics format. Import them through the bundled runtime, and keep model-specific precision, preparation and forward passes in the model family.

| Boundary | Files | Responsibility |
| --- | --- | --- |
| Worker and requests | `worker_lifecycle.py`, `adapter_worker.py`, `adapter_contract.py` | Run serial jobs, read cooperative cancellation independently, dispatch local pipelines by model ID, and validate request and asset layouts. |
| Local identity | `native_hash.py`, `locked_identity.py`, `mapped_weights.py` | Hash complete file bytes, lease protected files for reuse, and expose validated read-only safetensors views. |
| Weight ownership and placement | `resident_adapters.py`, `native_memory.py`, `mapped_residency.py`, `native_upload.py` | Reuse compatible weights under a lease, create fresh per-job pipeline state, budget placement, and transfer validated tensors with bounded pinned staging. |
| Execution and media | `native_attention.py`, `adapter_media.py`, `inference_metrics.py` | Scope attention dispatch to the job, bound media encoding, and record timings and allocator observations. |
| Video adapter support | `adapter_video.py`, `video_memory.py`, `video_acceleration.py` | Assemble local video pipelines and apply file-backed placement and attention policies to compatible video models. |

### Reusable acceleration

| Technique | Entry point and reuse boundary |
| --- | --- |
| BF16 vocabulary rows on demand | `native_memory.keep_token_table_on_cpu` keeps a compatible immutable BF16 embedding on the host, looks up the requested token IDs there, and transfers only their rows. Anima requests an independent CPU copy when it can outlive the source lease. Krea and compatible adapter encoders use the same helper. |
| Resident weights and bounded transfers | `resident_adapters.py` and `locked_identity.py` protect reusable weights. `native_memory.py` budgets component, block and leaf placement, while `mapped_residency.py` retains fitting groups and restores other groups from CPU views. `native_upload.py` can batch transfers after the loader validates the weights. |
| Optional attention and INT8 operators | `native_attention.py` scopes Sage or Kitchen dispatch to eligible attention calls. `moss_int8.py` holds the pinned `comfy-kitchen` ConvRot INT8 backend choice and CUDA PyTorch fallback shared by the packed QWEN-Manga loader. Keep each checkpoint's packing, scale and tensor checks in its own adapter. |
| Prefix and denoiser caches | `qwen_prefix_cache.py` places compatible Qwen 2.1 prefix states and limits prefetch. `anima_cache.py` selects the Anima TeaCache policy implemented in `teacache_anima.py`. `moss_adapter.py` wires the task-scoped `moss_spectrum.py` cache into the MOSS pipeline. Reuse their lifecycle pattern and keep cache coefficients, CFG branches and sampling boundaries specific to the model. |

### Model family implementations

| Family or execution path | Files |
| --- | --- |
| Anima entry, local loading and execution | `worker.py`, `anima_dependencies.py`, `anima_device.py`, `anima_loader.py`, `resident_anima.py`, `anima_memory.py`, `anima_execution.py`, `anima_acceleration.py`, `anima_fused.py`, `anima_rocm_fused.py` |
| Anima sampling and conditioning | `anima_sampling.py`, `anima_res_scheduler.py`, `anima_prompt_weights.py`, `anima_text_cache.py`, `anima_lora.py`, `anima_lora_fusion.py`, `anima_cache.py`, `anima_local_cache.py`, `teacache_anima.py` |
| Anima editing, decoding and refinement | `anima_composition.py`, `anima_lllite.py`, `anima_regions.py`, `masked_anima.py`, `clipseg_mask.py`, `anima_vae.py`, `anima_tiling.py`, `anima_refinement.py`, `anima_upscale.py`, `anima_postprocess.py` |
| Krea 2 | `krea_adapter.py`, `krea_style.py`, `krea_transport.py` |
| MOSS | `moss_adapter.py`, `moss_pipeline.py`, `moss_execution.py`, `moss_text.py`, `moss_int8.py`, `moss_preview.py`, `moss_spectrum.py`, `moss_upscale.py` |
| Qwen Image and packed QWEN-Manga | Qwen routes in `adapter_worker.py`, plus `qwen_prefix_cache.py`, `qwen_manga_int8.py`, `qwen_manga_euler.py`, `qwen_manga_vae.py` |
| MangaScreen and optional linework | `manga_worker.py`, `manga_contract.py`, `manga_screen.py`, `manga_models.py`, `manga_cache.py`, `manga_line_model.py` |
| Wan video | `wan_pipeline.py`, `wan_motion.py`, `wan_a14b_sd.py` |
| MiniMax H3 video | `h3_packed.py`, `h3_sparse.py`, `h3_modulation.py`, `h3_rotary.py`, `h3_text.py`, `h3_vae.py` |
| Local keyframe editing | `keyframe_sd.py`, `keyframe_server.py` |
| Portrait animation | `longcat_avatar.py`, `musetalk_native.py`, `musetalk_ink.py` |
| Studio export | `studio_export.py`, `studio_export_media.py`, `studio_export_process.py`, `studio_export_enhance.py`, `studio_export_assets.py` |

### Maintenance tools and manifests

| Scope | Files and use |
| --- | --- |
| CPU import and layout checks | `anima_conversion.py` and `anima_conversion_profile.py` define checkpoint conversion. `import_wan.py` and `import_h3.py` import verified local releases. `worker.py` and `adapter_worker.py` expose `--validate` and `--diagnose` for layout and runtime diagnostics. |
| Cache calibration and benchmarks | `teacache_profile.py` validates an explicit local profile, `teacache_calibration.py` plans or runs calibration, and `resident_benchmark.py` records warm-session measurements. Calibration and benchmarking can load models when invoked explicitly. |
| Explicit asset preparation | `prepare_keyframes.py` prepares the pinned CUDA runner and keyframe assets. `studio_export_assets.py` prepares optional CPU enhancement weights. These are separate from the offline inference path. |
| Execution contracts | `runtime-manifest.json` describes the Anima runtime and observations. `adapter-models.json` defines adapter IDs, supported components and capabilities. `manga-screen.json` defines the MangaScreen contract. |
| Managed runtime and model installation | `managed-runtime.windows-x64.json`, `managed-adapter-runtime.windows-x64.json`, `managed-models.json`, `managed-adapter-models.json`, `managed-auxiliary-models.json`, `managed-image-resources.json` describe pinned runtimes, model bundles and auxiliary assets. |
| Mirrors and model-specific import data | `managed-model-mirrors.json` supplies alternate download sources through Rust. `wan22-import.json` pins the Wan split-weight import recipe and accompanies the adapter worker. |

### Model family directories and desktop packaging

Prefer a dedicated subdirectory under `tools/inference/` for a new independent model family. Keep common request handling, memory ownership and media helpers at the shared layer. Leave existing flat modules in place unless a family migration has a concrete need and can update every consumer together.

Installed desktop workers run from `gateway/tools/inference/`. [Desktop staging](../../scripts/maintenance/desktop-stage-resources.ts) recursively copies eligible directories, but its inference filter currently admits only explicitly allowlisted files immediately under `tools/inference/`. [Rust runtime discovery](../../runtime-rs/src/generation/native/config.rs) expects `worker.py` there. [Adapter selection](../../runtime-rs/src/generation/native/adapters.rs), [MangaScreen](../../runtime-rs/src/images/manga.rs), and [studio export](../../runtime-rs/src/task_runtime/studio_export.rs) use named siblings. The [isolated Python launcher](../../runtime-rs/src/native_python.rs) uses `-I` and removes `PYTHONPATH`. The existing [`load_sibling`](worker_lifecycle.py) resolves identifier-named Python files beside the loader.

For a new family subdirectory, add a narrow relative-path allowlist for its directories, code, runtime manifests, and licenses. Wire its fixed entry or an explicit bundled loader path into the worker and update the Rust file-readiness checks and any sibling lookups. Keep that loader inside the bundled source tree. Verify the installed path and its `--diagnose` entry on the target desktop. Source-tree imports alone leave out the current staging and launcher constraints.

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
| `stage` | `id`, `stage`, optional `component` | Names a host-recognized phase such as dependency setup or sampling |
| `progress` | `id`, `step`, `total` | Reports a bounded counter for the active phase, such as an actual scheduler step |
| `result` | `id`, `outputPath`, optional `modelReused` and `nativeRuntime` | Reports an output published to the host-provided path |
| `cancelled` | `id` | Cooperative cancellation after task cleanup |
| `error` | `id`, `code`, `message` | Fatal execution or protocol failure. Serial workers exit on this path |
| `ready` | `id` | Serial worker is clean after a result or cancellation and can accept the next request |
| `diagnostic`, `validation`, `catalog` | CLI-specific fields, typically `id: null` | Standalone reports from `--diagnose`, `--validate`, or a worker's `--catalog` mode |

Reuse the serial envelope for new inference families. [The Rust reader](../../runtime-rs/src/generation/native/worker.rs) matches the request ID and caps each event line at 144 KiB. Keep ordinary logs on stderr, emit results only after output publication, and release job-owned state before `ready`. The separate Studio export subprocess uses the same `id` and `event` envelope with export-specific progress fields and exits after the terminal event.

Put measured execution data in `result.nativeRuntime` and register fields with [Rust's observation reader](../../runtime-rs/src/generation/native/observations.rs). Use seconds for wall-clock durations, bytes for memory, and finite nonnegative values for timings and counts. Include scope when needed and report unavailable observations as such. In the Anima schema, `timingsAreAdditive: false` marks overlapping intervals, `completedSteps` counts scheduler calls, and `memory.peakAllocatedBytes` and `peakReservedBytes` describe the PyTorch allocator where measurable. Those peaks exclude memory owned outside the allocator. Keep product metrics free of added device synchronization or tensor readback. See [the Anima metrics helper](inference_metrics.py) and [runtime manifest](runtime-manifest.json).

### Anima Input & Output Limits

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
