"""Optional packed transfer of already validated, privately owned CPU modules.

This helper does not validate checkpoint provenance/keys/finite values. The
existing loader must finish its upstream loading checks before calling it. It changes no
dtype, shape or values, and retains each Parameter/Buffer object. It has no
model loading, installation, device fallback or numerical kernel dependency.
"""
from contextlib import nullcontext


STAGING_BYTES = 32 * 1024 * 1024


def _pinned_slabs(torch, largest):
    if largest < 1024 * 1024:
        return []
    try:
        size = min(STAGING_BYTES, largest)
        return [torch.empty(size, dtype=torch.uint8, device="cpu", pin_memory=True) for _ in range(2)]
    except (MemoryError, RuntimeError):
        # Only staging allocation may fall back. DMA/Event failures propagate.
        return []


def _copy_pinned(torch, destination, group, slabs, events, stream):
    """Merge byte-exact tensor spans into bounded, reusable DMA windows."""
    rows = [(source.view(-1).view(torch.uint8), offset * source.element_size())
            for _, source, offset in group]
    target = destination.view(torch.uint8)
    index, copies = 0, 0
    for start in range(0, target.numel(), slabs[0].numel()):
        slot = copies % len(slabs)
        if events[slot] is not None:
            events[slot].synchronize()  # CPU must not overwrite an in-flight pinned source.
        stop = min(start + slabs[slot].numel(), target.numel())
        staged = slabs[slot].narrow(0, 0, stop - start)
        cursor = start
        while index < len(rows):
            source, offset = rows[index]
            end = offset + source.numel()
            if end <= start:
                index += 1
                continue
            if offset >= stop:
                break
            left, right = max(start, offset), min(stop, end)
            if left > cursor:
                staged.narrow(0, cursor - start, left - cursor).zero_()
            staged.narrow(0, left - start, right - left).copy_(source.narrow(0, left - offset, right - left))
            cursor = right
            if end > stop:
                break
            index += 1
        if cursor < stop:
            staged.narrow(0, cursor - start, stop - cursor).zero_()
        target.narrow(0, start, stop - start).copy_(staged, non_blocking=True)
        if events[slot] is None:
            events[slot] = torch.cuda.Event()
        events[slot].record(stream)
        copies += 1
    return copies


def try_packed_upload(modules, target_device="cuda", *, observation=None):
    """Pack registered tensors into target storage per component/dtype.

    Pass an iterable of the fully loaded nn.Modules (the four Anima weight
    components). Unsupported CPU layouts, subclasses, dtypes, gradients and
    different tensor objects sharing storage/overlapping memory return False
    without mutations, so the caller can use its existing pipeline.to path.
    Repeated references to the SAME Parameter/Buffer object are supported.

    CUDA transfers coalesce tensors through at most two 32-MiB pinned byte slabs
    on a dedicated stream. CPU filling overlaps the prior DMA; an Event gates
    each slab's reuse. Small/unsupported pin allocations use the direct path.
    This is bounded staging, never a complete pinned host-weight copy. CPU
    detach references and slabs remain live through the last synchronization.
    Only after successful copies/synchronization are original objects rebound
    to packed views, then those source references are released.
    Allocation/copy/publication errors propagate; they are not an applicability
    failure and must not trigger a silent partially-mutated fallback.

    Each view's offset within its flat is aligned to 256 bytes. Parameters receive the marker
    _huiyu_packed_storage=True. Consumers replacing Parameter.data (e.g. PEFT
    merge) must restore its packed view by copying the new values back, otherwise
    the original shared allocation remains live alongside new allocations.
    This layout alone is not evidence of GPU transfer speed.
    """
    import torch

    roots = tuple(modules)
    target = torch.device(target_device)
    if not roots or target.type not in ("cpu", "cuda") or any(not isinstance(root, torch.nn.Module) for root in roots):
        return False
    supported = {torch.float16, torch.bfloat16, torch.float32, torch.float64,
                 torch.int8, torch.uint8, torch.int16, torch.int32, torch.int64, torch.bool}
    seen, storages, intervals, groups = set(), set(), [], {}
    for component_index, root in enumerate(roots):
        for module in root.modules():
            # named_parameters removes duplicate names, but direct registrations
            # also include shared buffers and nonpersistent rotary/mask buffers.
            for tensor in (*module._parameters.values(), *module._buffers.values()):
                if tensor is None or id(tensor) in seen:
                    continue
                if (type(tensor) not in (torch.Tensor, torch.nn.Parameter) or tensor.device.type != "cpu"
                        or tensor.layout != torch.strided or tensor.dtype not in supported
                        or not tensor.is_contiguous() or tensor.is_conj() or tensor.is_neg()
                        or (isinstance(tensor, torch.nn.Parameter) and tensor.grad is not None)):
                    return False
                seen.add(id(tensor))
                source = tensor.detach()
                # Storage handles catch disjoint views too; byte intervals catch
                # separately wrapped buffers (e.g. frombuffer) with shared memory.
                storage_id = source.untyped_storage()._cdata
                if storage_id in storages:
                    return False
                storages.add(storage_id)
                if source.numel():
                    start = source.data_ptr()
                    intervals.append((start, start + source.numel() * source.element_size()))
                group = groups.setdefault((component_index, source.dtype), [])
                alignment = 256 // source.element_size()
                previous_end = group[-1][2] + group[-1][1].numel() if group else 0
                offset = (previous_end + alignment - 1) // alignment * alignment
                group.append((tensor, source, offset))
    if not groups:
        return False
    end = 0
    for start, stop in sorted(intervals):
        if start < end:
            return False
        end = stop

    sizes = {key: (group[-1][2] + group[-1][1].numel()) * group[-1][1].element_size()
             for key, group in groups.items()}
    slabs = _pinned_slabs(torch, max(sizes.values())) if target.type == "cuda" else []
    stream = torch.cuda.Stream(device=target) if slabs else None
    consumer = torch.cuda.current_stream(target) if stream is not None else None
    if stream is not None:
        stream.wait_stream(consumer)
    target_flats, events, copies = {}, [None] * len(slabs), 0
    with torch.no_grad():
        with torch.cuda.stream(stream) if stream is not None else nullcontext():
            try:
                for key, group in groups.items():
                    total = group[-1][2] + group[-1][1].numel()
                    destination = torch.empty(total, dtype=key[1], device=target)
                    target_flats[key] = destination
                    if slabs:
                        copies += _copy_pinned(torch, destination, group, slabs, events, stream)
                    else:
                        for _, source, offset in group:
                            destination.narrow(0, offset, source.numel()).copy_(source.view(-1), non_blocking=True)
                            copies += bool(source.numel())
            finally:
                # Drain queued copies on failure too, before releasing CPU sources
                # or publishing any views. Pinned mode avoids a device-wide wait.
                if target.type == "cuda" and target_flats:
                    stream.synchronize() if stream is not None else torch.cuda.synchronize(target)
        if consumer is not None:
            for destination in target_flats.values():
                destination.record_stream(consumer)
        for key, group in groups.items():
            for tensor, source, offset in group:
                tensor.data = target_flats[key].narrow(0, offset, source.numel()).view(source.shape)
                if isinstance(tensor, torch.nn.Parameter):
                    tensor._huiyu_packed_storage = True
    # The views now own target storage. Drop CPU detaches after the final
    # sync; no source Tensor is retained on the modules or in a global cache.
    if observation is not None:
        tensor_bytes = sum(source.numel() * source.element_size()
            for group in groups.values() for _, source, _ in group)
        observation.update(strategy="packed-pinned" if slabs else "packed-direct",
            tensorBytes=tensor_bytes, transferBytes=sum(sizes.values()) if slabs else tensor_bytes,
            copyCalls=copies, stagingBytes=sum(slab.numel() for slab in slabs))
    groups.clear()
    return True
