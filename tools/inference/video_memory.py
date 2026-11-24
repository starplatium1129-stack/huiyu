"""Stage CUDA video weights from their original file views, with WDDM commit headroom."""
import ctypes
import os
from functools import cache

from huiyu_worker_lifecycle import load_sibling

mapped = load_sibling("mapped_residency")
memory = load_sibling("native_memory")
GIB = 1024**3


class _MemoryStatus(ctypes.Structure):
    _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32),
                ("total_phys", ctypes.c_uint64), ("avail_phys", ctypes.c_uint64),
                ("total_page", ctypes.c_uint64), ("avail_page", ctypes.c_uint64),
                ("total_virtual", ctypes.c_uint64), ("avail_virtual", ctypes.c_uint64),
                ("extended", ctypes.c_uint64)]


@cache
def _memory_status_api():
    api = ctypes.WinDLL("kernel32", winmode=0x800).GlobalMemoryStatusEx
    api.argtypes = [ctypes.POINTER(_MemoryStatus)]
    api.restype = ctypes.c_int
    return api


def available_commit():
    if os.name != "nt":
        return None
    status = _MemoryStatus()
    status.length = ctypes.sizeof(status)
    return status.avail_page if _memory_status_api()(ctypes.byref(status)) else None


def _packing(record):
    """Only the native H3 main stack has these static, disjoint weight views."""
    import torch
    rows = []
    for tensor, source in record["sources"].items():
        size = source.numel() * source.element_size()
        if (source.device.type != "cpu" or source.dtype not in (torch.int8, torch.bfloat16, torch.float32)
                or (not source.is_contiguous() and size > _BlockTransfer.page)):
            return None
        location = getattr(source.untyped_storage(), "_huiyu_file_slice", None)
        order = (0, id(location[0]), location[1]) if location else (1, 0, 0)
        data = memoryview(source.reshape(-1).view(torch.uint8).numpy()) if source.is_contiguous() else None
        rows.append((order, tensor, source, data))
    rows.sort(key=lambda row: row[0])
    layout, end = [], 0
    for _, tensor, source, data in rows:
        start = (end + 255) // 256 * 256
        end = start + source.numel() * source.element_size()
        layout.append((start, end, tensor, source, data))
    return (end, layout) if 0 < end <= 512 * 1024**2 else None


class _BlockTransfer:
    """A single lookahead with its own CUDA stream and bounded pinned pages."""
    page = 32 * 1024**2

    def __init__(self, device):
        import torch
        self.stream = torch.cuda.Stream(device=device)
        self.pages = torch.empty((2, self.page), dtype=torch.uint8, pin_memory=True)
        self.views = [memoryview(page.numpy()) for page in self.pages]
        self.page_events = [None, None]
        self.cursor = 0
        self.pending = self.consumed = self.spare = None

    def queue(self, record, control, stats):
        import torch
        size, layout = record["h3_packing"]
        if self.spare is not None and self.spare[0].numel() == size:
            raw, finished = self.spare
        else:
            # The compute stream owns the large cached activations from the
            # refiner. Reuse its slabs instead of charging WDDM on a new stream.
            raw = torch.empty(size, dtype=torch.uint8, device=self.stream.device)
            finished = torch.cuda.current_stream(self.stream.device).record_event()
            raw.record_stream(self.stream)
        self.spare = None
        with torch.cuda.stream(self.stream):
            self.stream.wait_event(finished)
            row = 0
            partial = None
            for start in range(0, size, self.page):
                if control is not None:
                    control.check()
                slot = self.cursor % 2
                self.cursor += 1
                event = self.page_events[slot]
                if event is None:
                    event = self.page_events[slot] = torch.cuda.Event()
                else:
                    # CPU must finish with this page's previous DMA before writing.
                    event.synchronize()
                limit = min(start + self.page, size)
                while row < len(layout) and layout[row][0] < limit:
                    left, right, _, source, data = layout[row]
                    first, last = max(left, start), min(right, limit)
                    if data is None and first == left and last == right:
                        # Compact QKV LoRA is a strided diagonal of the mapped
                        # B matrix. Gather just its live weights into this page.
                        dest = self.pages[slot, first - start:last - start]
                        dest.view(source.dtype).reshape(source.shape).copy_(source)
                    else:
                        if data is None:
                            if partial is None:
                                partial = memoryview(source.contiguous().view(torch.uint8).reshape(-1).numpy())
                            data = partial
                        self.views[slot][first - start:last - start] = data[first - left:last - left]
                    if right > limit:
                        break
                    partial = None
                    row += 1
                raw[start:limit].copy_(self.pages[slot, :limit - start], non_blocking=True)
                event.record(self.stream)
                stats["uploadedTransformerBytes"] += limit - start
            ready = self.stream.record_event()
        self.pending = (record, raw, ready)

    def attach(self, record, device):
        import torch
        if self.pending is None or self.pending[0] is not record:
            return False
        _, raw, ready = self.pending
        compute = torch.cuda.current_stream(device)
        compute.wait_event(ready)
        raw.record_stream(compute)
        for left, right, tensor, source, _ in record["h3_packing"][1]:
            tensor.data = raw[left:right].view(source.dtype).reshape(source.shape)
        self.consumed, self.pending = (record, raw), None
        return True

    def retire(self, record, device):
        import torch
        if self.consumed is not None and self.consumed[0] is record:
            if not record["keep"]:
                # This slab enters the spare slot only after the next upload
                # has used the previous spare, so copy and compute can overlap.
                self.spare = (self.consumed[1], torch.cuda.current_stream(device).record_event())
            self.consumed = None

    def close(self):
        self.stream.synchronize()
        self.pending = self.consumed = self.spare = None
        self.pages, self.views, self.page_events = None, [], []


class Residency(mapped.Residency):
    def __init__(self, components, data):
        self.codecs = {}
        self.loaded_codec = None
        self.h3_blocks = set(components["transformer"].transformer_blocks) if data.get("_h3TurboSteps") else set()
        self.held_blocks = {}
        self.h3_stats = {}
        self.can_retain = False
        self.transfer = None
        self.prefetch_enabled = False
        vae_config = getattr(components.get("vae"), "config", None)
        self.temporal_stride = max(1, int(getattr(vae_config, "scale_factor_temporal", 4)))
        pixels = data["width"] * data["height"]
        super().__init__(components, "offload", self.sampling_pixels(data),
                         image_conditioned=False, decode_pixels=pixels)
        self.report["strategy"] = "h3-file-backed-blocks-v2" if self.h3_blocks else "video-file-backed-offload-v1"

    def sampling_pixels(self, data):
        return data["width"] * data["height"] * (1 + (data["frames"] - 1) // self.temporal_stride)

    def refresh_budget(self):
        budget = super().refresh_budget()
        commit = available_commit()
        if commit is not None:
            # CUDA's available bytes already exclude the complete activation
            # reserve. Windows commit also covers the driver, pinned buffers
            # and host allocations; these are not another full CUDA workspace.
            host_reserve = GIB if self.h3_blocks else GIB + self.activation_reserve
            budget = min(budget, max(0, commit - host_reserve))
            self.report.update(availableCommitBytes=commit, weightBudgetBytes=budget)
        return budget

    def plan_video(self, data, control):
        pixels = self.sampling_pixels(data)
        commit = available_commit()
        available = None
        if commit is not None:
            self.report["availableCommitBytes"] = commit
            available = max(0, commit - GIB)
            if self.h3_blocks:
                # mapped.plan subtracts the device reserve after combining its
                # limits. Compare dedicated capacity to a separate host ceiling,
                # leaving half the remaining system commit for transient demand.
                available = mapped.activation_reserve(pixels, False) + available // 2
        self.plan(pixels, control=control, decode_pixels=data["width"] * data["height"], available_bytes=available)
        if self.h3_blocks:
            self.held_blocks.clear()
            self.can_retain = True
            self.prefetch_enabled = True
            self.hits_at_release = self.missed_releases = 0
            self.h3_stats = dict(plannedBlockBytes=0, peakHeldBlockBytes=0, blockHits=0,
                                 uploadedTransformerBytes=0, pressureReleases=0, guardSkips=0,
                                 prefetchHits=0, prefetchedBlockBytes=0, prefetchGuardSkips=0,
                                 completedMainPasses=0, pressureReleaseRounds=0, retentionPaused=False)
            packed_sizes = [r["h3_packing"][0] for r in self.records if r.get("h3_packing")]
            self.h3_stats["prefetchEligibleBlocks"] = len(packed_sizes)
            double_buffer = 2 * max(packed_sizes, default=0)
            working = max(self.block_reserves["transformer"], double_buffer)
            remaining = max(0, self.report["weightBudgetBytes"] - working)
            for row in self.report["components"]:
                if row["name"] in ("transformer", "text_encoder"):
                    row["retainedWeightBytes"] = 0
            for record in self.records:
                # Prompt encoding runs once. Preserve only complete, disjoint
                # DiT blocks, after their first forward has actually finished.
                record["keep"] = False
                self.restore(record)
                if record.get("h3_block") and record["bytes"] <= remaining:
                    remaining -= record["bytes"]
                    self.h3_stats["plannedBlockBytes"] += record["bytes"]

    def add(self, name, module):
        import torch
        from accelerate.hooks import ModelHook, add_hook_to_module
        from accelerate.utils import send_to_device

        if name not in ("vae", "audio_vae") or not isinstance(module, torch.nn.Module):
            start = len(self.records)
            super().add(name, module)
            if self.h3_blocks and name == "transformer":
                blocks = {}
                for record in self.records[start:]:
                    group = record["group"]
                    if len(group.modules) == 1 and group.modules[0] in self.h3_blocks:
                        blocks[group.modules[0]] = record
                        record["h3_block"] = True
                        record["h3_packing"] = _packing(record)
                        original = group.offload_
                        def offload(record=record, original=original):
                            if self.active != "transformer" or not self.h3_stats:
                                original()
                                return
                            headroom = self.block_headroom()
                            self.finish_block(record, headroom)
                            original()
                            self.prefetch_after(record, headroom)
                        group.offload_ = offload
                stack = module.transformer_blocks
                if stack[-1] in blocks:
                    blocks[stack[-1]]["h3_last"] = True
                for current, following in zip(stack, list(stack)[1:]):
                    if current in blocks and following in blocks:
                        blocks[current]["h3_next"] = blocks[following]
            return
        # Video VAEs can call encoder/decoder and quant/input projections
        # directly, bypassing Module.forward. Keep the original CPU tensors
        # for every stage instead of copying gigabytes back from VRAM.
        self.modules[name] = module
        self.codecs[name] = {tensor: tensor.detach() for tensor in (*module.parameters(), *module.buffers())}
        self.report["components"].append(dict(name=name, mode="mapped-component", weightBytes=memory.tensor_bytes(module)))

        def pre_forward(_module, *args, **kwargs):
            self.enter(name)
            return send_to_device(args, self.device), send_to_device(kwargs, self.device)

        hook = ModelHook()
        hook.execution_device = self.device
        hook.pre_forward = pre_forward
        add_hook_to_module(module, hook)
        # Diffusers @apply_forward_hook covers encode/decode. The modular H3
        # blocks can also enter at the quant or audio projections themselves.
        for attr in ("encoder", "decoder", "quant_conv", "post_quant_conv", "enc_in_proj", "dec_in_proj"):
            child = getattr(module, attr, None)
            if isinstance(child, torch.nn.Module):
                self.entry_hooks.append(child.register_forward_pre_hook(lambda *_: self.enter(name)))

    def release_codec(self):
        if self.loaded_codec is not None:
            for tensor, source in self.codecs[self.loaded_codec].items():
                tensor.data = source
            self.loaded_codec = None

    def release_blocks(self):
        for record in self.held_blocks.values():
            record["keep"] = False
            self.restore(record)
        self.held_blocks.clear()

    def evict_for_pressure(self):
        if not self.held_blocks:
            return
        stats = self.h3_stats
        hits = stats["blockHits"]
        self.missed_releases = self.missed_releases + 1 if hits == self.hits_at_release else 0
        self.hits_at_release = hits
        stats["pressureReleaseRounds"] += 1
        stats["pressureReleases"] += len(self.held_blocks)
        self.release_blocks()
        if self.missed_releases >= 2:
            self.can_retain = False
            stats["retentionPaused"] = True

    def block_headroom(self):
        import torch
        # This hook runs on the homogeneous main stack, after the larger
        # BF16 token refiner has finished. Unsplit inactive CUDA slabs are
        # already backed by both VRAM and Windows commit. Reuse at most one
        # incoming block's worth and keep separate driver/desktop margins.
        stats = torch.cuda.memory_stats(self.device)
        reusable = max(0, stats.get("reserved_bytes.all.current", 0) - stats.get("active_bytes.all.current", 0)
                       - stats.get("inactive_split_bytes.all.current", 0))
        return torch.cuda.mem_get_info(self.device)[0], reusable, available_commit()

    def finish_block(self, record, headroom):
        target = self.h3_stats["plannedBlockBytes"]
        if not target or not self.can_retain:
            return
        import torch
        free, reusable, commit = headroom
        size = record["bytes"]
        fresh = max(0, size - reusable)
        if "firstBlockHeadroom" not in self.h3_stats:
            self.h3_stats["firstBlockHeadroom"] = dict(freeBytes=free, availableCommitBytes=commit,
                reusableCudaBytes=reusable, incomingBlockBytes=size)
        if free < fresh + GIB // 4 or (commit is not None and commit < fresh + GIB):
            self.h3_stats["guardSkips"] += 1
            if self.held_blocks:
                self.evict_for_pressure()
                torch.cuda.empty_cache()
            return
        # Any completed block may fill the budget. A busy first block must
        # not permanently disable reuse after the refiner's workspace retires.
        live = sum(group["bytes"] for group in self.held_blocks.values())
        if id(record) not in self.held_blocks and live + size <= target:
            record["keep"] = True
            self.held_blocks[id(record)] = record
            self.h3_stats["peakHeldBlockBytes"] = max(self.h3_stats["peakHeldBlockBytes"], live + size)

    def prefetch_after(self, record, headroom):
        import torch
        if record.get("h3_last"):
            self.h3_stats["completedMainPasses"] += 1
        following = record.get("h3_next")
        if following is None:
            # The next diffusion step starts with different refiner weights.
            self.release_transfer()
            return
        try:
            # The first pass also brings the mapped checkpoint pages back
            # after text and VAE work. Its normal multithreaded CPU upload is
            # faster on this cold working set than serially filling DMA pages.
            if (not self.h3_stats["completedMainPasses"] or not self.prefetch_enabled
                    or following["keep"] or not following["h3_packing"]):
                return
            size = following["h3_packing"][0]
            free, reusable, commit = headroom
            spare = self.transfer.spare if self.transfer else None
            fresh = 0 if spare and spare[0].numel() == size else max(0, size - reusable)
            pinned = 0 if self.transfer else 2 * _BlockTransfer.page
            commit_margin = GIB if fresh else GIB // 4
            held = sum(r["bytes"] for r in self.held_blocks.values())
            working = size + (0 if record["keep"] else record["bytes"])
            if (working + held > self.report["weightBudgetBytes"] or free < fresh + GIB // 4
                    or (commit is not None and commit < fresh + pinned + commit_margin)):
                self.h3_stats["prefetchGuardSkips"] += 1
                self.release_transfer()
                return
            if self.transfer is None:
                self.transfer = _BlockTransfer(self.device)
            if self.transfer.pending is not None:
                # Unexpected visitation order; ordinary onload still owns every tensor.
                self.transfer.pending = None
            self.transfer.queue(following, self.control, self.h3_stats)
            self.h3_stats["prefetchedBlockBytes"] += following["bytes"]
        except (RuntimeError, MemoryError) as exc:
            if not (isinstance(exc, (torch.OutOfMemoryError, MemoryError)) or
                    any(s in str(exc).lower() for s in ("out of memory", "memory allocation", "pinned memory"))):
                raise
            self.h3_stats["prefetchFallback"] = str(exc)
            self.prefetch_enabled = False
            self.release_transfer()
            torch.cuda.empty_cache()
        finally:
            if self.transfer is not None:
                self.transfer.retire(record, self.device)

    def release_transfer(self):
        if self.transfer is not None:
            self.transfer.close()
            self.transfer = None

    def load_record(self, record):
        if not self.h3_stats or self.active != "transformer":
            return super().load_record(record)
        import torch
        if id(record) in self.held_blocks:
            self.h3_stats["blockHits"] += 1
        if self.transfer is not None and self.transfer.attach(record, self.device):
            self.h3_stats["prefetchHits"] += 1
        try:
            super().load_record(record)
        except torch.OutOfMemoryError:
            if not self.held_blocks and self.transfer is None:
                raise
            self.evict_for_pressure()
            self.can_retain = False
            self.prefetch_enabled = False
            self.release_transfer()
            torch.cuda.empty_cache()
            # Resume only the missing transfers. Existing Parameter objects
            # and the partially uploaded current group remain intact.
            super().load_record(record)

    def to_cuda(self, source, retain):
        if self.h3_blocks:
            # Stream immutable packed INT8/NVFP4 views through bounded pinned
            # buffers, including groups which are sent again on every step.
            result = super().to_cuda(source, retain, mapped_pages=True)
            if self.h3_stats and self.active == "transformer":
                self.h3_stats["uploadedTransformerBytes"] += source.numel() * source.element_size()
            return result
        return super().to_cuda(source, retain)

    def observation(self):
        report = super().observation()
        if self.h3_stats:
            # The worker takes its metadata object before running the pipeline.
            # This per-request dict is replaced at the next plan, never reused.
            report["h3BlockTransfers"] = self.h3_stats
        return report

    def enter(self, name):
        if self.active == name:
            return
        self.release_transfer()
        self.release_codec()
        self.release_blocks()
        if name in self.codecs:
            # Reserve the complete VAE working set before its first projection,
            # including the post-quant convolution before decoder.forward.
            for record in self.records:
                self.restore(record)
        super().enter(name)
        if name in self.codecs:
            self.loaded_codec = name
            for tensor, source in self.codecs[name].items():
                if self.control is not None:
                    self.control.check()
                # The normal loader has already selected the execution dtype.
                tensor.data = source.to(self.device)

    def offload_all(self):
        self.release_transfer()
        self.release_blocks()
        self.release_codec()
        super().offload_all()

    def finish(self):
        self.release_transfer()
        self.release_blocks()
        self.release_codec()
        self.active = None
        if self.h3_blocks:
            # The post-forward hook can be skipped on cancellation or failure.
            for record in self.records:
                self.restore(record)
        super().finish()

    def close(self):
        from accelerate.hooks import remove_hook_from_module
        for name in self.codecs:
            node = self.modules.get(name)
            if node is not None and hasattr(node, "_hf_hook"):
                remove_hook_from_module(node)
        super().close()
        self.codecs.clear()
        self.h3_blocks.clear()
