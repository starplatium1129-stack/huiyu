# Independent Anima inference worker

The product uses local Diffusers 0.41.0 Anima components without importing or
starting ComfyUI. Existing compatible runtime receipts, converted models and
LoRAs are discovered by the host; explicit settings remain authoritative.

Ordinary TeaCache now uses the bundled Apache-2.0 Anima polynomial and policy
from CocyNoric/ComfyUI-Anima-TeaCache@e7a7382, threshold 0.10 by default.
Explicit false or threshold 0 disables it. Model/LoRA/resolution/hires changes
need no calibration files; old files cannot silently disable the built-in cache.
The Diffusers wrapper keeps separate CFG residuals, resets between passes,
computes first/last steps fully and retains finite-result checks. Retain
TEACACHE_LICENSE.txt. Explicit profile paths and calibration Python APIs remain
maintenance options with exact scope checks, not everyday prerequisites.

The serial JSONL v3 worker accepts {"id":"active-id","op":"cancel"} while
loading or sampling. It checks cancellation at safe stage/step boundaries,
cleans temporary resources and emits cancelled then ready; completed jobs emit
result then ready. Only a confirmed ready worker is reused. The host retires
unresponsive workers after a 10-second cancellation grace period, and retires
all execution/protocol faults and timeouts. Stage events identify dependency
preparation, fingerprinting, component loading/upload, encoding, decoding,
upscaling and saving; no artificial loading percentage is reported.

See the [inference guide](../../docs/guides/independent-inference.md)
for current capabilities and limits. The authorized 2026-10-13 local acceptance
completed 36 product-API images and 5 cancellations, plus installed-desktop
cancel/recovery and user acceptance. On RTX 4070 Ti SUPER, MiaoMiao 1.6 /
Nene 0.8 / 832x1216 / 24 steps / CFG 4, native warm median was 5.05 seconds
versus ComfyUI 5.54 seconds. These bounded samples do not validate every model,
shape, prompt or device. The worker completes dependency initialization before
the request reader blocks again; completed jobs release idle allocator reserves
while retaining model weights. API wall time includes result-to-ready cleanup.

## Native desktop handoff and finite output boundaries

The control room now uses the active image engine for drawing mode. Native checks
only its dedicated Python/worker files and loads on the first generation; selecting
drawing mode retains an existing idle resident. File presence is not CUDA/model
acceptance. Each actual native GPU job stops the application's owned llama.cpp
before taking model memory.

Chat/voice mode and llama.cpp startup reserve every native admission permit before
retiring an idle worker, retaining the reservation through startup/health checking.
Prepared, queued, running or settling image jobs refuse the handoff without being
cancelled. Unconfirmed owned-process retirement blocks further GPU use until the
runtime restarts; queued native jobs receive an explicit failure instead of hanging.

VAE inputs and raw decoded tensors are checked before display clamping/PIL
conversion on every decode, including ordinary no-RCAS generation and both
hires passes. The latent-only first pass is checked before upscaling. Remacri checks
its raw tiles before clamping, accumulating a device flag and reading it
after assembly. V3 updates sampling, pixel conversion and compositing to the
workflow math described below. These checks add finite scans and boundary synchronization;
GPU overhead, finite-image PNG equivalence and real control-room handoff have not
been measured in this revision.

## 2026-10-12 Comfy workflow alignment

The current sampling revision is `anima-workflow-effects-v3`. Euler/simple now
uses the training-table grid, both passes draw FP32 noise with CPU generators,
and ordinary img2img preserves N actual updates using the tail of a full
`int(N/denoise)` schedule. CFG below one is accepted down to 0.5. These change
results and cost; all previous Tea profiles are incompatible with this revision.
Explicit local profiles require current matching acceptance; everyday built-in caching does not read them;
explicit Tea enablement rejects an unmatched profile. Previous GPU timings and
image acceptance apply only to their recorded source, not these changes.

Select `inference.memoryPolicy=offload` in local engine settings, or explicitly
override with `HUIYU_INFERENCE_MEMORY=offload`. The default `resident` keeps warm
throughput. Offload uses pinned Diffusers ComponentsManager hooks on all four
weight components: Qwen, conditioner, denoiser and VAE switch at actual forwards,
and the denoiser stays on CUDA for its loop. Remacri first retires Anima weights.
Fused LoRAs merge one component at a time on CUDA before returning to CPU.
This is whole-component offload: denoiser weights plus active tensors must still
fit GPU. It adds host RAM and transfers; arbitrary 4/8 GB devices are not proven.

Resident packed storage is now per component/dtype. A base switch retains only
byte-identical unadapted Qwen, VAE and tokenizers, after exact class/dtype checks.
The raw text cache survives only if Qwen and both tokenizers really survive.
Adapted transformer/conditioner always reload on a base change. First acquisition
still hashes all bytes and loads the necessary weights; this is not a measured
improvement of a completely cold first job.

Hires releases first-pass outputs and retired inputs before the next stage,
clears Tea residuals before VAE decode, keeps final nonmasked Remacri resize on
CPU. VAE now executes a whole frame before a bounded CUDA-OOM-only feathered
fallback, without single-frame video feature caches. Exact Qwen CausalConv
single-frame/no-cache predicates select the last temporal weight slice with
implicit spatial padding; RMS uses original-dtype normalization. FP32 mean/std,
raw-latent bicubic and display boundaries follow the workflow. Remacri uses
512/32 overlapping tiles, CPU FP32 weighted assembly and CUDA OOM 256/128 retry.
Both Lanczos and PNG use RGB uint8 truncation. Task metadata records actual VAE
mode and VAE/Remacri tile count/size/output device, plus postprocess wall time
and the RCAS execution revision when sharpening actually ran.
The desktop allowlist includes new helpers and the AP mask license notice.

Source review and compilation do not establish output or performance parity.
The requested mask/RCAS/Remacri/VAE mathematical paths are now implemented:
contain/pad/red channel, tapered manual growth, masked model input/denoised
history, mean-logit automatic smoothing/square growth/float feather, and the
fixed KJ RCAS functional variant. FP32 accumulation order, device kernels and
batching still prevent a source-only pixel-equivalence claim. The current host
has AMD 880M and no usable NVIDIA CUDA. No model calls, tests, installs or
deployment were performed.

## Explicit preparation

Use a dedicated Python 3.11 environment and the eleven exact direct pins in `requirements.txt`. Installation must be initiated by the user/preparation workflow; generation never installs anything. Torch and torchvision must use compatible builds (local `+cu...` suffixes are accepted). Cosmos uses torchvision resize during its first actual forward, so import-only Diffusers checks are insufficient: diagnosis now imports that operation explicitly. Transformers 5.10.1 retains Qwen2Tokenizer and T5TokenizerFast; SentencePiece assets require sentencepiece and protobuf. The pinned Windows CUDA 12.8 environment was installed offline and real MiaoMiao 1.6 generation was exercised on an RTX 4070 Ti SUPER on 2026-10-11; this does not establish compatibility with every model or device.

Place a complete local Anima Diffusers export in `modelDir`:

- `modular_model_index.json` or `model_index.json` with `_class_name: AnimaModularPipeline`
- `text_encoder/`, `text_conditioner/`, `transformer/`, `vae/`: `config.json` and safetensors weights, with all indexed shards present
- `tokenizer/`: `tokenizer_config.json`, `vocab.json`, `merges.txt`
- `t5_tokenizer/`: `tokenizer_config.json`, `spiece.model` (SentencePiece) or `tokenizer.json` (fast-tokenizer serialization)
- `scheduler/scheduler_config.json`: `FlowMatchEulerDiscreteScheduler`

## Optional measured Windows acceleration

`HUIYU_INFERENCE_ACCELERATION=compiled-sage` selects the measured SM89 candidate;
`sage` provides the eager-kernel control, and `native` remains the default.
Native now also installs the existing bundled Cosmos processor when the exact
stock processor type matches. It omits `repeat_interleave(1)` K/V copies while
keeping native attention dispatch and the original projection, normalization,
rotary and non-unit repetition operations. K/V storage layout changes; current
CUDA timing, peak memory and image consistency have not been measured. Native
Tea scopes use `cosmos-v3-native-no-kv-repeat-v1`: old native profiles fall back
to full computation in auto mode and are rejected in strict mode. Sage modes
retain their existing execution revisions. No optional dependency is needed
for this native path.
The host now persists `inference.acceleration` in its local settings and passes
the selected mode to both the worker and dependency diagnosis. Existing settings
without this field resolve to `native`; the environment variable remains an
explicit override. A desktop installation can therefore select the measured
mode once without depending on a temporary shell environment. Native MiaoMiao
1.6 defaults use 24 steps/CFG 4 and Nene/Natsume strength 0.8; subsequent explicit
user edits and restored recipes remain authoritative.
The exact optional wheel versions, provenance and SHA256 values are recorded in
`runtime-manifest.json`. After verifying those local wheels, install them into
the dedicated environment using `python -m pip install --no-index --no-deps`
with their exact local paths. Never copy ABI extensions from ComfyUI or upgrade
Torch implicitly. The first compiled request and new shapes/adapter settings can
take longer; repeated hot tasks are a separate performance population. More
than Torch's default recompilation budget can fall back to eager execution.

The `compiled-sage` candidate wraps only Cosmos attention and compiles the original block
forwards before TeaCache wraps them. It keeps PEFT's real projection modules and
active scales; no adapter or base-weight fusion is used. Execution mode and the
pinned candidate revision are part of calibration identity, so older Tea files
must be recalibrated. CUDA graphs and VAE compilation were rejected during
device experiments and are not enabled.

`compiled-fused-sage` additionally fuses supported standard Linear LoRAs for
resident inference. Base-preserving adapters with a live source lease now restore
the touched weights from their verified safetensors offsets through `readinto`,
using at most 32 MiB of reusable CPU read/conversion buffers. This replaces the
previous roughly 3.28 GiB CPU snapshots for either measured character v21 adapter
on that protected path; it is not a cap on OS file caching or total process RAM.
Callers without valid source protection retain exact CPU snapshots. Strength/group
changes restore original values before changing PEFT state; unloading restores
the unadapted base. The lease is checked around source reads and copies; failure
discards the resident. BF16 delta subtraction is never used for restoration.
Same-dtype CUDA source groups larger than 16 MiB now use two reusable slots of
at most 16 MiB each when every tensor row fits a slot. CPU reads overlap the
preceding asynchronous copy on the target's current stream; an Event gates
each slot's reuse. Exact CUDA-device grouping preserves stream ownership.
Success and exceptions drain that stream before CPU buffers and the pinned
allocator cache are released, including a failure after copy enqueue but before
Event recording. CPU, dtype conversion, small groups and oversized rows retain
serial restoration. The 32 MiB bound still covers active read/conversion tensor
payload only. Halving a large chunk can increase copy/lease-check counts; actual
switch latency and restoration correctness remain device acceptance items.
Fusion changes floating-point evaluation order and requires separate Tea calibration
and visual acceptance. Original model/LoRA files stay unchanged.
The 2026-10-11 device observations cover the accepted Nene/Natsume v21 strength-0.8 scopes, the 12 matched hot API
jobs per backend, and slower native cold/adapter-switch warmups for that revision.
These numbers do not measure the newer loading, hotswap, scheduling or hires changes
below, or establish mathematical equivalence or arbitrary LoRA/shape coverage.

On direct fixed local NTFS, resident identity checks hold read-only file handles and
deny writes/deletes while the weights are resident. File IDs and persistent
directory name/attribute notifications guard reuse, including temporary changes
that disappear before the next request. Directory handles still allow atomic
child-file saves; data files remain protected. Loading keeps its lease and
rejects any intervening membership/attribute event, even if a rehashed digest
happens to match. Stop/restart the worker or allow its 600-second idle release
before replacing a selected model/LoRA file. Unsupported filesystems, reparse
paths or unavailable sharing protection use complete SHA256 each time; Windows
CNG accelerates that full-byte operation without changing the digest. No mtime
or size-only cache is used.

With the same exact base path and ordered adapter paths, valid continuous leases
now return detached SHA identities without recursive inventories or reopening
file, directory and notification handles. Current strengths still enter each
identity. Drive-letter mappings and latched notifications are checked before and
after reuse. SUBST/UNC aliases, case-distinct path collisions and unsupported
protection fall back to full-byte hashing. Mapping checks are boundary snapshots,
not protection against privileged transient remapping. This revision has source
review and syntax compilation only; device timing and invalidation remain unverified.

Base and adapter identities have independent leases. Switching LoRAs retains a
valid base lease and hashes newly selected adapter bytes; changed base members or
attributes still invalidate reuse. Source restoration checks that same uninterrupted
base protection. On the first resident request, dependency imports run concurrently
with full identity hashing. Directory notifications remain on the long-lived caller
thread that owns their lifecycle, and failure joins the import task before releasing resources. This overlaps
real cold-request work without moving it outside the request timer.

The worker explicitly loads trusted package component classes from these local folders; index references to other repositories or custom classes are never followed. Quantization/custom-code configs are rejected. Missing assets fail with a preparation error; they are never fetched automatically. Raw model conversion requires the correct architecture config and separately available encoder, VAE and tokenizer assets; renaming a checkpoint or placing it beside these folders is insufficient.

During actual weight loading, each of the four model components requests the pinned upstream final loading report and rejects nonempty `missing_keys`, `mismatched_keys` or `error_msgs` before that component's CUDA transfer. No pipeline is published until all components and adapters are ready. This prevents Qwen's warning-only initialization of missing required parameters. Upstream tied/ignored-key rules remain authoritative, and unexpected-only entries retain upstream warning behavior, including an unused `lm_head.weight` in a compatible Qwen CausalLM export. The report is not independent certification of shard-index contents or model quality; layout-only diagnostics below still do not load weights.

Resident loading now uploads each checked component before loading the next CPU
component. `native_upload.py` retains per-component/dtype GPU flats and the same
Parameter/Buffer objects, shapes, dtypes and values. It coalesces tensor byte spans
and 256-byte alignment gaps through two reusable pinned slabs, at most 32 MiB
each, on one copy stream. CPU filling overlaps the preceding DMA; Events prevent
overwriting an in-flight slab. The stream drains, including on failure, before
publishing views. Active staging is at most 64 MiB; PyTorch may retain freed pinned
buffers in its host allocator cache. Small uploads or a staging allocation failure
use the earlier direct-copy path; unsupported layouts use `component.to` before
mutation. Actual CUDA allocation/copy/Event/publication errors propagate. Offload
keeps CPU components until their ordinary forward hooks; its transfer algorithm
is unchanged. This changes neither the recipe nor Tea calibration identity.
`nativeRuntime.loading` reports fresh component read/upload wall times and actual
strategy, tensor/transfer bytes, copy calls and active staging bytes. Warm base
reuse reports no prior loading record. First-request hashing, OS file cache and
GPU inference still have their original costs. There is no current CUDA timing
or image evidence for this loading revision.

LoRA fusion keeps packed views attached when PEFT replaces weight storage.
Historical evidence below belongs to the earlier direct-copy path. The four-job diagnostic
sequence preserved all four PNGs byte-for-byte, removed the extra approximately
3.28 GiB complete CPU base snapshots on the protected source path, and used at
most 32 MiB temporary read/conversion buffers. Observed working set fell from
about 5.63 to 1.80 GiB. Private bytes include GPU-driver-related accounting and
are not physical RAM. `runtime/backend-cost-20261011/startup-comparison.json`
records these separate diagnostic samples, not the final product API comparison.

`python tools/inference/worker.py --validate /absolute/model/directory` checks local layout and dependency versions/imports without loading weights or generating. A successful check is not GPU/model acceptance.

`python tools/inference/worker.py --diagnose` checks both bundled mask helpers and pinned dependency versions/imports and reports CUDA availability/device name without a model path, loading weights, allocating tensors or generating. It emits a single `diagnostic` JSONL event, or an `error` event with a nonzero exit for dependency failures. CUDA availability alone does not establish model fit or generation readiness.

## Strict offline checkpoint conversion

`scripts/maintenance/convert-anima-checkpoint.py` supports three explicit profiles:
`anima-cosmos2b-v041` for the 28-layer Base 1.0, Aesthetic 1.1 and MiaoMiao 1.2/1.6;
`anima-cosmos29b-v041` for the 40-layer MiaoMiao 2.9B Beta 1.1;
and `anima-yume2b-rope-v041` for 28-layer Yume 1.0. All six local models have now
undergone real strict CPU conversion. This is conversion evidence, not six-model
GPU, LoRA or image-quality acceptance.

The converter accepts one complete `net.*` or `model.diffusion_model.*` namespace,
rejecting mixed prefixes and collisions. Yume requires its observed `net.*` form.
Every learned key and shape is checked; unknown tensors are not discarded.
Yume alone permits three exact derived RoPE buffers after their names, BF16 shapes
and formula-derived bits match. Its `--check` reads those 598 bytes with `pread`,
records their original hashes and regenerates only those confirmed constants;
other profiles' checks remain header/meta-schema/tokenizer checks. Default plan
mode reads no tensor payload. Only `--apply` reads and converts complete CPU weights.

All profiles use the checked six-layer conditioner, Qwen3-0.6B, Qwen Image VAE and
tokenizer assets. The original encoder/VAE/tokenizer inputs used for MiaoMiao 1.6
can be reused after the same strict checks. The 40-layer model requires its explicit
profile/config; it is never relabeled as 28 layers. Unknown shapes, quantization and
custom code remain rejected. See the [offline conversion guide](../../docs/guides/independent-inference.md#经架构核验的离线转换)
for the CLI and publication boundary. A converted report still says
`readyForInference: false` until independent device acceptance; no automatic
download or source-weight modification occurs.

## JSONL contract

Start one process per job; write one newline-terminated JSON object to stdin:

```json
{"id":"job-1","op":"generate","modelDir":"/models/anima-diffusers","outputPath":"/outputs/job-1.png","input":{"prompt":"a landscape","negativePrompt":"","width":1024,"height":1024,"steps":28,"cfg":4,"seed":42,"family":"anima","sampler":"euler","scheduler":"simple"}}
```

Stdout contains only `{id,event:"progress",step,total}`, `{id,event:"result",outputPath,modelReused}` or `{id,event:"error",code,message}` objects. With `--serve`, a successful job ends with `{id,event:"ready"}` and the worker waits for the next serial job. Diagnostic output goes to stderr. Progress follows actual scheduler updates; model loading/text encoding can take time before the first update. Output is atomically renamed after PNG encoding. A nonzero exit means failure. The host owns cancellation/timeout by terminating its worker, and releases a worker after 600 seconds of continuous idle time; reuse cancels the previous timer and completion starts a fresh one.

PNG output uses lossless compression level 4, with a level-6 retry if the encoded file exceeds the existing 32 MiB host limit. This changes file bytes and encoding cost, not decoded pixels; compression gains depend on image content. Atomic replacement preserves an existing destination on encoding failure. Result metrics include `outputSaveSeconds` and `outputBytes`. CPU fixtures are not evidence of generation speed.

`resident_anima.py` retains one exact base model and one adapter group. Every job checks content identity, using the protected NTFS lease described above when available; acquiring or invalidating a lease and unsupported paths require full-byte SHA256. Every base/adapter load is checked again before inference. Cold base and CLIPSeg loads revalidate supported configuration at the actual load boundary. The full-hash fallback is not an atomic filesystem snapshot: finish preparing model assets before generation. Changed base bytes reload the base.

Changed ordinary LoRA groups restore fusion first, then try in-place hotswap only
when both components' adapter names, complete target keys, shapes, ranks, ordinary
PEFT configurations and destination dtypes agree. Every source is checked before
mutation. An inapplicable group uses the existing unload/reload path for both
transformer and text conditioner; a partial hotswap failure discards the resident
rather than retrying on modified weights. An empty group restores the unadapted
base. Strength-only changes update active scales, including zero and negative values,
with prior restoration in fused mode. Base-modifying initializers and unverified
variants retain conservative whole-base reload behavior.

After the complete hotswap preflight, each adapter's normalized tensors now use
the existing packed uploader grouped by their actual destination device. CPU
targets stay on the original path. A temporary registered-buffer module owns
only that adapter during upload; original Diffusers/PEFT hotswap still performs
the swap or compiled copy and the complete loaded-key check. Unsupported upload
layouts keep PEFT tensor.to; real CUDA failures propagate and discard the
resident. Consumed state dictionaries and preflight aliases are released so the
old weights exchanged back by PEFT do not accumulate across adapters. This can
temporarily add about one adapter of GPU storage, plus alignment, and at most
64 MiB active pinned upload staging; it is not a low-VRAM guarantee. Initial
LoRA loading retains its metadata, initializer and dtype/device conversion path.

Fresh `nativeRuntime.loraLoading` distinguishes ordinary load from hotswap,
records adapter count, total CPU wall time and hotswap upload strategy/counters
per adapter/device for completed packed uploads. CPU targets and unsupported
upload layouts emit no per-device upload entry; their original PEFT transfer
is included only in the enclosing LoRA wall interval.
`nativeRuntime.fusionRestore` records restore wall time, completed source bytes,
source copy calls, pipelined/serial source groups and peak read/conversion buffer
payload. Its `snapshotBytes` is the retained independent CPU snapshot payload;
copy/group counters exclude snapshot copies. Unchanged jobs emit no old records.
These timings overlap model acquisition and are not additive. No synchronization
is added just for timing, and byte-preserving loading changes do not alter Tea
scope. Current speed, memory and image acceptance are unverified.

`modelReused` reports base reuse, including supported adapter-group switches.
Fresh pipeline blocks, scheduler, CFG guider and TeaCache controller wrap the weights
for each job. Seed, steps and editing state are not retained. The bounded CPU text
cache stores only raw Qwen embeddings and T5 ids/masks. Cancellation, timeout,
protocol failure and shutdown retire the owned process before another GPU task.

`anima_sampling.new_scheduler(sampler, original_config)` creates a fresh official
Euler or independent deterministic `res_multistep` scheduler for each pass, preserving
the base checkpoint config. `sampling_options(sampler, scheduler_name, steps, scheduler)`
provides the shared options dispatch. Both modules load their exact bundled sibling
by file path, including under the worker's `python -I`; no `sys.path` or `PYTHONPATH`
change is required. CFG is configured on `ClassifierFreeGuidance`, not passed as an
ignored modular-pipeline call parameter.

`normal` and `sgm_uniform` require static shift=3, training table=1000 and no other
sigma transformation. With S(t)=3t/(1+2t), normal spans [1, S(float32(1/1000))]
in N FP32 points; sgm_uniform uses N equal intervals and excludes the last endpoint.
The official scheduler applies the shift once and appends zero. Complete 24/30-step
CPU sigma vectors historically matched the isolated Comfy reference bitwise.
Both Euler/simple and RES/simple now explicitly subsample the 1000-entry
training grid. Current-revision runtime validation has not been performed.

RES independently integrates a linear extrapolation of denoised output in log-sigma
time, following the mathematical method in [Zhang, Song & Chen §3.5/D.1](https://arxiv.org/abs/2308.02157).
Flow velocity is converted as D=x−σv. State/history stay FP32; the first available
and terminal-zero steps use Euler. Its mathematical order is two but its Diffusers
API `order=1` denotes one model evaluation per update. `set_timesteps` and
`set_begin_index` reset history, including img2img starts; completion releases it.
Only eta=0, no CFG++ and strictly decreasing positive sigmas followed by zero are
supported. Ancestral/per-token variants, dynamic shifting and duplicate sigmas are
rejected; a simple full grid longer than 1000 entries is outside this adapter.
CPU small-ODE, vector, BF16-output and isolated-load checks are not proof of matching
transformer/CFG arithmetic, noise or final pixels. No Euler, UniPC or DPM++ substitution
is presented as RES equivalence. A changed sampler/scheduler needs its own accepted
TeaCache scope.

The local scheduler must not enable `stochastic_sampling`: pinned Anima's after-denoiser does not forward the job generator to the scheduler's optional random-update branch. Such a configuration is explicitly rejected before runtime loading instead of silently disabling it or using global RNG. The upstream default and the project converter use the supported non-stochastic path; their sampling behavior is unchanged. This does not promise bitwise deterministic CUDA kernels or cross-backend noise equality.

Limits: Anima requires CUDA; one image; initial dimensions divisible by 16, 64–4096; worker steps 1–200 and CFG 0.5–30, while the public host applies narrower product ranges; nonnegative 63-bit seed; PNG output. Default resident holds all weight components on GPU; explicit offload moves whole components at stage boundaries. Neither offers CPU inference or an arbitrary low-VRAM guarantee. Optional CLIPSeg runs on CPU in float32. Ordinary TeaCache uses the bundled Anima strategy without profile files. Only explicitly selected maintenance profiles retain exact scopes and strict acceptance. Other super-resolution weights and non-Anima families remain unsupported.

Earlier RCAS and Latent/fixed Remacri revisions have historical GPU evidence.
`anima_postprocess.py` independently implements the product's KJ functional
RCAS parameters in FP32; strength=0 preserves input, the workflow uses 0.75.
Execution `rcas-fp32-rows128-v1` keeps the five-point expression and RGB lobe
reduction in 128-row bands, using real neighbouring rows at interior seams and
reflect padding only at image borders. FP16/BF16 conversion occurs per band;
the original and final images remain complete tensors. More kernel launches
and the output-band copy trade against full-image scratch, so this establishes
bounded intermediate size, not a measured speedup. Mask compositing reuses its
private converted reference and new result with separate multiply/subtract/add
operations; PIL-to-FP32 normalization divides its private NumPy array in place.
No caller input is overwritten, and Lanczos/uint8 boundaries are unchanged.
Current output, latency and peak-memory evidence still needs device acceptance.
`anima_upscale.py` accepts only the fixed local
`4x_foolhardy_Remacri.safetensors` with the checked 23-block RRDB architecture,
using Apache-2.0 BasicSR components and separately licensed supplied weights.
The current Remacri execution is `remacri-no-single-cat-packed-v1`: each dense
block sends its input directly to conv1 instead of concatenating one tensor.
All convolutions, FP32 arithmetic, residuals and 512/32 tiling remain. After
complete key/shape/dtype/finite checks, the 702 parameters use the existing
bounded packed uploader on CUDA; unsupported layouts retain module.to and CUDA
errors propagate. The upscaler lives only for this pass, with no new resident
weight cache. Existing profile SHA checks still surround loading.
`nativeRuntime.refinement.upscale` records the execution revision and fresh
`loading.readWallSeconds`, `loading.uploadWallSeconds`, and upload strategy,
payload/transfer bytes, copy calls and staging bytes. Timings are CPU wall spans,
not extra synchronized GPU measurements; pinned staging is at most 64 MiB and
does not bound allocator cache or total process RAM. RGB quantization for
Lanczos/PNG uses 128-row scratch, retaining FP32 multiply, clip and uint8
truncation without two full-size float temporaries. These changes have source
and compilation review only; current speed, peak memory and images need device
acceptance.
The trusted host resolves Auto to Latent or an available fixed Remacri file at
`models_root/upscale_models/4x_foolhardy_Remacri.safetensors`; an explicit missing
Remacri selection fails. Latent always refines; unmasked Remacri is pixel-only,
while masked Remacri also refines. RCAS follows the existing workflow conditions
and runs before the final mask composite, without a new public strength control.
The refinement pass uses a fresh scheduler and seed+1 independent noise. Shared
`refinement_options` takes the requested-step tail of the full grid and supplies
`strength=1.0`, avoiding a second strength slice. Latent 2x, manual-mask Latent 2x,
Remacri 2x and automatic-mask Remacri 2x produced 1664x2432 images; measured black
mask pixels exactly matched the resized original. The required RoPE capacity of
152 exceeded the initial 128 and is now extended for the operation, then restored.
Observed warm allocator peaks were about 9.33 GiB; cold first-image null readings
mean unavailable, not zero or total-device VRAM. Final API costs and broader
quality/cancellation coverage remain separate; earlier API timings do not cover
these combinations.

`anima_prompt_weights.py` supports positive/negative `(text)` weighting (inherited
weight times 1.1), nested groups, explicit `(text:number)` and escaped parentheses.
Square brackets and `BREAK` remain literal text in this Anima contract. Qwen uses
the fragment token IDs; T5 weights scale the conditioner output, with unit EOS
and padding weights. Fourteen real-tokenizer comparisons matched the inspected
Comfy Anima Qwen/T5 IDs and weighting rules; eight focused tests passed. An actual
weighted GPU image succeeded, and the plain-prompt PNG SHA256 matched the prior
implementation. Unbalanced parentheses, invalid/nonfinite weights and input over
512 tokens fail explicitly instead of truncating. This does not establish seeded
pixel equivalence across backends. Weighted requests use their own TeaCache scope.

## Image-to-image and LoRA

The host resolves uploads and catalog LoRAs into approved absolute local paths. These are trusted top-level worker fields, never accepted as raw paths from a remote generation request:

```json
{"id":"job-2","op":"generate","modelDir":"/models/anima-diffusers","outputPath":"/outputs/job-2.png","inputImagePath":"/inputs/upload.png","loras":[{"path":"/models/loras/style.safetensors","strength":0.6}],"input":{"prompt":"a landscape","steps":28,"denoisingStrength":0.75}}
```

- `inputImagePath` is optional/null for txt2img, otherwise an existing PNG/JPEG/WebP still image of at most 4096×4096 pixels in area. The worker decodes locally, applies EXIF orientation, and converts to RGB. The upstream image processor resizes to requested output dimensions. It does not fetch URLs.
- `input.denoisingStrength` defaults to 0.75 for direct worker img2img and must be greater than zero and at most one. Without an input image, specifying strength is an error. Image input activates VAE encoding. Native computes a full `int(N/strength)` schedule and passes its last N positive sigmas with strength=1 to avoid slicing twice; progress counts N actual updates, matching the Comfy KSampler tail convention. Product defaults are resolved by the host before the worker call.
- `loras` defaults to an empty array, with at most 16 entries, each containing only `path` and `strength` (−2 through 2). Each adapter gets a distinct name and the requested scale. Either or both `transformer` and `text_conditioner` component prefixes are supported.
- Native Diffusers/PEFT `component.target.lora_A.weight` and matching `lora_B.weight` safetensors are supported, plus the exact raw Anima `diffusion_model.*` A/B layout recognized by Diffusers 0.41.0. The official Anima converter maps transformer blocks/projections and `diffusion_model.llm_adapter.*` into `text_conditioner.*`; header keys are preflighted through that same helper before the local-file loader maps the real tensors. Colliding targets are rejected. The local Anima Kohya export layout `lora_unet_<original_module>.lora_down.weight` / `.lora_up.weight` / `.alpha` is also supported for checked linear targets. `anima_lora.py` enumerates original Anima transformer names through the pinned official converter and exact `llm_adapter` conditioner module names; it rejects ambiguous flattened names, missing triples, unknown targets, incompatible matrix shapes and nonfinite values. Down/up must be CPU F16/BF16/F32 matrices and alpha a finite nonnegative scalar (or one-element vector). It folds alpha/rank into float32 B before the ordinary PEFT loader, retaining both components and the user-selected adapter strength. It does not write or modify source files. Mixed layouts, generic Kohya families, convolutional adapters, DoRA and PEFT metadata overrides accompanying alpha triples remain unsupported. Checkpoint keys, target modules, component-prefixed adapter metadata and the actual loaded adapter key set are checked, so unsupported or partially loaded weights cannot silently disappear. Supported metadata, including alpha/rank values, is preserved by the upstream file loader. Adapter configuration JSON must contain only finite numbers, including nested alpha patterns; NaN, Infinity and numeric overflow are rejected before loading. DoRA, bias weights, saved extra modules and advanced unsupported adapter variants are rejected. Informational file metadata is not used to execute code.
- Input-level path aliases and active `input.loras` remain rejected: the host must resolve authorized files and send the trusted top-level contract. The worker is a host-owned serial child process, not a public file-access boundary; the host owns canonical containment checks and access policy.

## Current verification policy

Repository instructions prohibit writing or running tests. Review affected
source and diffs, then use necessary type checks, syntax compilation and product
builds. Historical CPU fixtures and GPU reports do not validate this revision.
Real CUDA generation, visual quality, peak VRAM and cancellation under GPU load
require separately recorded device acceptance within the user's authorization.

## Experimental manual masked editing

The host sends trusted maskImagePath alongside inputImagePath. Input and oriented mask dimensions must match. Both share contain/Lanczos/center-black resize; the workflow reads the resized RGB red channel, not alpha multiplied by luminance. Repeated five-neighbour maxima implement growMaskBy's tapered diamond. Empty masks fail before Anima loads.

Manual preparation resizes only the 8-bit band equivalent to RGB R. With
straight RGBA and red-only masking, pinned Pillow 11.3.0's RGBA-to-RGB conversion
only copies RGB and drops alpha, so the helper takes the same R directly and
avoids a full RGB temporary. RGB is borrowed read-only; palette, grayscale,
CMYK, premultiplied RGBa and other modes retain the original RGB conversion.
Ordinary image resizing still converts non-RGB inputs. Pinned Pillow applies
the same per-band Lanczos coefficients, rounding and clipping for RGB and L.
The helper skips same-size intermediate copies and returns an independent new
canvas without inherited EXIF/info. EXIF normalization, checks, contain geometry,
black padding, FP32 division and downstream mask processing are retained.
Historical stage timings, complete actual CPU preparation and fresh-process
high-water RSS observations apply only to their source snapshots. Process maxRSS includes
startup/imports and does not establish production residency, model or VRAM peaks.
No behavior tests or pixel comparisons were run; image/EXIF behavior still needs
device acceptance. Manual v3/Tea identity is retained on pinned source reasoning.

The manual mask owns its decoded ImageFile inside `with`; EXIF transpose now
runs in place there and the source is released before image resize/Torch growth.
Non-RGB input images also transpose their owned decoder in place, then retain
the original final RGB conversion and independent result. RGB input handling,
including the necessary post-transpose EXIF normalization copy, is unchanged.
This removes transient whole-image copies without adding a cache or sharing
pixels across jobs. The same report records real repository image loader and
mask-PIL-prefix CPU observations; EXIF/image behavior still needs device acceptance.

Manual growth now reads each round from edge padding and writes the ordered
five-neighbour maxima into its independent FP32 resized output. It no longer
constructs a five-image stack or allocates a new output per round. At 4096² the
removed stack is 320 MiB per round (10 GiB of cumulative stack construction at
grow=32), a source-derived allocation count rather than measured RSS or speed.
Soft masks and the manual v3/Tea identity remain unchanged; this revision has
syntax and source review only.

The bundled masked_anima.py replaces prepare/before/after denoiser leaves. Effective float masks are trilinear at single-frame latent resolution and nearest-exact for hires. With clean latent z, original noise epsilon, state x and white-edit mask m, model input is m*x+(1-m)*((1-sigma)*z+sigma*epsilon). Predicted denoised is blended with clean z before the scheduler integrates original x; RES therefore retains masked denoised history. Final pixel composite uses the same unquantized effective mask.

The integration uses the public Apache-2.0 Diffusers block/scheduler APIs, with independently implemented workflow mathematics. No Comfy runtime or GPL code is copied. Source agreement does not establish CUDA mask boundaries, clothing quality or PNG equality; all current v3 device behavior remains unverified.


## Experimental local automatic masks

Prepare a separately licensed, complete local `CIDAS/clipseg-rd64-refined` export at the host's configured `models_root/clipseg-rd64-refined`. The worker requires these nonempty files inside that directory:

- `config.json`: `model_type: clipseg`, `reduce_dim: 64`, `use_complex_transposed_convolution: true`
- `model.safetensors`: one complete, matching rd64-refined checkpoint
- `preprocessor_config.json`: 352×352 bilinear resize, rescale by 1/255, and the checkpoint's three finite channel means/positive standard deviations. Omitted normalization/rescale fields use official `ViTImageProcessorPil` defaults (mean/std 0.5 per channel, rescale 1/255); preserve the matching export's explicit values rather than substituting another checkpoint's normalization
- `tokenizer_config.json`, `special_tokens_map.json`, `vocab.json`, `merges.txt`

If present, `processor_config.json.image_processor` takes precedence over `preprocessor_config.json`, matching the pinned official loader; only a missing or null nested value falls back. The selected settings must satisfy the same 352×352/bilinear/normalization contract. Scalar `size: 352` requires truthy `default_to_square` (omitted means true); explicit height/width 352 is also supported. RGB PIL input requires omitted/null or `channels_last` input format.

A raw original CLIPSeg `.pth`, pickle `.bin`, renamed file, partial export or missing tokenizer is insufficient. The worker does not convert weights, accept remote model code or download missing assets. File availability is only readiness to try loading; it does not verify weights, license, installation, hardware fit or mask quality. The original CIDAS model card/license could not be fetched during this implementation review. Review that checkpoint's actual license and provenance separately before use or redistribution; nothing here grants rights to its weights.

The trusted host sends top-level `maskModelDir` plus `inputImagePath`, with `input.maskPrompt`, optional `input.maskThreshold` (finite 0.05–0.95, default 0.45), and `input.growMaskBy` (integer 0–32, standalone worker default 8; host-normalized values take precedence). Automatic and uploaded manual masks are mutually exclusive. `maskModelDir` and `maskThreshold` require an automatic-mask request.

`maskPrompt` is a `|`-separated list of 1–32 nonempty phrases, at most 4096 characters total. Empty parts are discarded; phrase order and duplicates are preserved in the mean. Each phrase must fit the 77-token CLIP context; overlong phrases fail rather than being silently truncated. Existing clothing synonyms are processed as separate queries, never one long caption.

The oriented RGB source uses the same contain/Lanczos/center-black geometry as manual editing. Explicit local CLIPTokenizer, ViTImageProcessorPil and CLIPSegForImageSegmentation preserve the existing dependency pins. `clipseg-single-image-vision-v1` encodes one query image, selects the pinned forward's `hidden_states[extract_layer+1]`, then expands these read-only activations for each decoder batch of four phrases. The vision tower no longer evaluates the same image once per phrase. Text conditioning and ordered mean logits retain their original batching and weighting.

The CPU cache retains one model, one mean-logit map, at most 64 KiB conditioning and one owned selected-layer snapshot capped at 16 MiB. Complete model asset bytes are hashed every job and rechecked after loading. Image mode/size/pixel SHA-256 plus execution revision govern vision reuse across prompt edits; ordered stripped phrases additionally govern logits reuse. Threshold/growth/feather are applied every job. Only successful masks update snapshots; failures and worker retirement clear them. Oversized activations still generate masks but are not retained. These are retained tensor payload limits, not a total-process RAM guarantee.

Per-phrase 352x352 FP32 logits are averaged with duplicate phrases preserved, then Torch bilinear resized. AP postprocessing applies three 5x5 reflect box smooths, sigmoid >= threshold, square maximum growth, then three 25x25 reflect box blurs. Uniform boxes use separable horizontal/vertical convolutions to reduce full-image work; the mathematical filter matches, FP32 accumulation may differ. Float masks go directly to sampling/compositing without uint8 or a second growth pass. Retain MASK_PROCESSING_LICENSE.txt; real boundary quality and complete model-mask CPU cost are unverified.

Square growth uses row and column prefix presence on the thresholded CPU FP32
0/1 mask. Counts are exact integers bounded by each axis length; accumulator and
output use the same sufficiently wide dtype. Clipped signed coordinates preserve
the original Cartesian square window, including boundaries. The result owns FP32
storage with the current threshold mask's canonical layout before the unchanged
feather convolution. This private binary selector is not used for fractional
manual masks. Smooth/feather convolutions, parameters, execution revision and cache
scope are unchanged. Fixed Torch 2.8.0+cpu normal postprocessing observations,
including the full helper and the preceding two-axis implementation, are recorded
in the existing backend HTML report, including separate Linux Python 3.11/3.12
timing, explicit 1536²/grow6 process-RSS, and separate 1024²/grow8 CPU
observations (the standalone worker defaults) with Python 3.11 process high water. Real CLIPSeg outputs,
Windows, model/cache residency, GPU speed and VRAM still need device acceptance.

Earlier evidence includes CPU CLIPSeg segmentation and a GPU automatic-mask Remacri 2x result, tied to their recorded older source. It does not validate `clipseg-single-image-vision-v1`: changing the vision batch shape can change FP32 results near threshold boundaries. This revision has source/API and compilation review plus neutral-logit CPU postprocessing timing observations, with no tests or model calls. Actual masks, complete model-mask CPU cost and cache RAM need device acceptance. Raw historical evidence remains under ignored `runtime/`.


## Experimental calibrated TeaCache

This section describes explicit maintenance profiles only. Ordinary product jobs use the built-in policy described above. No calibration or comparison commands may run while repository instructions prohibit tests.

Profiles, collection traces and held-out reports must record `runtime.huiyuInference: "lora-eval-v1"` for post-injection LoRA evaluation mode; all older artifacts are rejected and require fresh collection/calibration and acceptance, including scopes without LoRAs, while installed files are never automatically rewritten.

The public API uses the bundled strategy with threshold 0.10 unless disabled.
The trusted host no longer resolves local profile paths. A standalone worker or
maintenance caller can explicitly pass teaCacheProfilePath; that selection must
match an accepted exact profile and is never silently replaced by the built-in
policy. The file remains nonempty, at most 64 KiB and contained by the selected
model directory. Explicit calibrated thresholds remain 0.01..maxThreshold.
Product nativeRuntime.teaCache reports actual enabled state, builtin-anima /
threshold-zero / request-disabled reason, algorithm, threshold and full/skip
counters; file presence no longer masquerades as acceleration readiness.

The bundled `teacache_anima.py` retains the original Diffusers 0.41.0 transformer forward. Per-call instance wrappers measure the first block's time-modulated norm1 output, including its extra positional embedding. Full computation stores the last block output minus the raw first block input. When the fitted, accumulated relative-L1 estimate is below the accepted threshold, the first wrapper adds that residual once and all remaining wrappers bypass their actual attention/feed-forward forwards. Current positional preparation, timestep conditioning, output normalization and projection still run. This really skips the expensive stack; it does not merely change a UI flag or lower the requested sampling steps.

- Every job has its own controller, created after selecting its exact model/LoRA scope. CFG conditional/unconditional calls have separate lanes and residuals.
- Each lane must follow consecutive indices and strictly decreasing finite timesteps. Shape, dtype, device, total count, exact conditioning and padding changes invalidate reuse. Tensor snapshots avoid relying on inference tensor version counters.
- The first and last actual timesteps always compute fully, including strength-sliced img2img. At most the locally calibrated 1–3 consecutive steps can be reused. Nonfinite proxies/residuals/statistics and out-of-calibration proxy values force full computation.
- Txt2img, img2img and masked editing share the cache denoiser. V3 masked input/denoised constraints and the final float pixel composite remain active during cached inference; cache reuse never replaces the mask algorithm.
- All temporary instance forwards and scheduler progress wrappers are restored in `finally`; no class monkey-patch or model-global cache survives a job. Normal progress and atomic PNG output remain. Host process termination still owns cancellation.

`teacache_profile.py` validates the version-1 polynomial, version-2 phase envelope and maintenance-only version-3 `huiyu-anima-local-guard-v1`; product profile selection excludes version 3. Runtime pins are Diffusers 0.41.0 and Torch 2.8.0. The exact compatibility object identifies SHA-256 content of all local pipeline component assets and ordered LoRA bytes/strengths, width, height, steps, CFG, mode, denoising strength, sampler/scheduler, dtype and GPU device name. Masked scope also binds manual/CLIPSeg source kind, growth, threshold and mask prompt; automatic masking binds all local CLIPSeg asset bytes and `sampling.maskExecutionRevision: clipseg-single-image-vision-v1`. Only automatic-mask scopes gain this field; plain generation and manual-mask v3 scopes retain their existing identity. Old automatic-mask profiles fall back to full computation in auto mode and are rejected for strict enablement or acceptance; profiles are never rewritten automatically. The accepted or collected mask digest is checked against assets actually used before reuse/loading and after a new load, including calibration with mask caching disabled. Prompt/seed and source/mask image content may vary within the independently accepted calibration set. This is not a guarantee for unseen content.

The version-1 profile carries 1–6 finite polynomial `coefficients` in ascending power order, `proxyRange`, `defaultThreshold`, `maxThreshold`, `maxConsecutiveSkips`, and `calibration` containing `source: local-full-compute`, a valid-pair `sampleCount` and `traceSha256`. Explicit profile generation additionally requires `acceptance.status: accepted` and `acceptance.reportSha256`, set only by the explicit local acceptance workflow after reviewing held-out results. These are local evidence links, not cryptographic certification of quality. Changing weights, adapters/scales, sampling/edit scope, dtype, GPU or execution mode/revision requires a compatible new calibration. Identity comes from full content hashes or a still-protected lease to those exact bytes, never file names or mtimes alone. First acquisition and fallback hashing add I/O.

The fixed `teacache-profile.json` can also hold a `huiyu-teacache-profile-set`
collection (schemaVersion 1, profiles array): at most 16 entries and 64 KiB total.
The worker selects exactly one matching runtime and compatibility scope, then
performs the usual acceptance and coefficient validation, excluding local-guard.
Version 3 is a separate family, so storing it never replaces same-scope v1/v2.
Different character
LoRAs and strengths never borrow each other's profiles. The acceptance command
appends a new scope or replaces the same scope while preserving other entries;
both operations require the old whole-file `--replace-profile-sha256` and atomic
publication. A leftover `.teacache-profile.lock` requires local inspection after
an interrupted acceptance; it is never silently stolen.

Experimental `--strategy local-guard` adds a second independently calibrated
budget to the phase-envelope cache. `anima_local_cache.py` reduces `[B,N,C]`
features in FP32, partitions each batch into at most 16 contiguous raster-token
groups and takes the maximum group relative L1. The short final group's epsilon
uses its actual token count. These groups may cross image rows; they are coarse
features, not faces/hands or semantic masks. Global/local metrics share one host
readback; only calibration additionally measures local residual changes. A skip
requires both phase envelopes to be in-domain and both accumulated budgets below
their own thresholds. Full refresh resets both; nonfinite values retain the
existing failure/publication guard. No extra long-lived feature cache is added.

The tool collects only when explicitly selecting local-guard, fits paired global
and local proxy/residual observations, and records the actual algorithm/metric
and `localChecks`/`localRiskRejects` for run/acceptance review. `--local-threshold`
is optional, defaults to that run's global threshold and is bounded 0.01..1;
neither threshold is a recommendation or semantic error bound. The CLI still
defaults to phase-envelope, no-run is only a plan, and schema3 is never selected
by the product even if stored. Future selection remains a separate user decision.
No model calls/calibration were performed for this candidate. It may skip less
or cost more than ordinary TeaCache.

Hires is calibrated as one complete operation, including both denoising passes
where applicable. Its scope also binds hires scale/denoise, resolved upscaler,
second-pass sampler/scheduler, refinement revision and the Remacri weight SHA256;
positive RCAS strength and prompt weighting mode also participate when active.
Positive `rcasStrength` scopes additionally bind `sampling.rcasExecutionRevision`
to `rcas-fp32-rows128-v1`; old positive-strength profiles fall back in auto mode
or reject strict enablement/acceptance. Zero-strength scopes gain no RCAS field.
Remacri scopes additionally bind `sampling.upscaleExecutionRevision` to
`remacri-no-single-cat-packed-v1`. Older Remacri profiles fall back to complete
computation in auto mode and are rejected when strictly enabled or accepted.
Profiles are not rewritten. Latent and non-hires scopes retain their identity.
The same controller is cleared at the pass boundary and attached to fresh second
pass blocks, so residuals never cross resolutions. Actual GPU evidence captured
24+14 updates. Nene/Natsume Latent 2x profiles at threshold 0.25 and skip limit 2 are accepted.
The Nene full-API warm median remains slower than Comfy (26.610 s versus 23.671 s,
two samples each); more aggressive hires candidates remain uninstalled. Ordinary profiles never serve as implicit authorization
for hires or weighted scopes. UI file readiness remains distinct from exact
scope and acceptance validation at load time.

Calibration accepts `--max-consecutive-skips 1..3` (default 1). A higher bound
only creates a candidate: first/last steps and the accumulated error threshold
still control actual skips, and held-out quality/performance acceptance remains
required. It does not reduce the requested scheduler step count.

Maintenance-only Python APIs are separate from the product JSONL protocol: `worker.generate(..., collect_teacache=True)` always fully computes and returns paired `proxyRelativeL1`/`residualRelativeL1` samples for fitting. `teacache_profile=<candidate dict>` can evaluate an unaccepted candidate but still enforces exact compatibility and calibration. `measure_teacache=True` on a disabled held-out baseline returns timing/memory without TeaCache hooks, proxy collection or TeaCache scope hashing (`compatibility: null`, `fingerprintSeconds: 0`); resident jobs still verify their weight identity; the calibration runner binds independently checked identity outside the run timer. Cached/collection reports include compatibility, samples, full/skip/block/reset/nonfinite counts, fingerprint time, synchronized model-load time including LoRAs, whole-pipeline time including encoding/denoising/decoding, and peak allocated CUDA bytes. `generationSeconds` is an alias of `pipelineSeconds`, never pure sampler time. The outer process wall clock remains necessary to judge actual end-to-end benefit; accepted caching can still be slower on a device because of hashing, synchronization or memory pressure. Cache tensors increase VRAM use.

The product now includes the community Anima polynomial; this section concerns the separate local-fit candidate. The algorithm is based on the public Apache-2.0 TeaCache idea; modular integration follows Apache-2.0 Diffusers (not ComfyUI code). Retain `TEACACHE_LICENSE.txt`. No dependency pins change. Historical device reports apply only to their recorded source; current built-in caching has no new device acceptance.

## Phase-specific Anima cache candidate and warm comparison

The default calibration strategy is `--strategy phase-envelope`; `--strategy polynomial` preserves the original comparison baseline. Version 2 stores three ordered `phaseEnvelopes` of observed proxy/residual changes. Each phase needs at least three paired observations and two distinct proxies. Up to 32 conservative boundaries retain the maximum observed error in adjoining intervals instead of smoothing away spikes with one global polynomial. Unobserved proxy ranges compute fully. Actual sliced sampling steps determine the phase, and transitions, first/last steps and bounded consecutive reuse trigger full refresh. These are empirical observations, not a semantic error guarantee. Unaccepted local profiles cannot enable the explicit maintenance-profile path; built-in caching is independent.

Calibration now defaults to one resident weight set for training and held-out baseline/cache pairs. Both sides must report `modelReused: true`; each job gets new blocks, scheduler, guider and cache controller. `--no-resident` separately measures cold jobs. Process creation is recorded separately; runtime imports and first model load are charged to the first training job; warm job wall times include fingerprinting, encoding, sampling, decoding and output. `residentFingerprintSeconds` includes both the initial byte-identity check and any post-load verification; `modelLoadSeconds` excludes that post-load hashing time. `fingerprintSeconds` records additional TeaCache scope work. Per-job CUDA allocation peaks are reset before generation. Review actual images, edited regions and boundaries as well as timings before accepting. Warm code/protocol fixtures alone do not establish device performance; see the 2026-10-11 report for the measured RTX 4070 Ti SUPER scope.

## Office-verifiable preparation and text reuse

Dependency/helper validation runs once per resident worker; standalone diagnostics read the bundled helper files afresh. Successfully loaded helper modules are reused for that process lifetime. Runtime/library changes require restarting the worker; model bytes are still checked per job.

`anima_text_cache.py` wraps the stock 0.41.0 text encoder block. Its LRU stores up to four entries / 16 MiB of detached CPU snapshots and returns new tensors for each task. Keys include exact prompt/negative strings, sequence limit, conditional branch count, encoder dtype and execution device. On a pair miss with CFG enabled, a matching cached negative branch can be reused while the stock encoder computes only the positive; this remains one pair miss and does not refresh the source pair's LRU position. Base reload/release clears it. Only Qwen embeddings and T5 ids/masks are cached: LoRAs touch the transformer/text conditioner, and the text conditioner always runs with current adapter strengths. Same adapter bytes in the same order can change strength and switch back without reloading the base; ordinary adapter-group changes also preserve the base and these raw text outputs. Base changes and conservative reloads clear the text cache. Result events include text cache hit/miss/retained-byte counters. Per-job `partialNegativeHits` also reaches `nativeRuntime.textCache`: it increments only after a partial negative lookup successfully returns independent copies, not for internal snapshot sharing or a whole-pair hit. It resets each job; an older worker's absent field remains absent, not an observed zero. This identifies the reuse branch, not GPU net savings or every encoder's cache state.

TeaCache calibration disables this text cache on both baseline and cached jobs and verifies that evidence again at acceptance, so a first-side encoder miss cannot inflate the TeaCache speedup. Complete byte identity checks retain SHA-256 semantics while using the standard streaming file-digest buffer to reduce Python allocation peaks. Office CPU/protocol results do not establish GPU throughput or final artwork quality.

The office validation environment uses Python 3.11 and all exact direct pins with Torch 2.8.0+cpu. A one-off real-library smoke used locally initialized miniature Qwen/Cosmos/text-conditioner/VAE and local toy tokenizers: stock/cached embeddings matched exactly, both LoRA components changed and restored strengths, fresh scheduling and full two-seed CPU pipeline execution succeeded. The test caught and fixed an output-boundary error: text outputs live in PipelineState, not the input-only BlockState. No actual Anima checkpoint, production artwork or CUDA workload was used. Raw local evidence stays under runtime/office-inference-20261010/, not the shipped resources.

## ComfyUI comparison evidence

The existing `scripts/tests/benchmark-anima-teacache.ts` entry now requires an explicit, already-tested ComfyUI API workflow instead of hard-coded models, LoRAs or sampler choices. Use `npm run wf -- models:benchmark-anima-comfy --workflow <api.json> --sampler-node <KSampler id> --output-dir <new runtime directory>`; it prints the exact job count, seed/order plan and parity limitations with no network, subprocesses or writes. Only `--run` contacts the prepared literal-loopback HTTP endpoint (default `http://127.0.0.1:8188`). It never installs, starts/restarts ComfyUI, flushes caches or interrupts the server.

Supply a graph with one KSampler and one SaveImage, producing one image. Unrelated nodes/outputs must be removed. For a ComfyUI TeaCache comparison, supply `--teacache-node <AnimaTeaCache id>` for the node directly feeding that sampler; the baseline bypasses only this node. Existing model, prompt, LoRA, precision and sampling inputs are retained. Every submitted graph is saved. This compares the supplied ComfyUI workflow variants, not native TeaCache implementations or equal-quality algorithms.

Default execution performs one warm-up per variant, followed by six measured rounds; `--warmups 1..5` and `--repeats 2..50` set the bounded workload. Each round uses a fresh seed, shared by the two variants, and order alternates baseline/cache then cache/baseline. Warm-ups stay in evidence but are excluded from summary statistics. They are not verified GPU residency, process-cold or disk-cold measurements. The initial service/model/OS-cache state is uncontrolled; no cold-start claim is made. Prompt-conditioning node cache hits remain visible in each history record; they are not equivalent to native calibration's intentionally disabled text cache.

The tool requires an empty queue before every submission and successful, matching history events; a cached sampler/output, interrupted/failed task, missing output or uncertain response stops the suite. Per-job `status.json` preserves its known prompt ID (or submission-unknown state) for manual inspection. It never resubmits after a timeout/error or sends a global interrupt that could affect another task. Use the device exclusively; queue preflight cannot prevent another client or process from starting later.

Raw requests/history, environment snapshot, PNGs and timing JSON belong in the ignored `runtime/` directory. `review.html` provides local image pairs and statistics. Output SHA-256 identifies complete PNG file bytes, not decoded pixels: Comfy SaveImage can embed the prompt graph, so changing seed/prompt metadata changes the hash even when pixels match. Completion time covers submission through successful output history, including queue, text encoding, sampling, VAE decoding, PNG save and polling. Delivered time additionally includes local evidence IO, PNG download and validation. Server event duration covers graph execution, not synchronized sampler-only GPU work. The default 100 ms polling interval is recorded (`--poll-ms`); HTTP latency remains additional. Report median/min/max/sample count; nearest-rank p95 is omitted below 20 measured rounds. System stats do not provide peak VRAM. No automatic image-quality approval or cross-backend speedup is emitted.

Use the existing gateway runner for authorized product timings. Keep cold process/load, warm novel prompt and warm repeated prompt separate. Establish checkpoint/export, LoRAs, prompt conditioning, sigmas, noise, dtype/kernel and cache scope, then inspect actual images before speed or quality claims. Current simple uses the training grid; identical seed/name alone never establishes cross-backend equality. Historical benchmark reports remain tied to their original source.

For img2img, native slices the original step schedule by strength, whereas [ComfyUI KSampler at the inspected commit](https://github.com/Comfy-Org/ComfyUI/blob/b058ec652802e1de24f1d429b3c7c1fb868f791c/comfy/samplers.py#L1431-L1463) constructs a longer schedule before taking its requested-step suffix: with Euler, 28 steps at strength/denoise 0.5 means 14 native updates versus 28 Comfy updates, not matched work. The native worker uses a CUDA generator, while [ComfyUI's inspected noise path](https://github.com/Comfy-Org/ComfyUI/blob/b058ec652802e1de24f1d429b3c7c1fb868f791c/comfy/sample.py#L9-L38) draws CPU float32 noise before casting to the latent dtype; disclose this difference rather than treating equal seeds as equal noise or silently changing either backend's defaults.

Official design references, inspected read-only: [ComfyUI model residency](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/model_management.py), [input-dependent node caching](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_execution/caching.py), [PyTorch asynchronous timing](https://docs.pytorch.org/docs/main/notes/cuda.html#asynchronous-execution), [PyTorch warm-up benchmarking](https://docs.pytorch.org/tutorials/recipes/recipes/benchmark.html), [Diffusers scheduler synchronization](https://huggingface.co/docs/diffusers/en/optimization/fp16#gpu-sync), and [official Anima components](https://huggingface.co/docs/diffusers/main/api/pipelines/anima). These are architectural observations and candidate optimizations, not measurements of this worker. No ComfyUI source is copied into the independent inference runtime. Diffusers' Apache-2.0 code license and ComfyUI's GPL-3.0 license are separate from [Anima's model-weight license](https://huggingface.co/circlestone-labs/Anima/blob/main/LICENSE.md); independently implementing the backend does not grant commercial model rights.

## Product gateway warm measurements

Use `npm run wf -- models:benchmark-inference-gateway --payload <actual-api-payload.json> --expect-provider native --output-dir <new runtime directory>` to inspect a zero-network, no-write plan. The payload is the actual object submitted to `/api/anima/jobs`, not a Comfy graph or Python worker envelope. Supply an explicit nonnegative safe-integer `seed`; other parameters, including TeaCache, uploaded `initImage`/`maskImage` names, model/LoRAs and prompt, are retained. Upload any source images beforehand using the normal product flow. By default the runner only increments the seed. The default is one warm-up then six measured repeated-prompt jobs; `--warmups 1..5`, `--repeats 2..50`, `--poll-ms 100` and `--timeout 600` bound the workload. No recipe, model, adapter or cache flag is invented or silently aligned between engines.

To request different positive text on a warmed model, optionally add `--prompt-variants <user-text.json>`. The file accepts only `{"warmup":["user warm-up text"],"measured":["user text A","user text B"]}`; this example requires `--warmups 1 --repeats 2`. Array lengths must exactly match those options; no automatic cycling, extra generation or invented text occurs. Every value must be a nonempty string of at most 12000 UTF-16 code units, matching the actual API limit. The variants file and each complete serialized job must fit 64 KiB. Warm-up texts may repeat; measured texts must differ from each other and every warm-up after the API's Unicode whitespace trimming. Original user text is preserved in each request, with `expectedNormalizedPrompt` recorded separately; only `prompt` and the existing seed sequence change, including preserving the original negative text. The plan lists every complete request, and execution uses those same requests. Completed variants jobs must independently report that normalized prompt in `serverMetadata.prompt`; absent/mismatched text stops the suite without a request-value fallback. JSON/HTML label this population `requested-distinct-prompts-within-suite` and retain the variants source SHA-256. This does not prove unseen historical text, different tokens or encoder cache misses; inspect actual cache counters and base reuse separately. Fixed negative text does not prove it was evaluated or reused (for example, CFG=1 may omit that branch). Keep the same supplied texts, order, seeds and counts when comparing runs, and keep this population separate from the default repeated-prompt measurements.

`sampler` and `scheduler` are not accepted fields of this API payload; the provider/catalog selects them. The plan rejects either field rather than implying that they can be manually aligned through `/api/anima/jobs`. Inspect the server's normalized metadata and actual runtime schedules separately.

For an uncached-algorithm baseline, explicitly set `teaCache: false` and remove `teaCacheThresh` from both payloads: omission enables Comfy TeaCache and selects automatic matching on native; actual native use is reported in runtime observations. This does not disable product model/text/mask residency. For editing, upload the same source/mask bytes through the normal product flow separately after selecting each engine: native uses `inference/input`, while Comfy uses `ComfyUI/input`. Reusing the other engine's upload name can fail. Retain each engine's actual payload and source-image hashes; their upload names may differ.

Current Comfy ordinary img2img connects VAE-encoded source latents and denoisingStrength before the optional mask branch. Native v3 now implements the requested mask, KJ RCAS, RRDB assembly, quantization and VAE boundaries. Neither the implemented formulas nor old diagnostic workflows establish current device/pixel/performance parity; compare exact v3 outputs and recorded runtime operations on authorized CUDA hardware.

Only append `--run` when the actual local gateway and model environment are prepared. `--gateway` accepts a literal-loopback HTTP origin, default `http://127.0.0.1:3000`. Run one provider at a time on an otherwise idle GPU: measure native, release its resident worker through the normal product controls, configure/restart for Comfy as required, then warm up and measure again with `--expect-provider comfy` and a different new output directory. Do not keep both engines resident or generating concurrently. This runner never changes settings, starts/restarts services, unloads models, flushes caches, downloads anything, retries an uncertain submission or sends cancellation/global interrupts. The operator owns exclusivity; the tool cannot prove no other GPU process exists.

For an explicitly planned cross-provider comparison, balance separate suites in both native→Comfy and Comfy→native order. At each switch release the previous backend, verify only one is resident, and warm up again with the same plan, monitoring mode, seeds and supplied texts; keep repeated-prompt and distinct-prompt populations separate. One warm-up or balanced order does not establish an OS/disk-cold start, thermal steady state or equivalent inference. This is an operator-planned comparison, not additional automatic submissions, and the known compatibility differences below still prevent a parity verdict.

Optional whole-device memory sampling requires **all three**: `--run --sample-device-memory GPU-<full-physical-UUID> --nvidia-smi "<absolute path to the already-installed official nvidia-smi executable>"`. Without the two sampling options, no sampler starts; plan mode only prints its proposed command and never spawns/probes the CLI. The executable must be named `nvidia-smi` or `nvidia-smi.exe`; the operator supplies/verifies the official installation, with no installation or PATH lookup by the runner. The fixed command queries UUID, PCI bus ID, driver version, total/used MiB and query timestamp every **1000 ms**, using one direct child per suite. A trustworthy first row is required within 10 seconds before any gateway submission; unavailable/N/A readings never become zero. Gaps exceeding 3500 ms, invalid rows or process errors stop further submissions after the current job follows the normal completion protocol. Images and a `partial-stopped` JSON/HTML report remain available. No retry/cancel is sent. SIGINT instead aborts local HTTP/poll waiting and closes the sampler; a submitted or uncertain server job may still be running, so inspect its saved status before another run. Cleanup targets only this child PID and waits up to 5 seconds for its `close` after the termination request; unconfirmed cleanup stays explicit. Forced termination or crashes cannot guarantee cleanup.

Sampling reports `measurementMode: "monitoring-enabled"`, `deviceMemorySampling` and per-job windows plus `device-memory-samples.jsonl`, `device-memory-stderr.log`, an early `device-memory-stop-checkpoint.json`, and final `device-memory-sampling.json`. The suite-final sampling snapshot is identical in the final sidecar JSON and report, including any late observed close; historical timeout issues remain. `cleanup.pid` is diagnostic only, never an instruction to kill a possibly reused PID. The label is **sampled device-used maximum**, never true peak or job-attributed VRAM; `peakVram` remains null and native allocator metrics stay separate. Whole-suite values include warm-ups/gaps and must not be used as measured-job peaks. Windows use monotonic host full-line receipt times, retaining the pre-window sample, in-window count/maximum/observed gaps and next post-window sample when available. Missing window samples remain null/unverified; pipe buffering and scheduling can misassign boundary samples, and 1-second sampling misses short peaks. Other processes, desktop, driver accounting and resident models contribute; do not subtract the baseline as a job increment. Compare only equally monitored suites because sampling overhead is unmeasured. Verify each already-running backend actually uses the requested physical UUID: `CUDA_VISIBLE_DEVICES` can remap logical device 0, and this entry cannot prove backend binding or exclusivity. MIG/vGPU and multi-GPU workloads are outside this mode. See official [NVIDIA query/loop and memory caveats](https://docs.nvidia.com/deploy/nvidia-smi/index.html), [CUDA device visibility](https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/environment-variables.html#cuda-visible-devices) and [Node child close/kill semantics](https://nodejs.org/api/child_process.html#subprocesskillsignal). Real NVIDIA CLI/Windows cleanup, sampling overhead and device accuracy still require operator validation; cloud tests only use mocks.

Before each submission it reads `/api/inference/settings` and `/api/anima/status` outside the timer. The settings contract distinguishes the **active** engine from the saved **configured** target; an active mismatch or nonzero pending-job count stops before submission. Unavailable settings/status are saved as unverified, counted in JSON/HTML, and are never treated as proof of engine selection or an empty GPU. Every completed job must independently report the expected provider and the exact requested seed. A missing server seed is rejected rather than substituting the request seed. Requests use `no-store`, and duplicate job IDs or complete PNG file bytes stop the suite for investigation. This is not a decoded-pixel comparison: [Comfy SaveImage embeds prompt metadata when enabled](https://github.com/Comfy-Org/ComfyUI/blob/b058ec652802e1de24f1d429b3c7c1fb868f791c/nodes.py#L1538-L1548), and metadata or encoding differences can change file hashes without changing pixels. Identical bytes can also mean a degenerate output and are not definitive cache proof; different bytes do not prove fresh sampling. Gateway metadata still cannot prove sampler execution, noise tensors or node-cache misses.

The tool reuses `scripts/lib/generation-gateway.ts` for submission, polling, same-origin result download and structural PNG validation. Native conditioning/model/mask residency and Comfy graph caches remain at their actual product settings; this is intentionally separate from TeaCache calibration's disabled-cache A/B. The timed wall interval includes submission, queueing, inference/output work, polling, PNG download/validation, hashing and synchronous local image save. It excludes preflight and setup of evidence folders. It does not isolate the sampler or GPU kernels. Polling adds up to one nominal polling interval only when request/processing latency is negligible; HTTP latency is additional, so `--poll-ms` is not a bound on the whole timing error.

Each new output directory retains `plan.json`, per-job requests, settings/status observations, job IDs/status, provider, server-reported seed, terminal `serverMetadata` (including normalized sampling/cache parameters), request/PNG SHA-256, actual output dimensions, PNGs, `report.json` and `review.html`. Failed/cancelled jobs also preserve the server's `code` and `error` as `serverCode` and `serverError`, separate from the runner's local failure. Warm-ups remain visible but do not enter the measured median/min/max/count; p95 is omitted below 20 measured jobs. Failure preserves partial evidence and produces no successful aggregate report; inspect the recorded job before starting a new suite. All raw data belongs under ignored `runtime/`.

`serverMetadata` is partial normalized request metadata plus available native observations, not a complete executed-workflow record. Current Comfy metadata omits mask prompt/threshold/growth and input/mask names; native metadata omits the effective profile-selected TeaCache threshold when it was not explicitly requested, and does not identify that profile. Missing fields mean unobserved here, never default, disabled or equal. The runner does not capture effective mask pixels or establish matching resize/growth/threshold semantics. Explicit request values and diagnostic Comfy graphs remain useful evidence, but do not replace missing runtime observations or establish cross-backend equivalence.

New native workers also report `job.metadata.nativeRuntime`, retained in each job JSON and the expandable server-parameter section of `review.html`. It includes actual completed scheduler updates, base reuse, current-job text/mask/TeaCache counters and CPU wall intervals for image preparation, model acquisition, the full encoding/denoising/decoding pipeline, compositing and output. These intervals overlap and are not additive; `workerWallSeconds` ends before emitting the result and excludes process startup and gateway delivery. `existingReportSynchronization` identifies pre-existing TeaCache/report synchronization; ordinary product observations add no CUDA synchronization or tensor readback.

The native allocator observation resets once before image preparation and reads counters after the pipeline. A supported, already initialized PyTorch native CUDA allocator reports allocated/reserved interval peaks, including previously resident memory. This is process/device-0 allocator evidence, not total-device VRAM or incremental bytes attributable only to the job. Cold ordinary tasks, unsupported allocators or observation errors report null/unverified; an explicit existing measurement report preserves its one reset attempt without initializing CUDA or falling back to a historical peak. Legacy workers or malformed observations remain unverified and do not invalidate an otherwise valid image. Real GPU overhead and accuracy remain untested. Server metadata also retains normalized parameters; inspect them rather than assuming omitted request defaults match across engines.

These are separate observed product wall distributions, never an automatic speedup, parity or quality verdict. Without opt-in sampling no GPU/driver fingerprint is collected. The runner alone cannot establish backend GPU binding, actual sigma capture, total-device true peak VRAM, precision match, checkpoint/export equivalence, process/disk-cold state or guaranteed residency. Record device/library/model provenance separately and review real images/edited boundaries. Product payload defaults can differ between providers; explicitly choose supported comparable parameters when comparison is intended, without assuming the same seed or sampler/scheduler name makes them equivalent. The linked 2026-10-11 reports contain real device runs for their recorded revisions. The current report separates new model/hires/weighting evidence from the still-pending final API comparison; no older timing population substitutes for it.
