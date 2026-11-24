"""Local attention dispatch for the denoisers in the pinned video pipelines."""
from contextlib import contextmanager, nullcontext
from functools import lru_cache
import sys

from huiyu_worker_lifecycle import load_sibling

Error = load_sibling("adapter_contract").AdapterError


@lru_cache(maxsize=1)
def device():
    import torch
    for kind in ("cuda", "xpu"):
        api = getattr(torch, kind, None)
        if api is not None and api.is_available() and api.is_bf16_supported(including_emulation=False):
            backend = "rocm" if kind == "cuda" and torch.version.hip else kind
            target = torch.device(kind, api.current_device())
            if backend == "rocm":
                # HIP's BF16 capability flag is unconditional on some wheels.
                try:
                    sample = torch.ones((16, 16), device=target, dtype=torch.bfloat16)
                    if not bool(torch.isfinite(sample @ sample).all()):
                        continue
                except (RuntimeError, NotImplementedError) as exc:
                    raise Error("DEVICE_UNAVAILABLE", f"当前 ROCm 环境无法执行视频模型的 BF16 运算：{exc}") from exc
            return target, backend
    raise Error("DEVICE_UNAVAILABLE", "原生视频需要支持 BF16 的 CUDA、ROCm 或 Intel XPU 显卡及对应的 PyTorch。")


def select(requested, target, backend):
    """Validate the local extension before fingerprinting or uploading weights."""
    import torch
    from diffusers.models.attention_dispatch import attention_backend
    if requested in ("h3-sol", "h3-sla", "h3-fused"):
        # Select the dense backend for protected or unsupported calls. Mark the
        # requested sparse backend selected only after it returns a real result.
        requested = "auto"
    if requested == "sdpa":
        return "sdpa"
    capability = torch.cuda.get_device_capability(target) if backend == "cuda" else None
    candidates = ("flash2", "sage") if requested == "auto" else (requested,)
    for candidate in candidates:
        if candidate == "sage":
            supported = capability in ((8, 0), (8, 6), (8, 9), (9, 0), (12, 0), (12, 1))
        else:
            supported = capability is not None and capability[0] in (8, 9, 12)
        if not supported:
            if requested == "auto":
                continue
            raise Error("UNSUPPORTED_ACCELERATION", f"{requested} 与当前显卡不兼容，请选择自动或 PyTorch SDPA。")
        try:
            # Only the installed-wheel variants. Diffusers also has Hub backends
            # with different names that would require downloading executable code.
            with attention_backend("flash" if candidate == "flash2" else "sage"):
                return candidate
        except (ImportError, OSError, RuntimeError, ValueError) as exc:
            if requested != "auto":
                raise Error("UNSUPPORTED_ACCELERATION", f"{requested} 加速库不可用，请核对本地版本或选择自动：{exc}") from exc
    return "sdpa"


def _fused_shape(query, key, value, mask, options, backend):
    import torch
    dim = query.size(-1)
    return (mask is None and query.device.type == "cuda"
            and query.ndim == key.ndim == value.ndim == 4
            and query.dtype == key.dtype == value.dtype and query.dtype in (torch.float16, torch.bfloat16)
            and query.size(2) == key.size(2) == value.size(2)
            and key.size(-1) == value.size(-1) == dim and dim % 8 == 0
            and dim <= (128 if backend == "sage" else 256)
            and not options.get("is_causal") and not options.get("dropout_p")
            and not options.get("parallel_config") and not options.get("enable_gqa")
            and not options.get("attention_kwargs"))


def _rocm_rows(query, key, value, mask):
    """Chunk large unfused score matrices along Q, retaining every key for each row."""
    import torch
    rows = max(1, (64 * 1024**2) // (4 * query.size(0) * query.size(2) * key.size(1)))
    if rows >= query.size(1):
        return query.size(1)
    q, k, v = (tensor.transpose(1, 2) for tensor in (query, key, value))
    params = torch.backends.cuda.SDPAParams(q, k, v, mask, 0., False, False)
    if torch.backends.cuda.can_use_flash_attention(params) or torch.backends.cuda.can_use_efficient_attention(params):
        return query.size(1)
    return rows


@contextmanager
def attention(pipeline, control, report, *, dwd=False):
    # All four pinned transformer implementations import dispatch_attention_fn
    # into their defining module. Both Wan experts use that same module. Limit
    # the override to this worker's active denoiser, keeping encoders/VAEs and
    # subsequent jobs on their own dispatch paths.
    module = sys.modules[type(pipeline.transformer).__module__]
    original = module.dispatch_attention_fn
    selected = report["selected"]
    backend = report["device"]
    calls = report["calls"]
    requested = report["requested"]
    if dwd and requested in ("h3-sla", "h3-fused"):
        raise Error("UNSUPPORTED_ACCELERATION", "pi-H3 DWD 无法叠加 SLA 或融合 Turbo 权重。")
    if (requested == "h3-sla") != (getattr(pipeline.transformer, "_huiyu_h3_sla", False) is True):
        raise Error("MODEL_INVALID", "H3 SLA 需要已校验的专用 4 步 Turbo 权重。")
    if (requested == "h3-fused") != (getattr(pipeline.transformer, "_huiyu_h3_fused", False) is True):
        raise Error("MODEL_INVALID", "Fused Turbo 需要已校验的社区融合权重。")
    sparse_mode = requested in ("h3-sol", "h3-sla", "h3-fused")
    scope = load_sibling("h3_sparse").routing(pipeline.transformer, report, dwd=dwd) if sparse_mode else nullcontext()

    def dispatch(query, key, value, attn_mask=None, **options):
        nonlocal selected
        if sparse is not None and _fused_shape(query, key, value, attn_mask, options, "sage"):
            result = sparse.try_attention(query, key, value, options.get("scale"))
            if result is not None:
                return result
        if selected != "sdpa" and _fused_shape(query, key, value, attn_mask, options, selected):
            options["backend"] = "flash" if selected == "flash2" else "sage"
            try:
                result = original(query, key, value, **options)
            except (ImportError, OSError, NotImplementedError, RuntimeError, ValueError) as exc:
                # Some binary wheels import successfully but have no kernel
                # for the installed architecture. Never retry a device fault
                # or an allocation failure with a second GPU operation.
                unavailable = isinstance(exc, (ImportError, NotImplementedError)) or any(
                    marker in str(exc).lower() for marker in (
                        "unsupported cuda architecture", "no kernel image", "not compiled",
                        "not implemented for", "no available kernel", "cannot find a working triton",
                    )
                )
                if not unavailable:
                    raise
                if report["requested"] != "auto" and not sparse_mode:
                    raise Error("UNSUPPORTED_ACCELERATION", f"{selected} 内核无法在当前设备运行：{exc}") from exc
                selected = "sdpa"
                if not sparse_mode or not calls[requested]:
                    report["selected"] = selected
            else:
                calls[selected] += 1
                return result

        options["backend"] = "native"
        if (backend == "rocm" and not options.get("is_causal") and not options.get("parallel_config")
                and not options.get("dropout_p") and not options.get("enable_gqa") and not options.get("attention_kwargs")):
            # Diffusers interprets [batch, keys] as a padding mask.
            if attn_mask is not None and attn_mask.shape == (query.size(0), key.size(1)):
                attn_mask = attn_mask[:, None, None, :]
            rows = _rocm_rows(query, key, value, attn_mask)
            if rows < query.size(1):
                output = query.new_empty((*query.shape[:-1], value.size(-1)))
                for start in range(0, query.size(1), rows):
                    control.check()
                    tile = slice(start, start + rows)
                    mask = attn_mask
                    if mask is not None and mask.ndim >= 2 and mask.size(-2) > 1:
                        mask = mask[..., tile, :]
                    output[:, tile] = original(query[:, tile], key, value, attn_mask=mask, **options)
                calls["slicedSdpa"] += 1
                return output
        result = original(query, key, value, attn_mask=attn_mask, **options)
        calls["sdpa"] += 1
        return result

    with scope as sparse:
        module.dispatch_attention_fn = dispatch
        try:
            yield
        finally:
            module.dispatch_attention_fn = original
