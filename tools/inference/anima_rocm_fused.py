"""Job-scoped gfx1150 BF16 Q/K normalization and rotation for Windows ROCm 7."""
import ctypes
from contextlib import contextmanager, ExitStack
from pathlib import Path

import torch
from diffusers.models.normalization import RMSNorm


class HipModuleError(RuntimeError):
    pass


@contextmanager
def use_kernel(transformer, device, processor_type):
    processors = [block.attn1.processor for block in transformer.transformer_blocks
                  if type(block.attn1.processor) is processor_type and block.attn1.processor.fused is None]
    # Use the HIP instance that already owns PyTorch's device pointers and stream.
    # Loading another wheel's DLL into this process could select a different runtime.
    get_module = ctypes.WinDLL("kernel32", use_last_error=True).GetModuleHandleW
    get_module.argtypes = [ctypes.c_wchar_p]
    get_module.restype = ctypes.c_void_p
    handle = get_module("amdhip64_7.dll")
    if not handle or not processors:
        yield None
        return
    with ExitStack() as resources:
        try:
            hip = ctypes.CDLL("amdhip64_7.dll", handle=handle)
            kernel = resources.enter_context(FusedQkRope(hip, device))
        except (OSError, AttributeError, HipModuleError):
            # No work has been submitted. Unsupported modules use the stock processor.
            yield None
            return
        try:
            for processor in processors:
                processor.fused = kernel
            yield kernel
        finally:
            for processor in processors:
                processor.fused = None


class FusedQkRope:
    def __init__(self, hip, device):
        self.code_object = Path(__file__).with_name("anima_qk_gfx1150.co").read_bytes()
        self.device = device
        self.hip = hip
        ptr = ctypes.c_void_p
        ptrs = ctypes.POINTER(ptr)
        self.hip.hipModuleLoadData.argtypes = [ptrs, ptr]
        self.hip.hipModuleGetFunction.argtypes = [ptrs, ptr, ctypes.c_char_p]
        self.hip.hipModuleLaunchKernel.argtypes = [ptr] + [ctypes.c_uint] * 7 + [ptr, ptrs, ptrs]
        self.hip.hipModuleUnload.argtypes = [ptr]
        self.module, self.function = ptr(), ptr()
        self.calls = 0

    def _call(self, name, *args):
        status = getattr(self.hip, name)(*args)
        if status:
            raise HipModuleError(f"{name} returned HIP status {status}")

    def __enter__(self):
        if self.module:
            raise RuntimeError("The HIP module is already open")
        with torch.cuda.device(self.device):
            self._call("hipModuleLoadData", ctypes.byref(self.module), self.code_object)
            try:
                self._call("hipModuleGetFunction", ctypes.byref(self.function), self.module, b"anima_qk_rms_rope")
            except BaseException:
                self._call("hipModuleUnload", self.module)
                self.module, self.function = ctypes.c_void_p(), ctypes.c_void_p()
                raise
        return self

    def __exit__(self, *exc):
        with torch.cuda.device(self.device):
            try:
                torch.cuda.synchronize(self.device)
            finally:
                self._call("hipModuleUnload", self.module)
                self.module, self.function = ctypes.c_void_p(), ctypes.c_void_p()

    def rms_rope(self, query, key, norm_q, norm_k, rope):
        if (not self.function or torch.is_grad_enabled() or query.ndim != 4 or
                query.shape != key.shape or query.shape[-1] != 128 or
                torch.is_autocast_enabled(self.device.type)):
            return None
        batch, heads, sequence, _ = query.shape
        rows = batch * heads * sequence
        if (not 0 < rows <= 2**31 - 1 or sequence > (2**31 - 1) // 128 or
                any(x.device != self.device or x.dtype != torch.bfloat16 or
                    not x.transpose(1, 2).is_contiguous() for x in (query, key))):
            return None
        for norm in (norm_q, norm_k):
            if (type(norm) is not RMSNorm or norm.training or norm.bias is not None or
                    norm.dim != (128,) or norm.weight is None or norm.weight.shape != (128,) or
                    norm.weight.dtype != query.dtype or norm.weight.device != self.device or
                    not norm.weight.is_contiguous() or norm._forward_pre_hooks or norm._forward_hooks or
                    hasattr(norm, "_diffusers_hook") or "forward" in vars(norm)):
                return None
        cos, sin = rope
        if any(x.device != self.device or x.dtype != torch.float32 or x.shape != (sequence, 128)
               or not x.is_contiguous() for x in (cos, sin)):
            return None

        query_out, key_out = torch.empty_like(query), torch.empty_like(key)
        tensors = (query, key, norm_q.weight, norm_k.weight, cos, sin, query_out, key_out)
        arguments = [ctypes.c_void_p(t.data_ptr()) for t in tensors]
        arguments.extend(ctypes.c_int(v) for v in (rows, sequence, heads))
        arguments.extend(ctypes.c_float(norm.eps) for norm in (norm_q, norm_k))
        pointers = (ctypes.c_void_p * len(arguments))(*(ctypes.addressof(v) for v in arguments))
        with torch.cuda.device(self.device):
            stream = torch.cuda.current_stream(self.device)
            self._call("hipModuleLaunchKernel", self.function, (rows + 3) // 4, 2, 1, 128, 1, 1,
                       0, stream.cuda_stream, pointers, None)
            for tensor in tensors:
                tensor.record_stream(stream)
        self.calls += 1
        return query_out, key_out
