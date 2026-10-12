"""Optional packed transfer of already validated, privately owned CPU modules.

This helper does not validate checkpoint provenance/keys/finite values. The
existing loader must finish those checks before calling it. It changes no
dtype, shape or values, and retains each Parameter/Buffer object. It has no
model loading, installation, device fallback or numerical kernel dependency.
"""


def try_packed_upload(modules, target_device="cuda"):
    """Pack registered tensors into target storage per component/dtype.

    Pass an iterable of the fully loaded nn.Modules (the four Anima weight
    components). Unsupported CPU layouts, subclasses, dtypes, gradients and
    different tensor objects sharing storage/overlapping memory return False
    without mutations, so the caller can use its existing pipeline.to path.
    Repeated references to the SAME Parameter/Buffer object are supported.

    Allocate only target-device flat storage per component/dtype; each CPU view
    copies directly into its target slice with non_blocking=True. There is no
    CPU concatenation, pinned staging allocation or complete host-weight copy.
    CPU detach references remain live through the last CUDA synchronization.
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

    target_flats = {}
    with torch.no_grad():
        try:
            for key, group in groups.items():
                total = group[-1][2] + group[-1][1].numel()
                destination = torch.empty(total, dtype=key[1], device=target)
                target_flats[key] = destination
                for _, source, offset in group:
                    destination.narrow(0, offset, source.numel()).copy_(source.view(-1), non_blocking=True)
        finally:
            # Also finish earlier queued copies if a later allocation/copy
            # failed. Original modules have not been changed at this point.
            if target.type == "cuda" and target_flats:
                torch.cuda.synchronize(target)
        for key, group in groups.items():
            for tensor, source, offset in group:
                tensor.data = target_flats[key].narrow(0, offset, source.numel()).view(source.shape)
                if isinstance(tensor, torch.nn.Parameter):
                    tensor._huiyu_packed_storage = True
    # The views now own target storage. Drop CPU detaches after the final
    # sync; no source Tensor is retained on the modules or in a global cache.
    groups.clear()
    return True
