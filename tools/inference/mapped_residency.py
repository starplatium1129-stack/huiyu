"""Budgeted GPU retention over immutable CPU/file-backed weights.

Reuse Diffusers' group discovery and hooks. Keep fitting groups on the GPU across
sampling steps; overflow groups restore their original CPU views, never copy GPU
weights to new RAM or serialize them to a second checkpoint.
"""
from huiyu_worker_lifecycle import load_sibling

memory = load_sibling("native_memory")


def activation_reserve(pixels, image_conditioned):
    return max((2 if image_conditioned else 1) * 1024**3,
               512 * 1024**2 + pixels * (1024 if image_conditioned else 512))


class Residency(memory.Residency):
    def __init__(self, components, policy, pixels, *, image_conditioned, decode_pixels):
        self.records, self.entry_hooks, self.active = [], [], None
        self.readers, self.staging, self.staging_views = {}, None, None
        self.copy_events, self.copy_active, self.copy_index = [], [False, False], 0
        self.control = None
        self.block_reserves = {}
        self.decode_reserve = max(1024**3, decode_pixels * 1536)
        super().__init__(components, policy, activation_reserve=activation_reserve(pixels, image_conditioned))
        self.report["strategy"] = "mapped-retained-offload-v1"

    def add(self, name, module):
        import torch
        if self.policy == "resident" or not isinstance(module, torch.nn.Module):
            return super().add(name, module)
        self.modules[name] = module
        size = memory.tensor_bytes(module)
        row = dict(name=name, mode="component", weightBytes=size)
        self.report["components"].append(row)
        if name not in ("text_encoder", "transformer"):
            # VAE encode/decode bypasses forward; enter at its actual submodules.
            for child in (getattr(module, "encoder", None), getattr(module, "decoder", None)):
                if isinstance(child, torch.nn.Module):
                    self.entry_hooks.append(child.register_forward_pre_hook(
                        lambda *_args, name=name: self.enter(name)))
            self.manager.add(name, module)
            return
        from diffusers.hooks.group_offloading import apply_group_offloading
        ancestors, blocks, remainder = memory.block_layout(module)
        if name == "text_encoder":
            ancestors.add("embed_tokens")
        largest = max((memory.tensor_bytes(block) for block in blocks), default=0)
        self.block_reserves[name] = largest
        budget = self.report["weightBudgetBytes"]
        mode = "block_level" if blocks and largest + remainder <= budget else "leaf_level"
        self.grouped.append(module)
        apply_group_offloading(module, onload_device=torch.device("cuda:0"),
            offload_device=torch.device("cpu"), offload_type=mode,
            num_blocks_per_group=1 if mode == "block_level" else None,
            block_modules=sorted(ancestors), use_stream=False, non_blocking=False)
        seen, available = set(), max(0, budget - largest)
        # Root/ancestor groups can hold weights needed while a child computes;
        # reserve them before choosing which transformer blocks stay resident.
        groups = []
        for child in module.modules():
            registry = getattr(child, "_diffusers_hook", None)
            hook = registry.get_hook("group_offloading") if registry is not None else None
            if hook is not None and id(hook.group) not in seen:
                seen.add(id(hook.group))
                groups.append(hook.group)
        live = {id(tensor) for tensor in (*module.parameters(), *module.buffers())}
        vision = getattr(getattr(module, "model", module), "visual", None) if name == "text_encoder" else None
        vision_tensors = ({id(tensor) for tensor in (*vision.parameters(), *vision.buffers())}
                          if isinstance(vision, torch.nn.Module) else set())
        for group in groups:
            tensors = {tensor for child in group.modules for tensor in (*child.parameters(), *child.buffers())}
            tensors.update(group.parameters)
            tensors.update(group.buffers)
            tensors = {tensor for tensor in tensors if id(tensor) in live}
            # Hook installation calls .to(cpu); MOSS regenerates its nonpersistent
            # RoPE bands there. Capture the resulting tensors, not stale buffers.
            original = {tensor: tensor.detach() for tensor in tensors}
            amount = sum(source.numel() * source.element_size() for source in original.values())
            keep = size <= budget or amount <= available
            if keep:
                available -= amount
            offloaded = {tensor: (torch.empty(0, dtype=torch.bfloat16) if source.dtype == torch.float16 else source)
                         for tensor, source in original.items()}
            record = dict(name=name, sources=original, offloaded=offloaded, keep=keep, group=group, bytes=amount,
                          vision_only=bool(tensors) and all(id(tensor) in vision_tensors for tensor in tensors))
            self.records.append(record)
            self.restore(record)

            def onload(record=record):
                self.enter(record["name"])
                self.load_record(record)

            def offload(record=record):
                if not record["keep"] or self.active != record["name"]:
                    self.restore(record)

            group.onload_, group.offload_ = onload, offload
        self.entry_hooks.append(module.register_forward_pre_hook(lambda *_args: self.enter(name)))
        row.update(mode=mode, blocksPerGroup=1, retainedWeightBytes=sum(
            source.numel() * source.element_size() for record in self.records
            if record["name"] == name and record["keep"] for source in record["sources"].values()))
        self.manager.add(name, module)

    def load_record(self, record):
        for tensor, source in record["sources"].items():
            if self.control is not None:
                self.control.check()
            if tensor.device.type != "cuda":
                tensor.data = self.to_cuda(source, record["keep"] or record["name"] == "text_encoder")

    def to_cuda(self, source, retain):
        import torch
        location = getattr(source.untyped_storage(), "_huiyu_file_slice", None)
        size = source.numel() * source.element_size()
        dtype = torch.bfloat16 if source.dtype == torch.float16 else source.dtype
        if not retain or location is None or not source.is_contiguous() or size < 16 * 1024**2:
            return source.to(device="cuda:0", dtype=dtype, non_blocking=False)
        # Like Comfy's fast-disk path, avoid faulting a complete mapped tensor
        # through CUDA's pageable-memory upload. Two bounded pinned buffers
        # overlap file reads and transfers without staging a second checkpoint.
        if self.staging is None:
            self.staging = torch.empty((2, 32 * 1024**2), dtype=torch.uint8, pin_memory=True)
            self.staging_views = [memoryview(buffer.numpy()) for buffer in self.staging]
            self.copy_events = [torch.cuda.Event(), torch.cuda.Event()]
        # Keep the originally opened file, including across drive-letter remaps;
        # never reopen an unprotected path halfway through a request.
        stream = location[0]
        self.readers[id(stream)] = stream
        stream.seek(location[1] + source.storage_offset() * source.element_size())
        target = torch.empty_like(source, device="cuda:0")
        target_bytes = target.view(torch.uint8).reshape(-1)
        capacity = self.staging.shape[1]
        for offset in range(0, size, capacity):
            if self.control is not None:
                self.control.check()
            slot = self.copy_index % 2
            self.copy_index += 1
            if self.copy_active[slot]:
                self.copy_events[slot].synchronize()
            count = min(size - offset, capacity)
            if stream.readinto(self.staging_views[slot][:count]) != count:
                raise OSError("Checkpoint ended during pinned weight upload")
            target_bytes[offset:offset + count].copy_(self.staging[slot, :count], non_blocking=True)
            self.copy_events[slot].record(torch.cuda.current_stream())
            self.copy_active[slot] = True
        return target.to(dtype=dtype)

    @staticmethod
    def restore(record):
        for tensor, source in record["offloaded"].items():
            tensor.data = source

    def enter(self, name):
        import torch
        if self.active == name:
            return
        for record in self.records:
            if record["name"] != name and not (name == "vae" and record["name"] == "transformer"):
                self.restore(record)
        self.active = name
        for other_name, module in self.modules.items():
            if other_name != name and other_name not in ("text_encoder", "transformer"):
                for hook in self.manager.model_hooks or ():
                    if hook.model is module:
                        hook.offload()
        torch.cuda.empty_cache()
        # Allocate retained weights before activations. Interleaving their long
        # lifetimes with short FFN buffers fragments Windows' CUDA allocator and
        # can spill to shared RAM even while live tensors fit in dedicated VRAM.
        for record in self.records:
            if record["name"] == name and record["keep"]:
                self.load_record(record)
        if name == "vae":
            self.make_room(self.decode_reserve)

    def make_room(self, required):
        import torch
        free, _ = torch.cuda.mem_get_info()
        released, seen = 0, set()
        for record in reversed(self.records):
            if free + released >= required:
                break
            if record["name"] != "transformer":
                continue
            for tensor in record["sources"]:
                if tensor.device.type == "cuda" and id(tensor) not in seen:
                    seen.add(id(tensor))
                    released += tensor.numel() * tensor.element_size()
            self.restore(record)
        if released:
            torch.cuda.empty_cache()

    def finish(self):
        # Retain denoiser weights across decode and the next request. They remain
        # owned by the existing native worker and are released on handoff/timeout.
        for record in self.records:
            if record["name"] != "transformer":
                self.restore(record)

    def plan(self, pixels, *, image_conditioned=False, control=None, decode_pixels):
        import torch
        self.control = control
        self.decode_reserve = max(1024**3, decode_pixels * 1536)
        torch.cuda.empty_cache()
        free, _ = torch.cuda.mem_get_info()
        owned = {id(tensor): tensor for module in self.modules.values()
                 for tensor in (*module.parameters(), *module.buffers()) if tensor.device.type == "cuda"}
        reserve = activation_reserve(pixels, image_conditioned)
        budget = max(0, free + sum(t.numel() * t.element_size() for t in owned.values()) - reserve)
        self.report.update(freeBytes=free, activationReserveBytes=reserve, weightBudgetBytes=budget)
        for row in self.report["components"]:
            records = [record for record in self.records if record["name"] == row["name"]]
            if not records:
                continue
            streamed = self.block_reserves[row["name"]]
            for _ in range(2):
                available = max(0, budget - streamed)
                for record in records:
                    # Text-only prompts never execute the vision tower. Image
                    # encoders stream their consumed layers to leave room for prefill.
                    unused = record["vision_only"] and not image_conditioned
                    retain = not unused and not (image_conditioned and row["name"] == "text_encoder")
                    record["keep"] = retain and (row["weightBytes"] <= budget or record["bytes"] <= available)
                    if record["keep"]:
                        available -= record["bytes"]
                    else:
                        self.restore(record)
                needed = max((record["bytes"] for record in records if not record["keep"]
                              and not (record["vision_only"] and not image_conditioned)), default=0)
                if needed <= streamed:
                    break
                streamed = needed
            retained = {tensor: source for record in records if record["keep"]
                        for tensor, source in record["sources"].items()}
            row["retainedWeightBytes"] = sum(source.numel() * source.element_size() for source in retained.values())

    def bind(self, pipeline):
        if self.manager is not None and not self.manager.model_hooks:
            self._activate()
        self.bound = True
        pipeline._huiyu_memory = self

    def offload_all(self):
        self.active = None
        for record in self.records:
            self.restore(record)
        super().offload_all()

    def close(self):
        for event, active in zip(self.copy_events, self.copy_active):
            if active:
                event.synchronize()
        super().close()
        for hook in self.entry_hooks:
            hook.remove()
        self.entry_hooks.clear()
        self.records.clear()
        for reader in self.readers.values():
            reader.close()
        self.readers.clear()
        self.staging_views = self.staging = None
        self.copy_events.clear()
        self.block_reserves.clear()
        self.control = None
