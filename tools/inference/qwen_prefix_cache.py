"""Lossless Qwen 2.1 prefix placement and bounded same-branch prefetch.

Inspired by ComfyUI's Qwen/PoseBranchCache placement and staging mechanism.
Uses the pinned Diffusers cache interface, never ComfyUI code or quantization.
One task owns all buffers/streams; no prefetch crosses a condition branch.
"""
from contextlib import contextmanager
from functools import wraps


def bind_target_forward(model, *, packed_manga):
    """Use the layout observed at prefill to schedule only live token work on cached steps."""
    import torch
    original = model.forward

    def capture(_block, _args, kwargs):
        prefix = kwargs.get("cache_write_slice")
        cache = getattr(kwargs.get("layer_cache"), "cache", None)
        if kwargs.get("kv_cache_mode") != "extract" or prefix is None or getattr(cache, "target_inputs", None) is None:
            return
        rotation = kwargs["rotary_emb"][prefix.stop:]
        mask = kwargs["target_token_mask"][prefix.stop:]
        valid = kwargs.get("key_valid")
        # The worker appends the target as one contiguous suffix. Retain only
        # its coordinates, without pinning the (possibly multi-image) prefix.
        if rotation.nbytes <= 16 * 1024**2 and mask.numel() and bool(mask.all()):
            cache.target_layout = (rotation.clone(), mask.clone(), None if valid is None else valid[:, None, None, :])

    model.transformer_blocks[0].register_forward_pre_hook(capture, with_kwargs=True)

    @wraps(original)
    def forward(*args, **kwargs):
        cache = kwargs.get("kv_cache")
        mode = kwargs.get("kv_cache_mode")
        if mode == "extract" and hasattr(cache, "target_layout"):
            cache.target_layout = cache.target_inputs = None
        if (args or not hasattr(cache, "target_layout") or not torch.is_inference_mode_enabled()
                or kwargs.get("return_dict", True) or kwargs.get("attention_kwargs") or getattr(model, "peft_config", None)):
            return original(*args, **kwargs)
        # A pipeline-owned CFG lane keeps these exact objects for all steps.
        # Each new task and each positive/negative branch owns a separate cache.
        image_mask, text_mask = kwargs["img_mask"], kwargs.get("encoder_hidden_states_mask")
        embeds, shapes = kwargs["encoder_hidden_states"], kwargs["img_shapes"]
        latents = kwargs["hidden_states"]
        layout = (tuple(tuple(row) for row in shapes[0]), latents.shape, latents.dtype, latents.device)
        if mode == "extract":
            cache.target_inputs = (image_mask, text_mask, embeds, layout)
            return original(**kwargs)
        if mode != "cached" or cache.target_layout is None:
            return original(**kwargs)
        slots, padding, source, previous_layout = cache.target_inputs
        if image_mask is not slots or text_mask is not padding or embeds is not source or layout != previous_layout:
            return original(**kwargs)
        rotation, target_mask, attention_mask = cache.target_layout
        cache.owner.begin_target()
        # Keep even the input GEMM shape identical for reference edits. The
        # text projection, expanded joint buffer, position grid and scatter
        # are dead after prefill; the blocks read their cached K/V instead.
        x = model.img_in(latents)[:, -rotation.shape[0]:]
        t = kwargs["timestep"].to(x.dtype)
        temb = model.time_text_embed(torch.cat((t, t.new_zeros(1))), x)
        modulation = model.modulation(temb)
        if not packed_manga:
            modulation = modulation[:-1]  # Only the target timestep reaches these blocks.
        for i, block in enumerate(model.transformer_blocks):
            x = block(hidden_states=x, modulation=modulation, rotary_emb=rotation, attention_mask=attention_mask,
                      layer_cache=cache.get_layer(i), kv_cache_mode="cached")
        result = model.proj_out(model.norm_out(x, temb, target_mask))
        cache.owner.stats["targetOnlyPasses"] += 1
        return (result,)

    model.forward = forward


def use_target_modulation(block, args, kwargs):
    # In the pinned BF16 model a cached pass slices off the complete prefix
    # before the first block. Every remaining token uses the sampled timestep.
    # Broadcasting its row avoids four sequence-sized torch.where results per
    # block. Prefill still selects the real vs. zero timestep for every token.
    if kwargs.get("kv_cache_mode") == "cached" and kwargs.get("target_token_mask") is not None:
        kwargs["modulation"] = kwargs["modulation"][:-1]
        kwargs["target_token_mask"] = None
        return args, kwargs


class Prefix:
    SLOT_BYTES = 256 * 1024**2

    def __init__(self, memory, branches, control, directory, *, allow_partial=False):
        from huiyu_worker_lifecycle import load_sibling
        self.control, self.branches = control, branches
        self.memory = memory
        self.directory = directory
        self.available_commit = load_sibling("video_memory").available_commit
        self.target_started = False
        self.allow_partial = allow_partial
        self.reserve = max(512 * 1024**2, memory.observation().get("activationReserveBytes", 0))
        self.caches, self.pending, self.slots = [], {}, [None, None]
        self.capacities = {}
        self.stream, self.device = None, None
        self.next_slot = 0
        self.pin_disabled = False
        self.retired = False
        self.stats = dict(schemaVersion=1, policy="budgeted-lossless-v1", gpuLayers=0, cpuLayers=0,
            gpuBytes=0, cpuBytes=0, pinnedBytes=0, stagingBytes=0, asyncLoads=0,
            prefetchLoads=0, prefetchHits=0, synchronousLoads=0, pinFallback=False,
            performanceVerified=False, targetOnlyPasses=0, promotedWeightBytes=0, fileBackedBytes=0)

    def begin_target(self):
        if self.target_started:
            return
        self.target_started = True
        promote = getattr(self.memory, "retain_for_target", None)
        if promote is None or len(self.caches) != self.branches:
            return
        largest = staging = 0
        for cache in self.caches:
            if cache.target_layout is None or cache.target_layout[2] is not None:
                return
            for layer in cache.layer_caches:
                if layer.key is None:
                    return
                size = layer.key.nbytes + layer.value.nbytes
                largest = max(largest, size)
                if layer.key.device.type == "cpu" and size <= self.SLOT_BYTES:
                    staging = max(staging, size)
        self.stats["promotedWeightBytes"] = promote(largest, staging)

    def file_slot(self, layer, key, value):
        """Keep immutable CPU KV in a shared temporary mapping when private commit is scarce."""
        cache = layer.cache
        if cache.file_unavailable or key.dtype != value.dtype:
            return None
        count = key.numel() + value.numel()
        if not count:
            return None
        commit = self.available_commit()
        if commit is None:
            return None
        layers = len(cache.layer_caches)
        remaining = layers - layer.index
        size = count * key.element_size()
        # Both guidance lanes exist before prefill. Recheck the unfilled
        # demand after every layer so only the shortfall uses file backing.
        future_lanes = len(self.caches) - self.caches.index(cache) - 1
        demand = (remaining + future_lanes * layers) * size
        shortfall = demand + self.reserve + 2 * 1024**3 - commit
        if shortfall <= 0:
            return None
        if cache.file_buffer is None or layer.index >= cache.file_first + len(cache.file_buffer):
            import mmap
            import shutil
            import tempfile
            import torch
            try:
                # Size a new extent for the shortfall, in whole layer pairs.
                # Earlier extents remain owned by the layers that use them.
                slots = min(remaining, (shortfall + size - 1) // size, max(1, 1024**3 // size),
                            shutil.disk_usage(self.directory).free // size)
                if slots == 0:
                    cache.file_unavailable = True
                    return None
                capacity = slots * size
                # An OS delete-on-close file also retires on worker termination.
                # ACCESS_WRITE is shared/file-backed; copy-on-write would still
                # charge the Windows commit limit for the entire prefix.
                with tempfile.TemporaryFile(dir=self.directory, prefix="huiyu-qwen-kv-") as file:
                    file.truncate(capacity)
                    mapping = mmap.mmap(file.fileno(), capacity, access=mmap.ACCESS_WRITE)
            except (OSError, MemoryError):
                cache.file_unavailable = True
                return None  # Ordinary bounded staging still works without a scratch file.
            cache.file_buffer = torch.frombuffer(mapping, dtype=key.dtype).view(slots, count)
            cache.file_first = layer.index
        offset = layer.index - cache.file_first
        if (not 0 <= offset < len(cache.file_buffer) or cache.file_buffer.shape[1] != count
                or cache.file_buffer.dtype != key.dtype):
            return None
        return cache.file_buffer[offset]

    def store(self, layer, key, value):
        import torch
        self.control.check()
        self.device = key.device
        size = (key.numel() * key.element_size() + value.numel() * value.element_size())
        free, _ = torch.cuda.mem_get_info(key.device)
        if layer.cache.gpu is None:
            # Estimate both CFG lanes before retaining the first layer, with
            # room for activations and temporary block uploads as in Comfy.
            estimate = size * len(layer.cache.layer_caches) * self.branches
            layer.cache.gpu = free > self.reserve + 4 * estimate
        headroom = 3 if self.allow_partial else 2
        gpu = (layer.cache.gpu or self.allow_partial) and free > self.reserve + headroom * size
        slot = None if gpu else self.file_slot(layer, key, value)
        if slot is not None:
            split = key.numel()
            layer.key = slot[:split].view_as(key).copy_(key)
            layer.value = slot[split:].view_as(value).copy_(value)
            self.stats["fileBackedBytes"] += size
        else:
            if not gpu and layer.cache.file_unavailable:
                commit = self.available_commit()
                if commit is not None and commit < size + 2 * 1024**3:
                    from huiyu_worker_lifecycle import load_sibling
                    raise load_sibling("adapter_contract").AdapterError("NATIVE_OUT_OF_MEMORY",
                        f"Qwen 临时键值缓存无法写入输出盘，Windows 可提交余量为 {commit // 2**20} MiB。"
                        "请释放输出盘空间或关闭占用内存的程序后重试。")
            device = key.device if gpu else "cpu"
            # The BF16 processor passes private prefix clones. The packed manga
            # processor can supply views into a full projection, so copy those.
            layer.key = key.detach().to(device=device, copy=self.allow_partial)
            layer.value = value.detach().to(device=device, copy=self.allow_partial)
        self.stats["gpuLayers" if gpu else "cpuLayers"] += 1
        self.stats["gpuBytes" if gpu else "cpuBytes"] += size
        self.control.check()

    def upload(self, layer, *, ahead):
        import torch
        if (layer in self.pending or layer.key is None or layer.key.device.type != "cpu" or self.pin_disabled
                or layer.key.dtype != layer.value.dtype):
            return
        count = layer.key.numel() + layer.value.numel()
        size = count * layer.key.element_size()
        if size > self.SLOT_BYTES or len(self.pending) >= 2:
            return
        # All lanes prefill before cached sampling starts. Size each pair for
        # the largest supported lane, avoiding resize churn at CFG boundaries.
        if layer.key.dtype not in self.capacities:
            self.capacities[layer.key.dtype] = max((item.key.numel() + item.value.numel()
                for cache in self.caches for item in cache.layer_caches
                if item.key is not None and item.key.device.type == "cpu"
                and item.key.dtype == item.value.dtype == layer.key.dtype
                and (item.key.numel() + item.value.numel()) * item.key.element_size() <= self.SLOT_BYTES), default=count)
        capacity = self.capacities[layer.key.dtype]
        staging_size = capacity * layer.key.element_size()
        free, _ = torch.cuda.mem_get_info(self.device)
        # Keep at most one layer ahead, and decline speculative allocation when
        # the current block's activations/uploads need the remaining headroom.
        if free < 512 * 1024**2 + 3 * staging_size:
            return
        self.control.check()
        if self.stream is None:
            self.stream = torch.cuda.Stream(device=self.device)
        index = self.next_slot % 2
        self.next_slot += 1
        slot = self.slots[index]
        if slot is not None:
            slot["event"].synchronize()  # Its previous H2D must stop reading host storage.
        if slot is None or slot["pin"].dtype != layer.key.dtype or slot["pin"].numel() < capacity:
            try:
                pin = torch.empty(capacity, dtype=layer.key.dtype, device="cpu", pin_memory=True)
            except RuntimeError as error:
                # A failed bounded host-pinned allocation can use the existing
                # synchronous pageable copy. Device/assert failures still escape.
                message = str(error).lower()
                if not any(part in message for part in ("out of memory", "can't allocate memory", "not enough memory")):
                    raise
                if "device-side assert" in message:
                    raise
                self.pin_disabled = self.stats["pinFallback"] = True
                if self.stream is not None:
                    self.stream.synchronize()
                self.pending.clear()
                self.slots = [None, None]
                return
            slot = dict(pin=pin, gpu=None, event=torch.cuda.Event())
            self.slots[index] = slot
        host = slot["pin"][:count]
        half = layer.key.numel()
        host[:half].view_as(layer.key).copy_(layer.key)
        host[half:].view_as(layer.value).copy_(layer.value)
        current = torch.cuda.current_stream(self.device)
        self.stream.wait_stream(current)
        with torch.cuda.stream(self.stream):
            # The wait also protects reads of a persistent GPU staging slot by
            # its previous consumer. Reuse two buffers instead of allocating a
            # new full K/V pair for every block of every sampling step.
            if slot["gpu"] is None:
                slot["gpu"] = torch.empty_like(slot["pin"], device=self.device)
            target = slot["gpu"][:count]
            target.copy_(host, non_blocking=True)
            slot["event"].record(self.stream)
        pair = (target[:half].view_as(layer.key), target[half:].view_as(layer.value))
        self.pending[layer] = (pair, slot["event"], ahead)
        self.stats["asyncLoads"] += 1
        self.stats["prefetchLoads"] += int(ahead)
        self.stats["pinnedBytes"] = max(self.stats["pinnedBytes"], sum(
            row["pin"].numel() * row["pin"].element_size() for row in self.slots if row is not None))
        self.stats["stagingBytes"] = max(self.stats["stagingBytes"], sum(
            row["gpu"].numel() * row["gpu"].element_size() for row in self.slots if row is not None and row["gpu"] is not None))

    def get(self, layer):
        import torch
        self.control.check()
        if layer.key.device.type == "cuda":
            return layer.key, layer.value
        self.upload(layer, ahead=False)
        pending = self.pending.pop(layer, None)
        if pending is None:
            self.stats["synchronousLoads"] += 1
            pair = layer.key.to(self.device), layer.value.to(self.device)
        else:
            pair, event, ahead = pending
            current = torch.cuda.current_stream(self.device)
            current.wait_event(event)
            for tensor in pair:
                tensor.record_stream(current)
            self.stats["prefetchHits"] += int(ahead)
        following = layer.index + 1
        if following < len(layer.cache.layer_caches):
            self.upload(layer.cache.layer_caches[following], ahead=True)
        self.control.check()
        return pair

    def retire(self):
        if self.retired:
            return
        self.retired = True
        # Wait only for owned copies. record_stream protects outstanding compute
        # readers while allocator ownership of GPU staging is relinquished.
        if self.stream is not None:
            self.stream.synchronize()
        self.pending.clear()
        self.capacities.clear()
        self.slots = [None, None]
        for cache in self.caches:
            cache.target_layout = cache.target_inputs = cache.file_buffer = None
            for layer in cache.layer_caches:
                layer.key = layer.value = None
        self.caches.clear()
        self.stream = None

    def device_name(self):
        if self.stats["gpuLayers"]:
            return "mixed" if self.stats["cpuLayers"] else "cuda"
        return "cpu" if self.stats["cpuLayers"] else "none"


@contextmanager
def context(enabled, pipeline, branches, control, observation, *, directory, allow_partial=False):
    if not enabled:
        yield None
        return
    from diffusers.pipelines.qwenimage21 import pipeline_qwenimage21 as implementation
    original = implementation.QwenImage21KVCache
    owner = Prefix(pipeline._huiyu_memory, branches, control, directory, allow_partial=allow_partial)

    class Layer:
        def __init__(self, cache, index):
            self.cache, self.index = cache, index
            self.key = self.value = None

        def store(self, key, value):
            owner.store(self, key, value)

        def get(self):
            return owner.get(self)

    class Cache(original):
        def __init__(self, count):
            self.gpu = None
            self.target_layout = self.target_inputs = None
            self.owner = owner
            self.file_buffer, self.file_first, self.file_unavailable = None, 0, False
            self.layer_caches = [Layer(self, index) for index in range(count)]
            owner.caches.append(self)

    implementation.QwenImage21KVCache = Cache
    try:
        yield owner
    finally:
        implementation.QwenImage21KVCache = original
        try:
            owner.retire()
        finally:
            observation["prefixCacheDevice"] = owner.device_name()
            owner.stats["referenceLatentHits"] = getattr(pipeline, "_huiyu_reference_hits", 0)
            observation["qwenPrefixCache"] = dict(owner.stats)
