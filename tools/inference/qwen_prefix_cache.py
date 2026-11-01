"""Lossless Qwen 2.1 prefix placement and bounded same-branch prefetch.

Inspired by ComfyUI's Qwen/PoseBranchCache placement and staging mechanism.
Uses the pinned Diffusers cache interface, never ComfyUI code or quantization.
One task owns all buffers/streams; no prefetch crosses a condition branch.
"""
from contextlib import contextmanager


class Prefix:
    SLOT_BYTES = 256 * 1024**2

    def __init__(self, memory, branches, control):
        self.control, self.branches = control, branches
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
            performanceVerified=False)

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
        gpu = layer.cache.gpu and free > self.reserve + 2 * size
        device = key.device if gpu else "cpu"
        # Prefix slices may alias the full joint sequence: always detach/copy.
        layer.key = key.detach().to(device=device, copy=True)
        layer.value = value.detach().to(device=device, copy=True)
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
            for layer in cache.layer_caches:
                layer.key = layer.value = None
        self.caches.clear()
        self.stream = None

    def device_name(self):
        if self.stats["gpuLayers"]:
            return "mixed" if self.stats["cpuLayers"] else "cuda"
        return "cpu" if self.stats["cpuLayers"] else "none"


@contextmanager
def context(enabled, pipeline, branches, control, observation):
    if not enabled:
        yield None
        return
    from diffusers.pipelines.qwenimage21 import pipeline_qwenimage21 as implementation
    original = implementation.QwenImage21KVCache
    owner = Prefix(pipeline._huiyu_memory, branches, control)

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
            observation["qwenPrefixCache"] = dict(owner.stats)
