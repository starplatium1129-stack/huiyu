"""Image-only Krea 2 execution on the pinned RAW/Turbo Diffusers pipelines."""
from contextlib import ExitStack
import os
from time import perf_counter

from huiyu_worker_lifecycle import load_sibling

GIB = 1024**3
mapped = load_sibling("mapped_residency")


class DesktopMemory:
    """Global dedicated memory includes display clients missing from CUDA's WDDM free counter."""
    def __init__(self, props):
        import ctypes
        self.api = None
        if os.name != "nt":
            return
        class Memory(ctypes.Structure):
            _fields_ = [(key, ctypes.c_uint64) for key in ("total", "free", "used")]
        self.info, self.handle = Memory(), ctypes.c_void_p()
        try:
            api = ctypes.WinDLL("nvml.dll", winmode=0x800)
            uuid = str(props.uuid).removeprefix("GPU-")
            if api.nvmlInit_v2() == 0:
                if api.nvmlDeviceGetHandleByUUID(("GPU-" + uuid).encode(), ctypes.byref(self.handle)) == 0:
                    self.api = api
                else:
                    api.nvmlShutdown()
        except (OSError, AttributeError):
            pass

    def room(self):
        import ctypes
        if self.api is not None and self.api.nvmlDeviceGetMemoryInfo(self.handle, ctypes.byref(self.info)) == 0:
            return self.info.free - min(self.info.total // 8, 2 * GIB)
        return None

    def close(self):
        if self.api is not None:
            self.api.nvmlShutdown()
            self.api = None


class Residency(mapped.Residency):
    """Respect both CUDA free memory and WDDM's system-wide allocation limit."""
    def __init__(self, components, pixels):
        import torch
        self.pixels = pixels
        props = torch.cuda.get_device_properties(0)
        self.desktop = DesktopMemory(props)
        total = props.total_memory
        self.capacity = (total - min(total // 4, 4 * GIB) if self.desktop.room() is not None
                         else total - min(total // 3, 5 * GIB + GIB // 2))
        vae = components["vae"]
        # The single-frame BF16 decoder on Ada needs ~2.75 GiB of allocator
        # growth at 1024x1536. Leave ~16% above that peak for this workspace.
        compact_decode = ((props.major, props.minor) == (8, 9)
                          and vae.dtype == torch.bfloat16 and vae.config.base_dim == 96)
        self.decode_bytes_per_pixel = 2176 if compact_decode else 2560
        # PEFT casts the input for A and creates a full-width B output and a
        # scaled/add result. Budget their projection widths at the adapter dtype.
        self.style_bytes_per_token = max((
            (layer.in_features + 2 * proj.out_features) * proj.weight.element_size()
            for layer in components["transformer"].modules() if hasattr(layer, "lora_B")
            for proj in layer.lora_B.values()), default=0)
        self.style_workspace = 0
        self.changing_stage = False
        self.bounded_upload = False
        self.transport = getattr(components["transformer"], "_huiyu_transport", None)
        self.fusion_cold = []
        self.fusion_asleep = False
        self.block_records = []
        self.defer_blocks = False
        self.step_room = None
        self.checked_pressure = False
        self.transfer = None
        self.lookahead_bytes = 0
        self.prefetch_enabled = True
        self.available_commit = load_sibling("video_memory").available_commit
        try:
            super().__init__(components, "offload", pixels, image_conditioned=False, decode_pixels=pixels,
                             retain_components=True, stream_text=True)
        except BaseException:
            self.desktop.close()
            if self.transport is not None:
                self.transport.close()
            raise

    def _headroom(self):
        commit = self.available_commit()
        if commit is None:
            return None
        # Leave room for the desktop, the launcher and concurrent application
        # allocations. CUDA's free-byte counter alone misses Windows commit.
        self.report["availableCommitBytes"] = commit
        self.report["minimumAvailableCommitBytes"] = min(self.report.get("minimumAvailableCommitBytes", commit), commit)
        return max(0, commit - 2 * GIB)

    def bind(self, pipeline):
        self.wake_fusion()
        self.step_room = None
        self.checked_pressure = False
        if self.transport is not None:
            self.transport.report.update(uploads=0, packedBytes=0, fp8GemmCalls=0, fp8InputHits=0, fusedInputPacks=0)
        self.report.pop("minimumAvailableCommitBytes", None)
        self.report["reclaimedWeightBytes"] = 0
        self.report["lowCommitStreamGroups"] = 0
        self.report["prefetchHits"] = self.report["uploadedTransformerBytes"] = 0
        self.report["textPackedTransferBytes"] = self.report["fusionOffloadedBytes"] = 0
        self.report["warmBlocks"] = sum(self.block_live(r) for r in self.records)
        self.prefetch_enabled = True
        super().bind(pipeline)

    def add(self, name, module):
        if name == "transformer" and self.transport is not None:
            self.transport.pack_blocks(module)
        start = len(self.records)
        super().add(name, module)
        blocks = {}
        main = set()
        fusion = set()
        if name == "transformer":
            main.update(module.transformer_blocks)
            for group in (module.text_fusion, module.txt_in):
                fusion.update((*group.parameters(), *group.buffers()))
        for record in self.records[start:]:
            # A group can surround a whole module and still need its weights
            # after a nested layer returns. Evict only groups outside forward.
            group = record["group"]
            if len(group.modules) == 1 and group.modules[0] in main:
                layout = load_sibling("video_memory").block_transfer_layout(record, fp8=True) if self.transport else None
                record["transfer_layout"] = layout
                if layout is not None:
                    self.lookahead_bytes = max(self.lookahead_bytes, layout[0])
                blocks[group.modules[0]] = record
            all_sources = record["sources"]
            cached = {t: source for t, source in all_sources.items() if t in fusion}
            if cached:
                self.fusion_cold.append((record, all_sources, {t: s for t, s in all_sources.items() if t not in fusion}, cached))

            def onload(record=record, original=group.onload_):
                record["executing"] = True
                original()

            def offload(record=record, original=group.offload_):
                try:
                    original()
                    if self.active == "transformer" and "transfer_layout" in record:
                        self.prefetch_after(record)
                finally:
                    record["executing"] = False

            group.onload_, group.offload_ = onload, offload
        if blocks:
            sequence = module.transformer_blocks
            self.block_records = [blocks[block] for block in sequence if block in blocks]
            for current, following in zip(sequence, list(sequence)[1:]):
                if current in blocks:
                    blocks[current]["next"] = blocks.get(following)

    def release_transfer(self):
        if self.transfer is not None:
            self.transfer.close()
            self.transfer = None

    @staticmethod
    def transfer_pressure(error):
        import torch
        return isinstance(error, (torch.OutOfMemoryError, MemoryError)) or any(
            phrase in str(error).lower() for phrase in ("out of memory", "memory allocation", "pinned memory"))

    @staticmethod
    def block_live(record):
        return "transfer_layout" in record and record["keep"] and all(t.is_cuda for t in record["sources"])

    def sleep_fusion(self):
        if self.fusion_asleep:
            return
        for record, _all, hot, cached in self.fusion_cold:
            for tensor in cached:
                if tensor.is_cuda:
                    self.report["fusionOffloadedBytes"] += tensor.nbytes
                    tensor.data = record["offloaded"][tensor]
            record["sources"] = hot
        self.fusion_asleep = True

    def preload_blocks(self):
        """Conditioning has finished. Partition actual device space before the first image block."""
        import torch
        self.defer_blocks = False
        torch.cuda.empty_cache()
        live = [row for row in self.block_records if all(t.is_cuda for t in row["sources"])]
        room = self.planning_room()
        free = min(torch.cuda.mem_get_info()[0], max(0, self.capacity - torch.cuda.memory_reserved()))
        held = sum(row["bytes"] for row in live)
        budget = held + min(free, room if room is not None else free) - self.activation_reserve - self.cast_reserve
        if sum(row["bytes"] for row in self.block_records) > budget:
            budget -= self.lookahead_bytes * 2  # current stream and single lookahead
        live_ids = {id(row) for row in live}
        for row in sorted(self.block_records, key=lambda row: id(row) not in live_ids):
            row["keep"] = row["bytes"] <= budget
            if row["keep"]:
                budget -= row["bytes"]
            else:
                self.restore(row)
        self.changing_stage = True
        start, transferred = perf_counter(), self.transport.report["packedBytes"]
        try:
            for row in self.block_records:
                if row["keep"]:
                    self.load_record(row)
            self.report["residentBlocks"] = sum(self.block_live(r) for r in self.block_records)
            sizes = {r["transfer_layout"][0] for r in self.block_records if not r["keep"]}
            if self.prefetch_enabled and len(sizes) == 1:
                size = sizes.pop()
                room = self.planning_room()
                if room is not None and room > 2 * size + self.activation_reserve + 64 * 1024**2:
                    try:
                        if self.transfer is None:
                            self.transfer = load_sibling("video_memory")._BlockTransfer(self.device)
                        self.transfer.reserve_pair(size, self.device)
                    except (RuntimeError, MemoryError) as error:
                        if not self.transfer_pressure(error):
                            raise
                        self.release_transfer()
        finally:
            self.report["preloadMs"] += round((perf_counter() - start) * 1000)
            self.report["preloadedPackedBytes"] += self.transport.report["packedBytes"] - transferred
            self.changing_stage = False

    def wake_fusion(self):
        if self.fusion_asleep:
            for record, sources, _, cached in self.fusion_cold:
                record["sources"] = sources
                if record.get("executing"):
                    for tensor, source in cached.items():
                        if not tensor.is_cuda:
                            tensor.data = self.to_cuda(source, record["keep"])
            self.fusion_asleep = False

    def prefetch_after(self, record):
        import torch
        following = record.get("next")
        try:
            board = self.desktop.room()
            if board is not None:
                self.step_room = board if self.step_room is None else min(self.step_room, board)
            if board is not None and board < 0 and not self.checked_pressure:
                self.checked_pressure = True
                self.reclaim(GIB // 4, record, self.desktop.room)
            if not self.prefetch_enabled or not following or following["keep"] or not following["transfer_layout"]:
                return
            size = following["transfer_layout"][0]
            available = self._headroom()
            spare = self.transfer.spare if self.transfer is not None else None
            extra = 0 if spare is not None and spare[0].numel() == size else size
            if board is not None and board < 0:
                board = self.desktop.room()
            if (torch.cuda.mem_get_info()[0] < extra + GIB or (available is not None and available < extra + GIB)
                    or (extra and board is not None and board < extra)):
                self.release_transfer()
                return
            if self.transfer is None:
                self.transfer = load_sibling("video_memory")._BlockTransfer(self.device)
            self.transfer.queue(following, self.control, self.report)
            packed = [source for source in following["sources"].values() if source.dtype == torch.float8_e4m3fn]
            self.transport.report["uploads"] += len(packed)
            self.transport.report["packedBytes"] += sum(source.numel() for source in packed)
        except (RuntimeError, MemoryError) as exc:
            if not self.transfer_pressure(exc):
                raise
            self.prefetch_enabled = False
            self.release_transfer()
            torch.cuda.empty_cache()
        finally:
            if self.transfer is not None:
                self.transfer.retire(record, self.device, keep_pair=True)

    def step_finished(self, step, total):
        # Both RAW branches have now used the actual activation and staging
        # workspace. A complete block can stay only in measured spare space.
        if step == 1 and step < total and self.step_room is not None and self.transport is not None:
            room = min(self.step_room, self.desktop.room() or 0) - max(GIB // 4, self.style_workspace)
            commit = self._headroom()
            if commit is not None:
                room = min(room, commit - self.activation_reserve)
            for record in self.records:
                if record.get("transfer_layout") and not record["keep"] and record["bytes"] <= room:
                    record["keep"] = True
                    room -= record["bytes"]
        self.report["residentBlocks"] = sum(r["keep"] for r in self.records if "transfer_layout" in r)
        self.step_room = None
        self.checked_pressure = False

    def refresh_budget(self):
        budget = super().refresh_budget()
        budget = min(budget, max(0, self.capacity - self.activation_reserve))
        available = self._headroom()
        if available is not None:
            budget = min(budget, max(0, available - self.activation_reserve))
        self.report["weightBudgetBytes"] = budget
        return budget

    def planning_room(self):
        available = self._headroom()
        board = self.desktop.room()
        if board is not None:
            available = board if available is None else min(available, board)
        return available

    def plan(self, pixels, *, image_conditioned=False, control=None, decode_pixels):
        self.pixels = pixels
        # Krea packs 16x16 image pixels per token and accepts up to 512 text tokens.
        self.style_workspace = ((pixels + 255) // 256 + 512) * self.style_bytes_per_token
        self.activation_reserve = mapped.activation_reserve(pixels, image_conditioned) + self.style_workspace
        super().plan(pixels, image_conditioned=image_conditioned, control=control,
                     decode_pixels=decode_pixels, available_bytes=self.planning_room,
                     capacity_bytes=self.capacity, lookahead_bytes=self.lookahead_bytes or None,
                     activation_bytes=self.activation_reserve)

    def reclaim(self, required, current, measure=None):
        import torch
        torch.cuda.empty_cache()
        measure = measure or self._headroom
        available = measure()
        if available is None or available >= required:
            return available
        protected = set(current["sources"])
        for record in self.records:
            if record.get("executing"):
                protected.update(record["sources"])
        target = required - available + GIB // 2
        retired = 0
        for record in reversed(self.records):
            if not record["keep"] or not protected.isdisjoint(record["sources"]):
                continue
            released = sum(t.numel() * t.element_size() for t in record["sources"] if t.device.type == "cuda")
            if released:
                record["keep"] = False
                self.restore(record)
                self.report["reclaimedWeightBytes"] += released
                retired += released
                if retired >= target:
                    torch.cuda.empty_cache()
                    available = measure()
                    if available is None or available >= required:
                        return available
                    retired = 0
                    target = required - available + GIB // 2
        if retired:
            torch.cuda.empty_cache()
            return measure()
        return available

    def make_room(self, required):
        import torch
        if self.active == "vae":
            required = max(required, self.pixels * self.decode_bytes_per_pixel + self.modules["vae"].num_parameters() * 2)
        available = self._headroom()
        board = self.desktop.room()
        if board is not None:
            available = board if available is None else min(board, available)
        if available is not None:
            free, _ = torch.cuda.mem_get_info()
            required += max(0, free - available)
        super().make_room(required)

    def enter(self, name):
        if self.active == name:
            return
        self.release_transfer()
        self.defer_blocks = (name == "transformer" and self.transport is not None and bool(self.block_records)
                             and all(r.get("transfer_layout") for r in self.block_records))
        if name == "transformer" and self.control is not None and not self.defer_blocks:
            self.plan(self.pixels, control=self.control, decode_pixels=self.pixels)
        self.changing_stage = True
        start = perf_counter()
        transferred = self.transport.report["packedBytes"] if self.transport else 0
        try:
            super().enter(name)
            if name == "transformer":
                self.report["residentBlocks"] = sum(self.block_live(r) for r in self.records)
                self.report["preloadMs"] = round((perf_counter() - start) * 1000)
                if self.transport:
                    self.report["preloadedPackedBytes"] = self.transport.report["packedBytes"] - transferred
        finally:
            self.changing_stage = False

    def load_record(self, record):
        if self.defer_blocks and "transfer_layout" in record:
            if self.changing_stage:
                return
            self.preload_blocks()
        if not self.changing_stage and self.transfer is not None and self.transfer.attach(record, self.device):
            self.report["prefetchHits"] += 1
            return
        missing = sum(source.numel() * source.element_size() for t, source in record["sources"].items()
                      if t.device.type != "cuda")
        if missing:
            board = self.desktop.room()
            if board is not None and board < missing:
                if self.changing_stage:
                    record["keep"] = False
                    return
                board = self.reclaim(missing, record, self.desktop.room)
                if board is not None and board < missing:
                    raise load_sibling("adapter_contract").AdapterError("NATIVE_OUT_OF_MEMORY",
                        f"桌面独立显存余量不足以安全上传 Krea 层，需要 {missing // 2**20} MiB。")
            available = self._headroom()
            if available is not None:
                if self.changing_stage and record["keep"] and available < missing + self.report["activationReserveBytes"]:
                    # A later streamed group and its activations have priority
                    # over preloading weights that have not started computing.
                    record["keep"] = False
                    return
                if available < missing:
                    available = self.reclaim(missing, record)
                if available is not None and available < missing:
                    # After all reclaimable groups and CUDA slabs have retired,
                    # a single, immediately consumed group may use up to half
                    # the reserve. Its hook drops the weights on return.
                    commit = self.report["availableCommitBytes"]
                    if self.changing_stage or commit < missing + GIB:
                        raise load_sibling("adapter_contract").AdapterError("NATIVE_OUT_OF_MEMORY",
                            f"Windows 可提交内存不足以加载 Krea {record['name']} 层。"
                            f"系统余量 {commit // 2**20} MiB，该层需要 {missing // 2**20} MiB。")
                    record["keep"] = False
                    self.report["lowCommitStreamGroups"] += 1
                # Stage hot mmap pages in bounded pinned buffers under pressure.
                # Large pageable uploads can themselves consume host memory.
                self.bounded_upload = available is not None and available < missing + self.report["activationReserveBytes"] + GIB
        super().load_record(record)

    def to_cuda(self, source, retain):
        import torch
        if source.dtype == torch.float8_e4m3fn:
            value = super().to_cuda(source, retain, mapped_pages=True)
            if self.active == "text_encoder":
                self.report["textPackedTransferBytes"] += source.nbytes
            elif self.transport is not None:
                self.transport.report["uploads"] += 1
                self.transport.report["packedBytes"] += source.numel()
            return value
        return super().to_cuda(source, retain, mapped_pages=self.bounded_upload and not retain)

    def close(self):
        try:
            self.release_transfer()
            super().close()
        finally:
            self.desktop.close()
            self.fusion_cold.clear()
            self.block_records.clear()
            if self.transport is not None:
                self.transport.close()
                self.transport = None

    def finish(self):
        self.release_transfer()
        commit = self.available_commit()
        if commit is not None and commit < 6 * GIB:
            self.offload_all()
        else:
            super().finish()
            for hook in self.manager.model_hooks or ():
                if hook.model is self.modules["vae"]:
                    hook.offload()
            self.active = None
        self.control = None

    def offload_all(self):
        self.release_transfer()
        super().offload_all()
        if self.staging is not None:
            for event, active in zip(self.copy_events, self.copy_active):
                if active:
                    event.synchronize()
            self.staging_views = self.staging = None
            self.copy_events, self.copy_active = [], [False, False]

    def decode_tile(self, latents):
        import torch
        height, width = latents.shape[-2:]
        free, _ = torch.cuda.mem_get_info()
        free = min(free, max(0, self.capacity - torch.cuda.memory_reserved()))
        available = self._headroom()
        if available is not None:
            free = min(free, available)
        board = self.desktop.room()
        if board is not None:
            free = min(free, board)
        per_pixel = self.decode_bytes_per_pixel * 64
        if height * width * per_pixel <= free:
            return None
        tile = 32
        while tile * 2 <= max(height, width) and min(height, tile * 2) * min(width, tile * 2) * per_pixel <= free:
            tile *= 2
        return tile


def configure(pipeline, policy):
    from types import MethodType
    from torch import nn
    from torch.nn import functional as F
    from diffusers.models.autoencoders.autoencoder_kl_qwenimage import (
        QwenImageDecoder3d, QwenImageResidualBlock, QwenImageUpsample)

    # The Krea text encoder reads twelve language-layer taps. It never uses
    # Qwen's vision tower or autoregressively extends a KV cache.
    encoder = pipeline.text_encoder
    encoder.visual = None
    language = encoder.language_model
    language.config.use_cache = False
    if policy == "offload":
        load_sibling("native_memory").keep_token_table_on_cpu(language)
    def swiglu(module, x):
        gate = F.silu(module.gate(x), inplace=True)
        return module.down(gate.mul_(module.up(x)))
    for block in pipeline.transformer.transformer_blocks:
        block.ff.forward = MethodType(swiglu, block.ff)
    for layer in pipeline.vae.decoder.modules():
        if type(layer) is QwenImageUpsample and layer.mode == "nearest-exact":
            # Nearest copies a channel value verbatim; the full FP32 image
            # and its subsequent BF16 copy have identical sample coordinates.
            layer.forward = MethodType(nn.Upsample.forward, layer)
        if type(layer) in (QwenImageResidualBlock, QwenImageDecoder3d) and type(layer.nonlinearity) is nn.SiLU:
            # Both pinned forwards apply SiLU only to a fresh norm result.
            layer.nonlinearity.inplace = True


def _replace(stack, owner, name, value):
    if name in vars(owner):
        stack.callback(setattr, owner, name, getattr(owner, name))
    else:
        stack.callback(delattr, owner, name)
    setattr(owner, name, value)


def _reuse_forward(stack, module, report, counter, *, wake=None, ready=None):
    original = module.forward
    values = {}

    def forward(source, **kwargs):
        # A nonempty padding mask can vary independently of the source tensor.
        # Keep the ordinary implementation for that case.
        if kwargs.get("attention_mask") is not None:
            if wake is not None:
                wake()
            return original(source, **kwargs)
        key = id(source)
        if key in values:
            report[counter] += 1
            return values[key][1]
        if wake is not None:
            wake()
        output = original(source, **kwargs)
        # The worker renders a single image. RAW can have one extra CFG branch.
        if len(values) < 2:
            values[key] = (source, output)
            if ready is not None:
                ready(len(values))
        return output

    _replace(stack, module, "forward", forward)
    stack.callback(values.clear)


def _tap_text_encoder(stack, pipeline, report):
    encoder = pipeline.text_encoder
    language = encoder.language_model
    taps = pipeline.text_encoder_select_layers
    layers = language.layers
    if not taps or min(taps) <= 0 or max(taps) >= language.config.num_hidden_layers or max(taps) > len(layers):
        return  # Embedding and final normalized taps have different semantics.
    original = encoder.forward

    def encode(*args, **kwargs):
        if not kwargs.get("output_hidden_states"):
            return original(*args, **kwargs)
        # Diffusers indexes the hidden-state tuple by decoder output (the
        # embedding is index 0). The worker needs only these pre-norm taps.
        states = [None] * (len(layers) + 1)
        with ExitStack() as capture:
            for index in taps:
                def save(_module, _args, output, i=index):
                    states[i] = output[0] if isinstance(output, tuple) else output
                capture.callback(layers[index - 1].register_forward_hook(save).remove)
            if len(layers) > max(taps):
                capture.callback(setattr, language, "layers", layers)
                language.layers = layers[:max(taps)]
            kwargs["output_hidden_states"] = False
            result = original(*args, **kwargs)
        result.hidden_states = tuple(states)
        report["textEncoderBlocks"] += max(taps)
        return result

    _replace(stack, encoder, "forward", encode)


def _grouped_attention(stack, pipeline, report):
    """Prefer native compact KV heads for supported unmasked requests."""
    import torch
    capability = torch.cuda.get_device_capability()
    if capability < (8, 0):
        return
    use_sage = False
    if capability == (8, 9) and pipeline.config.is_distilled:
        try:
            from sageattention.core import SM89_ENABLED, sageattn_qk_int8_pv_fp8_cuda
            use_sage = SM89_ENABLED
        except (ImportError, OSError):
            pass
    from diffusers.models.embeddings import apply_rotary_emb
    from torch.nn.attention import SDPBackend, sdpa_kernel
    supported = {}

    class Processor:
        def __init__(self, original):
            self.original = original

        def __call__(self, attn, hidden_states, attention_mask=None, image_rotary_emb=None):
            shape = hidden_states.shape[:2]
            if supported.get(shape) is False or attention_mask is not None or hidden_states.dtype != torch.bfloat16:
                return self.original(attn, hidden_states, attention_mask, image_rotary_emb)
            q = attn.norm_q(attn.to_q(hidden_states).unflatten(-1, (attn.num_heads, attn.head_dim)))
            k = attn.norm_k(attn.to_k(hidden_states).unflatten(-1, (attn.num_kv_heads, attn.head_dim)))
            v = attn.to_v(hidden_states).unflatten(-1, (attn.num_kv_heads, attn.head_dim))
            if image_rotary_emb is not None:
                q = apply_rotary_emb(q, image_rotary_emb, sequence_dim=1)
                k = apply_rotary_emb(k, image_rotary_emb, sequence_dim=1)
            if use_sage:
                result = sageattn_qk_int8_pv_fp8_cuda(q, k, v, tensor_layout="NHD", pv_accum_dtype="fp32+fp16")
            else:
                q, k, v = q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)
                if shape not in supported:
                    params = torch.backends.cuda.SDPAParams(q, k, v, None, 0.0, False, True)
                    supported[shape] = torch.backends.cuda.can_use_cudnn_attention(params)
                if supported[shape]:
                    try:
                        # The math backend expands KV and can allocate a full token-by-token matrix.
                        with sdpa_kernel(SDPBackend.CUDNN_ATTENTION):
                            result = torch.nn.functional.scaled_dot_product_attention(q, k, v, enable_gqa=True)
                        result = result.transpose(1, 2)
                        report["cudnnGqaCalls"] += 1
                    except RuntimeError as exc:
                        message = str(exc).lower().replace("_", " ")
                        if not any(s in message for s in ("execution plan", "not supported", "no available kernel", "not implemented")):
                            raise
                        supported[shape] = False
                if not supported[shape]:
                    return self.original(attn, hidden_states, attention_mask, image_rotary_emb)
            report["groupedAttentionCalls"] += 1
            return attn.to_out[0](result.flatten(2, 3) * torch.sigmoid(attn.to_gate(hidden_states)))

    for block in pipeline.transformer.transformer_blocks:
        attn = block.attn
        if attn.head_dim == 128 and attn.num_heads == 48 and attn.num_kv_heads == 12:
            _replace(stack, attn, "processor", Processor(attn.processor))
    return "sageattention-2.2" if use_sage else "pytorch-sdpa"


def generate(pipeline, args, control, observation):
    import torch
    report = dict(textTokens=[], conditioningHits=0, conditioningMisses=0, textEncoderBlocks=0,
                  fusionHits=0, projectionHits=0, rotaryHits=0, groupedAttentionCalls=0, cudnnGqaCalls=0)
    original_encode = pipeline.encode_prompt
    transformer = pipeline.transformer
    sampling = False
    positions = {}

    def encode(*, prompt, max_sequence_length, **kwargs):
        # Upstream pads between the user prompt and assistant suffix. Its
        # mRoPE positions count only valid tokens, and masked keys contribute
        # nothing. Preserve the same tokens/truncation and omit those PAD lanes.
        text = prompt if isinstance(prompt, str) else prompt[0]
        prefix = pipeline.prompt_template_encode_start_idx
        suffix = pipeline.prompt_template_encode_num_suffix_tokens
        ids = pipeline.tokenizer(pipeline.prompt_template_encode_prefix + text, truncation=True,
                                 max_length=max_sequence_length + prefix - suffix).input_ids
        length = max(1, len(ids) - prefix + suffix)
        features, mask = original_encode(prompt=text, max_sequence_length=length, **kwargs)
        report["textTokens"].append(features.shape[1])
        return features, None if bool(mask.all()) else mask

    def before_transformer(_module, inputs, kwargs):
        nonlocal sampling
        control.check()
        if not sampling:
            sampling = True
            control.stage("sampling")
        # RAW invokes the unconditional branch with the positive branch's
        # position grid. Each compacted branch needs its own zero text rows
        # followed by exactly the same image coordinates.
        text_len = kwargs["encoder_hidden_states"].shape[1]
        image_len = kwargs["hidden_states"].shape[1]
        grid = kwargs["position_ids"]
        if grid.shape[0] != text_len + image_len:
            if text_len not in positions:
                positions[text_len] = torch.cat((grid.new_zeros((text_len, 3)), grid[-image_len:]))
            kwargs["position_ids"] = positions[text_len]
        return inputs, kwargs

    vae_events = []
    with ExitStack() as stack:
        grouped_backend = _grouped_attention(stack, pipeline, report)
        _tap_text_encoder(stack, pipeline, report)
        _replace(stack, pipeline, "encode_prompt", encode)
        handle = transformer.register_forward_pre_hook(before_transformer, with_kwargs=True, prepend=True)
        stack.callback(handle.remove)
        placement = pipeline._huiyu_memory
        wake = getattr(placement, "wake_fusion", None)
        fusion_lanes = 0
        def fused(count):
            nonlocal fusion_lanes
            fusion_lanes = count
        def projected(count):
            if wake is not None and count == fusion_lanes == (2 if pipeline.do_classifier_free_guidance else 1):
                placement.sleep_fusion()
        _reuse_forward(stack, transformer.text_fusion, report, "fusionHits", wake=wake, ready=fused)
        _reuse_forward(stack, transformer.txt_in, report, "projectionHits", wake=wake, ready=projected)
        _reuse_forward(stack, transformer.rotary_emb, report, "rotaryHits")
        for block in transformer.transformer_blocks:
            handle = block.register_forward_pre_hook(lambda *_: control.check())
            stack.callback(handle.remove)
        # Krea and Anima use the same Qwen single-frame VAE. The public
        # decode method retains its placement hooks; tiled decode is retried
        # only on accelerator OOM and each tile remains cancellable.
        _replace(stack, pipeline.vae, "_huiyu_vae_events", vae_events)
        stack.enter_context(load_sibling("anima_vae")._single_frame(
            pipeline.vae, "decode", load_sibling("anima_tiling"), check=control.check,
            decode_tile=getattr(pipeline._huiyu_memory, "decode_tile", None)))
        output = pipeline(**args)
    report.update(pipeline._huiyu_krea_conditioning)
    if report["groupedAttentionCalls"]:
        observation["attentionBackend"] = grouped_backend
    memory = pipeline._huiyu_memory.report
    report["prefetchHits"] = memory.get("prefetchHits", 0)
    transport = getattr(pipeline._huiyu_memory, "transport", None)
    if transport is not None:
        report.update(weightTransport="fp8-to-bf16", transferredMatrices=transport.report["uploads"],
                      packedTransferBytes=transport.report["packedBytes"], packedBlockMatrices=transport.block_count,
                      directPackedMatrices=transport.packed_count,
                      fp8GemmCalls=transport.report["fp8GemmCalls"], fp8InputHits=transport.report["fp8InputHits"],
                      fusedInputPacks=transport.report["fusedInputPacks"])
    report["textPackedMatrices"] = getattr(pipeline.text_encoder, "_huiyu_packed_text_layers", 0)
    for field in ("warmBlocks", "residentBlocks", "textPackedTransferBytes", "fusionOffloadedBytes",
                  "preloadedPackedBytes", "preloadMs"):
        if field in memory:
            report[field] = memory[field]
    for field in ("minimumAvailableCommitBytes", "reclaimedWeightBytes", "lowCommitStreamGroups"):
        if field in memory:
            observation["memoryScheduling"][field] = memory[field]
    if vae_events:
        report.update(vaeDecode=vae_events[-1]["mode"], vaeTiles=vae_events[-1]["tileCount"])
    observation["kreaExecution"] = report
    return output
