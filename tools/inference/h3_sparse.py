"""Optional CUDA block-sparse attention over a MiniMax H3 packed sequence."""
from contextlib import contextmanager, ExitStack


BLOCK = 64
MIN_ROWS = 12288


def _conditioning_prefix(video, audio, text):
    """The pinned T2VA/FL2VA order is text, keyframes, audio, generated video."""
    import torch
    indices = (video, audio, text)
    if any(not isinstance(rows, torch.Tensor) or rows.ndim != 1 or not rows.numel()
           or rows.dtype != torch.long for rows in indices):
        return None
    # Read once per actual layout, outside the block loop. Do not infer the
    # anchor length from the user resolution or treat vision-tagged text as video.
    video, audio, text = (rows.detach().cpu() for rows in indices)
    length = video.numel() + audio.numel() + text.numel()
    audio_start = int(audio[0])
    target_start = audio_start + audio.numel()
    if not text.numel() <= audio_start < target_start < length:
        return None
    if (not torch.equal(text, torch.arange(text.numel(), device="cpu"))
            or not torch.equal(audio, torch.arange(audio_start, target_start, device="cpu"))):
        return None
    anchors = audio_start - text.numel()
    if (not torch.equal(video[:anchors], torch.arange(text.numel(), audio_start, device="cpu"))
            or not torch.equal(video[anchors:], torch.arange(target_start, length, device="cpu"))):
        return None
    return length, target_start


class _Route:
    def __init__(self, report):
        self.report = report
        self.mode = report["requested"]
        self.keep = {"h3-sla": 0.15, "h3-fused": 0.10}.get(self.mode, 0.0)
        self.details = report["sparse"] = {
            "kernel": None, "reason": "not-used",
            "routing": "top-k" if self.keep else "adaptive",
        }
        if self.keep:
            self.details["keepRatio"] = self.keep
        self.kernel = None
        self.in_blocks = False
        self.passes = 0
        self.indices = None
        self.layout = None
        self.no_kernel = False

    def begin(self, _module, _args, kwargs):
        self.in_blocks = False
        self.passes += 1
        indices = tuple(kwargs.get(key) for key in ("video_indices", "audio_indices", "text_indices"))
        if self.indices is None or any(old is not new for old, new in zip(self.indices, indices)):
            self.indices = indices
            self.layout = _conditioning_prefix(*indices)
            if self.layout is not None:
                self.details["rows"], self.details["protectedRows"] = self.layout
        if self.layout is None:
            self.details["reason"] = "unsupported-layout"

    def enter(self, _module, _args):
        self.in_blocks = True

    def end(self, _module, _args, _result):
        self.in_blocks = False

    def try_attention(self, query, key, value, scale):
        if self.no_kernel or not self.in_blocks or self.layout is None:
            return None
        length, protected = self.layout
        if query.size(1) != length or query.shape != key.shape or query.shape != value.shape or query.size(-1) != 128:
            self.details["reason"] = "unsupported-shape"
            return None
        # The pretrained SLA requires top-k on every eligible denoising pass.
        # For ordinary Sol-Attn keep short clips and the first pass dense.
        minimum = {"h3-sla": BLOCK * 2, "h3-fused": 8192}.get(self.mode, MIN_ROWS)
        if length < minimum or protected + BLOCK >= length:
            self.details["reason"] = "short-sequence"
            return None
        if not self.keep and self.passes == 1:
            self.details["reason"] = "dense-first-pass"
            return None
        if self.kernel is None:
            try:
                import comfy_kitchen as kitchen
                if kitchen.sol_attn_is_available(query.device):
                    # Pin the implementation: the generic API can select its
                    # quadratic eager reference on an unsupported call.
                    self.kernel = kitchen.registry.get_implementation("sol_attn", backend="cuda")
            except (ImportError, OSError, AttributeError):
                pass
            if self.kernel is None:
                self.no_kernel = True
                self.details["reason"] = "compiled-kernel-unavailable"
                return None
        # A partial boundary block is deliberately protected in full in both
        # directions, preserving text, target audio, and both keyframe anchors.
        sinks = [0, (protected + BLOCK - 1) // BLOCK]
        try:
            # The LightX2V H3 recipe uses routed softmax without a learned
            # linear branch. The Comfy CUDA backend keeps its diagonal and
            # exact conditioning blocks in addition to the 15% video budget.
            output = self.kernel(query, key, value, tau=1.0, scale=scale, sink_blocks=sinks, sink_q=sinks,
                                 topk_ratio=self.keep, tail=not self.keep)
        except (ImportError, OSError, NotImplementedError, ValueError, RuntimeError) as exc:
            # Allocation failures and device faults must propagate to the worker.
            if not isinstance(exc, (ImportError, NotImplementedError, ValueError)) and not any(
                word in str(exc).lower() for word in ("no kernel image", "not compiled", "unsupported cuda architecture")
            ):
                raise
            self.no_kernel = True
            self.details["reason"] = "kernel-rejected-call"
            return None
        self.details.update(kernel="comfy-kitchen-cuda", reason="executed")
        self.report["calls"][self.mode] += 1
        self.report["selected"] = self.mode
        return output


@contextmanager
def routing(transformer, report):
    route = _Route(report)
    report["calls"][route.mode] = 0
    with ExitStack() as hooks:
        if type(transformer).__name__ != "MiniMaxH3Transformer3DModel":
            route.details["reason"] = "unsupported-model"
        elif report["device"] != "cuda":
            route.details["reason"] = "unsupported-device"
        else:
            hooks.callback(transformer.register_forward_pre_hook(route.begin, with_kwargs=True).remove)
            hooks.callback(transformer.register_forward_hook(route.end, always_call=True).remove)
            hooks.callback(transformer.transformer_blocks[0].register_forward_pre_hook(route.enter).remove)
        yield route
