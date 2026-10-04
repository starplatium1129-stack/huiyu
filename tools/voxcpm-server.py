#!/usr/bin/env python3
"""Local VoxCPM2 role service. Uses existing base weights and character LoRAs."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import threading

import anyio
from fastapi import FastAPI, HTTPException
from starlette.requests import Request as HttpRequest
from fastapi.responses import Response, StreamingResponse
import numpy as np
from pydantic import BaseModel, Field
import soundfile as sf
import torch
import uvicorn


class Request(BaseModel):
    voice: str = Field(pattern="^(nene|natsume)$")
    text: str = Field(default="準備", min_length=1, max_length=2000)
    ref_audio_path: str
    prompt_text: str = Field(min_length=1, max_length=2000)
    lora_weights_path: str
    text_lang: str = Field(default="ja", pattern="^(ja|zh)$")
    speed_factor: float = Field(default=1, ge=.75, le=1.35)
    seed: int = Field(default=1234, ge=0, le=2147483647)
    media_type: str = Field(default="wav", pattern="^(wav|raw)$")
    streaming_mode: bool = False


class Engine:
    rate = 48000

    def __init__(self, ai_root: Path, config: Path):
        sys.path.insert(0, str(ai_root / "VoxCPM/src"))
        from voxcpm.model.voxcpm2 import VoxCPM2Model, LoRAConfig

        self.lock = threading.Lock()
        self.voice = ""
        self.adapter = ""
        self.prompts = {}
        saved = json.loads(config.read_text("utf-8-sig"))
        profiles = saved.get("voices", {})
        selected = next(((role, p) for role, p in profiles.items() if p.get("loraWeightsPath")), None)
        if not selected:
            raise RuntimeError("尚未配置 VoxCPM2 角色 LoRA")
        role, first = selected
        adapter = Path(first["loraWeightsPath"])
        folder = adapter if adapter.is_dir() else adapter.parent
        lora = json.loads((folder / "lora_config.json").read_text("utf-8"))["lora_config"]
        self.model = self.load_model(ai_root / "Voice/models/pretrained/VoxCPM2", LoRAConfig(**lora), adapter)
        os.environ.setdefault("TORCHINDUCTOR_COMPILE_THREADS", "1")
        os.environ.setdefault("TORCHINDUCTOR_CACHE_DIR", str(ai_root / "Voice/cache/voxcpm2/inductor"))
        os.environ.setdefault("TRITON_CACHE_DIR", str(ai_root / "Voice/cache/voxcpm2/triton"))
        self.model.optimize()
        self.optimized = hasattr(self.model, "_feat_encoder_raw")
        if self.optimized:
            request = Request(voice=role, ref_audio_path=first["refAudioPath"],
                              prompt_text=first["promptText"], lora_weights_path=str(adapter))
            prompt = self.activate(request)
            print("正在预热 VoxCPM2 编译加速…", flush=True)
            with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                self.model.generate_with_prompt_cache(target_text="こんにちは。", prompt_cache=prompt,
                    max_len=4, inference_timesteps=10, cfg_value=2.0, seed=1234)

    @staticmethod
    def load_model(folder: Path, lora, adapter: Path):
        # The official from_local builds a full CPU model before mapping another
        # checkpoint copy. On this 32GB Windows host that exceeds commit memory.
        # Meta parameters and per-tensor placement retain the same runtime dtypes.
        from accelerate import init_empty_weights
        from accelerate.utils import set_module_tensor_to_device
        from safetensors import safe_open
        from transformers import LlamaTokenizerFast
        from voxcpm.model.voxcpm2 import VoxCPM2Model, VoxCPMConfig, AudioVAEV2

        config = VoxCPMConfig.model_validate_json((folder / "config.json").read_text("utf-8"))
        tokenizer = LlamaTokenizerFast.from_pretrained(str(folder))
        with init_empty_weights():
            vae = AudioVAEV2(config=config.audio_vae_config)
            model = VoxCPM2Model(config, tokenizer, vae, lora, device="cuda")
            model.to(torch.bfloat16)
            model.audio_vae.to(torch.float32)
        tensors = dict(model.named_parameters()) | dict(model.named_buffers())

        def place(name, value):
            if name in tensors:
                set_module_tensor_to_device(model, name, "cuda", value=value, dtype=tensors[name].dtype)

        with safe_open(str(folder / "model.safetensors"), framework="pt", device="cpu") as weights:
            for name in weights.keys():
                if not name.startswith("audio_vae."):
                    place(name, weights.get_tensor(name))
        vae_state = torch.load(folder / "audiovae.pth", map_location="cpu", weights_only=True)
        for name, value in vae_state.get("state_dict", vae_state).items():
            place("audio_vae." + name, value)
        adapter_file = adapter / "lora_weights.safetensors" if adapter.is_dir() else adapter
        with safe_open(str(adapter_file), framework="pt", device="cpu") as weights:
            for name in weights.keys():
                place(name, weights.get_tensor(name))
        missing = [name for name, parameter in model.named_parameters() if parameter.is_meta]
        if missing:
            raise RuntimeError("模型权重缺失：" + ", ".join(missing[:8]))
        # Nonpersistent rotary/LoRA and sample-rate buffers are initialized on
        # CPU and are absent from checkpoints; move them with the loaded model.
        return model.to(device="cuda").eval().requires_grad_(False)

    def activate(self, request: Request):
        adapter = Path(request.lora_weights_path)
        audio = Path(request.ref_audio_path)
        if not audio.is_file() or not (adapter.is_file() or adapter.is_dir()):
            raise ValueError("角色 LoRA 或参考音不存在")
        if self.adapter != str(adapter):
            loaded, skipped = self.model.load_lora_weights(str(adapter))
            if not loaded or skipped:
                self.adapter = ""
                raise ValueError("角色 LoRA 未完整加载")
            self.model.set_lora_enabled(True)
            self.adapter = str(adapter)
        self.voice = request.voice
        key = (str(adapter), str(audio), request.prompt_text)
        if key not in self.prompts:
            with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                prompt = self.model.build_prompt_cache(
                    prompt_text=request.prompt_text, prompt_wav_path=str(audio),
                    reference_wav_path=str(audio),
                )
            # The app has six emotion references per role. Bound custom edits too.
            if len(self.prompts) >= 16:
                self.prompts.pop(next(iter(self.prompts)))
            self.prompts[key] = prompt
        return self.prompts[key]

    def prepare(self, request: Request):
        with self.lock:
            self.activate(request)

    def chunks(self, request: Request, stopped: threading.Event):
        with self.lock:
            if stopped.is_set():
                return
            prompt = self.activate(request)
            arguments = dict(target_text=request.text, prompt_cache=prompt, seed=request.seed,
                             cfg_value=2.0, inference_timesteps=10, max_len=2000)
            if request.speed_factor != 1:
                # Workbench tempo control preserves pitch. Chat streams at speed 1.
                import librosa
                with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                    samples = self.model.generate_with_prompt_cache(**arguments)[0].float().cpu().numpy().reshape(-1)
                if stopped.is_set():
                    return
                samples = librosa.effects.time_stretch(samples, rate=request.speed_factor)
                yield self.pcm(samples)
                return
            generator = self.model.generate_with_prompt_cache_streaming(**arguments)
            try:
                while not stopped.is_set():
                    # StreamingResponse can resume on different worker threads;
                    # enter the thread-local torch contexts for each next().
                    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                        item = next(generator, None)
                    if item is None:
                        break
                    samples = item[0].float().cpu().numpy().reshape(-1)
                    if samples.size:
                        yield self.pcm(samples)
            finally:
                with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                    generator.close()

    @staticmethod
    def pcm(samples):
        if not np.isfinite(samples).all():
            raise ValueError("模型返回了无效音频")
        return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def application(ai_root: Path, config: Path):
    engine = None

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        nonlocal engine
        engine = await anyio.to_thread.run_sync(lambda: Engine(ai_root, config))
        yield
        engine = None
        torch.cuda.empty_cache()

    app = FastAPI(title="VoxCPM2 character voices", lifespan=lifespan)

    @app.get("/health")
    def health():
        return {"online": engine is not None, "engine": "VoxCPM2", "optimized": bool(engine and engine.optimized),
                "activeVoice": engine.voice if engine else ""}

    @app.post("/prepare")
    async def prepare(request: Request):
        try:
            await anyio.to_thread.run_sync(lambda: engine.prepare(request))
        except (ValueError, OSError) as error:
            raise HTTPException(400, str(error)) from error
        return {"ok": True, "voice": request.voice}

    @app.post("/tts")
    async def tts(request: Request, connection: HttpRequest):
        if request.streaming_mode and request.media_type == "raw":
            stopped = threading.Event()
            iterator = engine.chunks(request, stopped)
            end = object()

            async def stream():
                try:
                    while True:
                        chunk = await anyio.to_thread.run_sync(lambda: next(iterator, end))
                        if chunk is end:
                            break
                        yield chunk
                finally:
                    stopped.set()
                    with anyio.CancelScope(shield=True):
                        await anyio.to_thread.run_sync(iterator.close)

            return StreamingResponse(stream(), media_type="audio/pcm", headers={
                "X-Audio-Sample-Rate": str(engine.rate), "X-Audio-Channels": "1",
                "X-Audio-Format": "pcm_s16le", "X-Accel-Buffering": "no",
            })
        stopped = threading.Event()

        def collect():
            raw = b"".join(engine.chunks(request, stopped))
            if stopped.is_set():
                return b""
            if not raw:
                raise ValueError("模型返回了空音频")
            wave = io.BytesIO()
            sf.write(wave, np.frombuffer(raw, dtype="<i2"), engine.rate, format="WAV", subtype="PCM_16")
            return wave.getvalue()

        async def watch_disconnect():
            while not stopped.is_set():
                if await connection.is_disconnected():
                    stopped.set()
                    return
                await asyncio.sleep(.1)

        watcher = asyncio.create_task(watch_disconnect())
        try:
            audio = await anyio.to_thread.run_sync(collect)
        except (ValueError, OSError) as error:
            raise HTTPException(400, str(error)) from error
        finally:
            stopped.set()
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
        return Response(audio, media_type="audio/wav")

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ai-root", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "::1"])
    parser.add_argument("--port", type=int, default=9880)
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    torch.set_num_threads(4)
    uvicorn.run(application(args.ai_root, args.config), host=args.host, port=args.port, log_level="info")
