"""Wan-Animate-2 distilled, using the pinned Diffusers modular pipeline."""
from contextlib import contextmanager
import os
import subprocess
import sys
import tempfile
import time

from huiyu_worker_lifecycle import load_sibling


def driving_frames(path, data, control):
    """Decode a bounded local MP4 prefix, resampled to the requested FPS and canvas."""
    from PIL import Image
    error = load_sibling("adapter_contract").AdapterError
    width, height = data["width"], data["height"]
    count, fps = data["frames"], data["fps"]
    frame_size = width * height * 3
    filters = (f"fps={fps},scale={width}:{height}:force_original_aspect_ratio=decrease,"
               f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1")
    # Force the MP4 demuxer and H.264 decoder; external MOV data references stay disabled.
    args = [load_sibling("adapter_media").encoder(error), "-nostdin", "-hide_banner", "-loglevel", "error",
            "-xerror", "-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0",
            "-use_absolute_path", "0", "-max_pixels", str(4096**2), "-c:v", "h264", "-i", path,
            "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filters, "-frames:v", str(count),
            "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    with tempfile.TemporaryFile() as raw, tempfile.TemporaryFile() as log:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=raw, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            deadline = time.monotonic() + 120
            while process.poll() is None:
                control.check()
                if time.monotonic() >= deadline:
                    raise error("INVALID_MOTION_VIDEO", "动作视频解码超时，请缩短或压缩素材后重试。")
                time.sleep(0.05)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        control.check()
        if process.returncode:
            log.seek(0)
            detail = log.read(1024).decode("utf-8", errors="replace").strip()
            raise error("INVALID_MOTION_VIDEO", f"无法解码 H.264 MP4 动作视频：{detail}")
        if os.fstat(raw.fileno()).st_size != frame_size * count:
            raise error("INVALID_MOTION_VIDEO", f"动作视频不足 {count / fps:g} 秒，请选择较短的时长或更长的素材。")
        raw.seek(0)
        frames = []
        for _ in range(count):
            control.check()
            frames.append(Image.frombytes("RGB", (width, height), raw.read(frame_size)))
        return frames


@contextmanager
def frame_attention(pipeline, device, control):
    """Evaluate the pinned Wan mask by frame, without materializing a dense mask or requiring Triton.

    Each query sees every valid generation token. Frames after the conditioning
    slot additionally see the matching reference frame. The upstream packer
    aligns both streams to 128; padding outside their valid lengths is excluded.
    The enclosing video adapter owns dispatch (including backend observations).
    """
    transformer = pipeline.transformer
    module = sys.modules[type(transformer).__module__]
    original = module.dispatch_attention_fn
    old_masks = transformer.block_masks
    transformer.block_masks = {}
    old_method = transformer.__dict__.get("create_mask")
    layer_cache = module.WanAnimate2KVLayerCache

    class OffloadedLayerCache(layer_cache):
        # The reference video produces an additional K/V pair per layer for
        # each segment. Weight offload alone cannot reclaim these tensors.
        def store(self, key, value):
            super().store(key.to("cpu"), value.to("cpu"))

        def get(self):
            key, value = super().get()
            return key.to(device), value.to(device)

    def dispatch(query, key, value, attn_mask=None, **options):
        if options.get("backend") != module.AttentionBackendName.FLEX:
            return original(query, key, value, attn_mask=attn_mask, **options)
        latent_frames, hw = attn_mask
        valid = (latent_frames + 1) * hw
        ref_start = (valid + 127) // 128 * 128
        output = query.new_zeros(query.shape)
        # Keep the shared generation prefix once. Overwrite one frame of
        # reference K/V for each subsequent query frame.
        k = key.new_empty((key.size(0), valid + hw, *key.shape[2:]))
        v = value.new_empty((value.size(0), valid + hw, *value.shape[2:]))
        k[:, :valid].copy_(key[:, :valid])
        v[:, :valid].copy_(value[:, :valid])
        output[:, :hw] = original(query[:, :hw], k[:, :valid], v[:, :valid])
        for frame in range(latent_frames):
            control.check()
            ref = slice(ref_start + frame * hw, ref_start + (frame + 1) * hw)
            target = slice((frame + 1) * hw, (frame + 2) * hw)
            k[:, valid:].copy_(key[:, ref])
            v[:, valid:].copy_(value[:, ref])
            output[:, target] = original(query[:, target], k, v)
        return output

    # The worker serializes jobs. Scope both patches to this generation, and
    # never leave synthetic mask descriptors on the resident transformer.
    transformer.create_mask = lambda frames, hw, device: (frames, hw)
    module.dispatch_attention_fn = dispatch
    if pipeline._huiyu_memory.policy == "offload":
        module.WanAnimate2KVLayerCache = OffloadedLayerCache
    try:
        yield
    finally:
        module.dispatch_attention_fn = original
        module.WanAnimate2KVLayerCache = layer_cache
        transformer.block_masks = old_masks
        if old_method is None:
            del transformer.create_mask
        else:
            transformer.create_mask = old_method


def generate(pipeline, data, control, device, image, driving_video):
    import torch
    from PIL import ImageOps
    error = load_sibling("adapter_contract").AdapterError
    if image is None or not driving_video:
        raise error("INVALID_MOTION_VIDEO", "Wan-Animate-2 需要角色图与动作视频。")
    # The model derives aspect ratio from the supplied character canvas and
    # crops to that aspect afterwards. Pad without stretching the character.
    width, height = data["width"], data["height"]
    control.stage("preparing_image")
    frames = driving_frames(driving_video, data, control)
    # Upstream advances 80 frames per 81-frame segment and trims its final padding.
    segments = (len(frames) - 1 + 79) // 80
    total = segments * data["steps"]
    completed = 0
    step = pipeline.scheduler.step

    def on_step(*args, **kwargs):
        nonlocal completed
        control.check()
        result = step(*args, **kwargs)
        completed += 1
        control.progress(completed, total)
        if completed == total:
            control.stage("decoding")
        return result

    pipeline.scheduler.step = on_step
    try:
        with ImageOps.pad(image, (width, height), color="black") as character, frame_attention(pipeline, device, control):
            control.stage("encoding")
            output = pipeline(prompt=data["prompt"], image=character, driving_video=frames,
                              width=width, height=height, fps=data["fps"], num_inference_steps=data["steps"],
                              segment_frame_length=81, prev_segment_conditioning_frames=1,
                              generator=torch.Generator(device=device).manual_seed(data["seed"]),
                              output_type="np", output="videos")
        return output[0], None, None
    finally:
        pipeline.scheduler.step = step
        for frame in frames:
            frame.close()
