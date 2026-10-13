"""Optional Linear LoRA fusion with protected source or CPU base restoration.

PEFT 0.19 merge/unmerge rounds BF16 additions/subtractions. Keep independent
original weights instead of subtracting deltas. Base-preserving adapters can
restore from leased safetensors via bounded readinto; other callers retain CPU
snapshots. No model or adapter files are modified. OS file caching is separate
from the tensor-buffer observations below.
https://github.com/huggingface/peft/blob/v0.19.0/src/peft/tuners/lora/layer.py
"""
import json
import os
from pathlib import Path
import struct
import time
from contextlib import nullcontext


MAX_BUFFER_BYTES = 32 * 1024 * 1024
MAX_HEADER_BYTES = 8 * 1024 * 1024


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate safetensors source header key")
        result[key] = value
    return result


def _source_offsets(path, records):
    """Read bounded offsets only after safetensors validated these tensors."""
    with path.open("rb", buffering=0) as raw:
        size = os.fstat(raw.fileno()).st_size
        prefix = raw.read(8)
        if len(prefix) != 8:
            raise ValueError("Truncated safetensors source header")
        length = struct.unpack("<Q", prefix)[0]
        if not 0 < length <= min(MAX_HEADER_BYTES, size - 8):
            raise ValueError("Safetensors source header exceeds its bounded file range")
        encoded = raw.read(length)
        if len(encoded) != length:
            raise ValueError("Truncated safetensors source header")
        header = json.loads(encoded, object_pairs_hook=_unique_object)
    offsets = {}
    for record in records:
        entry = header.get(record["key"]) if isinstance(header, dict) else None
        if (not isinstance(entry, dict) or entry.get("shape") != list(record["shape"])
                or entry.get("dtype") != record["dtype"]):
            raise ValueError("Safetensors source header differs from validated tensor metadata")
        span = entry.get("data_offsets")
        if (not isinstance(span, list) or len(span) != 2 or any(type(value) is not int for value in span)
                or not 0 <= span[0] < span[1] <= size - 8 - length
                or span[1] - span[0] != record["bytes"]):
            raise ValueError("Safetensors source tensor offsets exceed their validated byte range")
        offsets[record["key"]] = 8 + length + span[0]
    return offsets


def _base_preserving(model):
    # Same supported initializers as the resident's adapter-unload contract.
    for config in getattr(model, "peft_config", {}).values():
        if (config.init_lora_weights not in (True, False, "gaussian", "eva", "orthogonal")
                or any(getattr(config, name, None) for name in
                       ("use_qalora", "use_bdlora", "arrow_config", "ensure_weight_tying", "megatron_config"))):
            return False
    return True


class LoraFusionState:
    def __init__(self):
        self._originals = {}
        self._sources = {}
        self._binding = None
        self._merged = []
        self.bytes = 0
        self.source_bytes = 0
        self.buffer_peak_bytes = 0
        self.restored_source_bytes = 0

    def bind_source(self, root, model_sha256, valid_callback):
        """Bind the exact loaded base while its external identity lease lives.

        The caller owns and verifies the SHA/lease; this helper never substitutes
        path/mtime for byte identity. Rebinding a merged model would lose its
        restoration source and is forbidden. clear() also clears this binding.
        """
        binding = (Path(root).resolve(strict=True), model_sha256, valid_callback)
        if not isinstance(model_sha256, str) or not model_sha256 or not callable(valid_callback):
            raise ValueError("Source restoration requires a model SHA and live lease callback")
        if self._binding is not None and binding[:2] != self._binding[:2]:
            if self._merged:
                raise ValueError("Restore the merged base before changing its source identity")
            self.clear()
        elif self._binding is None and self._merged:
            raise ValueError("Bind the source before fusing the base")
        self._binding = binding
        self._require_source()

    def _require_source(self):
        if self._binding is None or not self._binding[2]():
            raise ValueError("Base source identity lease is no longer valid; discard this resident")

    def _inside_root(self, path):
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(self._binding[0]):
            raise ValueError("Fusion source must stay inside the leased model root")
        return resolved

    def _describe_sources(self, targets):
        """Resolve new records once per component, then validate each shard once."""
        self._require_source()
        mappings, records = {}, []
        for component, module_name, weight in targets:
            previous = self._sources.get(id(weight))
            if previous is not None:
                # Keep published restoration metadata untouched until the full
                # new fusion set has passed the live-lease validation below.
                records.append(dict(previous))
                continue
            folder = self._binding[0] / component
            key = module_name + ".weight"
            if component not in mappings:
                self._require_source()
                index = folder / "diffusion_pytorch_model.safetensors.index.json"
                if index.is_file():
                    mapping = json.loads(self._inside_root(index).read_text(encoding="utf-8"))["weight_map"]
                    if not isinstance(mapping, dict):
                        raise ValueError(f"Invalid fusion source shard index for {component}")
                    mappings[component] = mapping
                else:
                    mappings[component] = None
                self._require_source()
            mapping = mappings[component]
            filename = mapping.get(key) if mapping is not None else "diffusion_pytorch_model.safetensors"
            if (not isinstance(filename, str) or Path(filename).name != filename
                    or not filename.endswith(".safetensors")):
                raise ValueError(f"Missing or unsafe fusion source shard for {component}.{key}")
            records.append(dict(weight=weight, path=self._inside_root(folder / filename),
                                key=key, sha256=self._binding[1]))
        # Shared weights can have several source keys. Validate every target
        # before selecting the same final restoration record as the old loop.
        self._validate_sources(records, describe=True)
        return {id(record["weight"]): record for record in records}

    def _validate_sources(self, records, *, describe=False):
        from safetensors import safe_open
        self._require_source()
        groups = {}
        for record in records:
            groups.setdefault(record["path"], []).append(record)
        for path in sorted(groups):
            self._require_source()
            self._inside_root(path)
            selected = groups[path]
            with safe_open(str(path), framework="pt", device="cpu", backend="pread") as source:
                for record in selected:
                    view = source.get_slice(record["key"])
                    shape, dtype = tuple(view.get_shape()), view.get_dtype()
                    if describe and "shape" not in record:
                        weight = record["weight"]
                        if shape != tuple(weight.shape):
                            raise ValueError(f"Fusion source shape differs from loaded {record['key']}")
                        sizes = {"F16": 2, "BF16": 2, "F32": 4}
                        if dtype not in sizes or str(weight.dtype) not in ("torch.float16", "torch.bfloat16", "torch.float32"):
                            raise ValueError(f"Unsupported fusion source dtype for {record['key']}")
                        row_bytes = shape[1] * sizes[dtype]
                        cast = {"F16": "torch.float16", "BF16": "torch.bfloat16", "F32": "torch.float32"}[dtype] != str(weight.dtype)
                        live_row_bytes = row_bytes + (shape[1] * weight.element_size() if cast else 0)
                        if live_row_bytes > MAX_BUFFER_BYTES:
                            raise ValueError("A fusion source row exceeds the bounded restore buffer")
                        record.update(shape=shape, dtype=dtype, target_dtype=weight.dtype,
                                      rows=max(1, MAX_BUFFER_BYTES // live_row_bytes), row_bytes=row_bytes,
                                      bytes=shape[0] * row_bytes)
                    if (record["sha256"] != self._binding[1]
                            or shape != record["shape"] or dtype != record["dtype"]
                            or tuple(record["weight"].shape) != record["shape"]
                            or record["weight"].dtype != record["target_dtype"]):
                        raise ValueError("Fusion source tensor description changed; discard this resident")
            self._require_source()
            offsets = _source_offsets(path, selected)
            self._require_source()
            for record in selected:
                offset = offsets[record["key"]]
                if "offset" in record and record["offset"] != offset:
                    raise ValueError("Fusion source tensor offset changed; discard this resident")
                record["offset"] = offset
        self._require_source()

    def _restore_source_group(self, records):
        """Overlap protected reads and same-dtype CUDA copies within 32 MiB."""
        import torch
        first = records[0]
        source_dtype = {"F16": torch.float16, "BF16": torch.bfloat16, "F32": torch.float32}[first["dtype"]]
        source_size = first["row_bytes"] // first["shape"][1]
        cast_size = first["weight"].element_size() if first["target_dtype"] != source_dtype else 0
        # Count the entire reusable allocation, not just the current view. A cast
        # has a second live CPU tensor, so reserve room for it before allocation.
        capacity = min(MAX_BUFFER_BYTES * source_size // (source_size + cast_size),
                       max(min(record["rows"], record["shape"][0]) * record["row_bytes"] for record in records))
        # CPU/cast/large-row copies retain the original serial conversion budget.
        pinned = first["weight"].device.type == "cuda" and cast_size == 0
        pipelined = (pinned and max(record["row_bytes"] for record in records) <= MAX_BUFFER_BYTES // 2
                     and sum(record["bytes"] for record in records) > MAX_BUFFER_BYTES // 2)
        if pipelined:
            capacity = min(capacity, MAX_BUFFER_BYTES // 2)
        stream = torch.cuda.current_stream(first["weight"].device) if pipelined else None
        buffers, views, events = [], [], []
        block = converted = writable = buffer = None
        copied = calls = 0
        try:
            # Allocation belongs to cleanup too: a second-slot failure must not
            # retain the first pinned allocation or its host-cache entry.
            for _ in range(2 if pipelined else 1):
                buffers.append(torch.empty(capacity, dtype=torch.uint8, device="cpu", pin_memory=pinned))
                views.append(memoryview(buffers[-1].numpy()))
                events.append(None)
            with torch.cuda.stream(stream) if stream is not None else nullcontext():
                for path in sorted({record["path"] for record in records}):
                    self._require_source()
                    with path.open("rb", buffering=0) as raw:
                        for record in records:
                            if record["path"] != path:
                                continue
                            rows = capacity // record["row_bytes"]
                            for start in range(0, record["shape"][0], rows):
                                self._require_source()
                                slot = calls % len(buffers)
                                if events[slot] is not None:
                                    events[slot].synchronize()
                                buffer, writable = buffers[slot], views[slot]
                                stop = min(start + rows, record["shape"][0])
                                byte_count = (stop - start) * record["row_bytes"]
                                raw.seek(record["offset"] + start * record["row_bytes"])
                                received = 0
                                while received < byte_count:
                                    self._require_source()
                                    count = raw.readinto(writable[received:byte_count])
                                    if not count:
                                        raise ValueError("Truncated protected fusion source tensor")
                                    received += count
                                self._require_source()
                                block = buffer[:byte_count].view(source_dtype).reshape(stop - start, record["shape"][1])
                                converted = block.to(dtype=record["target_dtype"])
                                live_bytes = capacity * len(buffers) + (converted.numel() * converted.element_size() if converted is not block else 0)
                                self.buffer_peak_bytes = max(self.buffer_peak_bytes, live_bytes)
                                self._require_source()
                                record["weight"][start:stop].copy_(converted, non_blocking=pipelined)
                                if pipelined:
                                    if events[slot] is None:
                                        events[slot] = torch.cuda.Event()
                                    events[slot].record(stream)
                                copied += byte_count
                                calls += 1
                                block = converted = None
        finally:
            try:
                # A copy may be queued even if Event creation/recording failed.
                # Drain the actual copy stream before retiring any CPU source.
                if stream is not None:
                    stream.synchronize()
            finally:
                block = converted = writable = buffer = None
                for view in views:
                    view.release()
                views.clear()
                buffers.clear()
                if pinned:
                    torch._C._host_emptyCache()
        self.restored_source_bytes += copied
        return dict(strategy="pinned-pipeline" if pipelined else "serial", copyCalls=calls)

    def fuse(self, components, *, stage_device=None):
        import torch
        from peft.tuners.lora.layer import Linear
        from peft.tuners.tuners_utils import BaseTunerLayer

        if self._merged:
            raise ValueError("Restore the current LoRA fusion before changing it")
        targets = []
        for name in ("transformer", "text_conditioner"):
            source_eligible = self._binding is not None and _base_preserving(components[name])
            for module_name, layer in components[name].named_modules():
                if not isinstance(layer, BaseTunerLayer):
                    continue
                active = [adapter for adapter in layer.active_adapters if adapter in layer.lora_A]
                if not active:
                    continue
                if (not isinstance(layer, Linear) or not isinstance(layer.get_base_layer(), torch.nn.Linear)
                        or layer.merged or layer.disable_adapters
                        or any(adapter in layer.lora_variant or layer.lora_bias[adapter] for adapter in active)):
                    raise ValueError("Resident fusion requires unmerged active standard Linear LoRAs without bias")
                targets.append((layer, active, name, module_name, source_eligible))

        with torch.no_grad():
            # Capture all originals before any layer is merged. Strength changes
            # reuse snapshots; group changes retire them before loading because
            # PEFT initializers can themselves change the underlying base.
            originals, source_targets = {}, []
            for layer, _, component, module_name, source_eligible in targets:
                weight = layer.get_base_layer().weight
                if source_eligible:
                    source_targets.append((component, module_name, weight))
                else:
                    originals[id(weight)] = self._originals.get(id(weight)) or (weight, weight.detach().to(device="cpu", copy=True))
            sources = self._describe_sources(source_targets) if source_targets else {}
            self._originals, self._sources = originals, sources
            self.bytes = sum(value.numel() * value.element_size() for _, value in originals.values())
            self.source_bytes = sum(record["bytes"] for record in sources.values())
            self._merged = [target[0] for target in targets]
            try:
                for name in ("transformer", "text_conditioner"):
                    selected = [row for row in targets if row[2] == name]
                    if not selected:
                        continue
                    # Keep CUDA BF16/F16 merge arithmetic in staged mode. CPU
                    # PEFT matmul has a different FP32-upcast path.
                    if stage_device is not None:
                        components[name].to(stage_device)
                    try:
                        for layer, active, *_ in selected:
                            weight = layer.get_base_layer().weight
                            packed = weight.data if getattr(weight, "_huiyu_packed_storage", False) else None
                            layer.merge(safe_merge=True, adapter_names=active)
                            if packed is not None:
                                packed.copy_(weight.data)
                                weight.data = packed
                    finally:
                        if stage_device is not None:
                            components[name].to("cpu")
                            torch.cuda.empty_cache()
            except BaseException:
                self.restore()
                raise

    def restore(self):
        import torch
        started = time.perf_counter()
        records = [self._sources[id(layer.get_base_layer().weight)] for layer in self._merged
                   if id(layer.get_base_layer().weight) in self._sources]
        self.buffer_peak_bytes = self.restored_source_bytes = 0
        if records:
            # Validate the complete source set before modifying any target.
            self._validate_sources(records)
        transfers = []
        with torch.no_grad():
            groups = {}
            for record in records:
                group = (record["dtype"], record["target_dtype"], record["weight"].device)
                groups.setdefault(group, []).append(record)
            for selected in groups.values():
                transfers.append(self._restore_source_group(selected))
            for layer in self._merged:
                weight = layer.get_base_layer().weight
                if id(weight) in self._originals:
                    weight.copy_(self._originals[id(weight)][1])
            if records:
                self._require_source()
            for layer in self._merged:
                # Standard Linear merge only changes weight + this PEFT list.
                # Never invoke unmerge(): it subtracts a rounded/current delta.
                layer.merged_adapters.clear()
        self._merged.clear()
        return dict(wallSeconds=time.perf_counter() - started, sourceBytes=self.restored_source_bytes,
                    snapshotBytes=self.bytes, bufferPeakBytes=self.buffer_peak_bytes,
                    copyCalls=sum(row["copyCalls"] for row in transfers),
                    pipelinedGroups=sum(row["strategy"] == "pinned-pipeline" for row in transfers),
                    serialGroups=sum(row["strategy"] == "serial" for row in transfers))

    def clear(self):
        """Release CPU snapshots when the resident base itself is discarded."""
        self._merged.clear()
        self._originals.clear()
        self._sources.clear()
        self._binding = None
        self.bytes = 0
        self.source_bytes = self.buffer_peak_bytes = self.restored_source_bytes = 0
