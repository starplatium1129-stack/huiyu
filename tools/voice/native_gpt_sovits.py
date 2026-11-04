#!/usr/bin/env python3
"""Application-owned GPT-SoVITS worker; stdout is reserved for framed replies."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import traceback


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    args = parser.parse_args()

    # GPT-SoVITS and its native libraries print to stdout. Duplicate the pipe
    # before redirecting fd 1 so those diagnostics cannot corrupt audio frames.
    output = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.chdir(args.source)
    sys.path.insert(0, str(args.source))
    sys.path.insert(0, str(args.source / "GPT_SoVITS"))

    engine = None
    active = ("", "")
    config = None
    temp = None
    try:
        for line in sys.stdin.buffer:
            request_id = None
            try:
                if len(line) > 65536 or not line.endswith(b"\n"):
                    raise ValueError("语音请求格式无效")
                request = json.loads(line)
                request_id = request.get("id")
                operation = request.get("op")
                if not isinstance(request_id, str) or operation not in ("prepare", "synthesize"):
                    raise ValueError("语音请求格式无效")
                gpt = Path(request["gpt"])
                sovits = Path(request["sovits"])
                reference = Path(request["payload"]["ref_audio_path"])
                if not all(path.is_file() for path in (gpt, sovits, reference)):
                    raise ValueError("角色权重或参考音频不存在")

                if engine is None:
                    import torch
                    import yaml
                    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

                    if not torch.cuda.is_available():
                        raise RuntimeError("当前语音运行环境无法使用 CUDA")
                    with args.config.open("r", encoding="utf-8-sig") as source:
                        values = yaml.safe_load(source)
                    if not isinstance(values, dict) or not isinstance(values.get("custom"), dict):
                        raise ValueError("语音运行配置无效")
                    custom = values["custom"]
                    custom.update(device="cuda", is_half=True,
                                  t2s_weights_path=str(gpt), vits_weights_path=str(sovits))
                    for key in ("bert_base_path", "cnhuhbert_base_path"):
                        path = custom.get(key)
                        if not isinstance(path, str) or not Path(path).is_dir():
                            raise ValueError("语音运行环境缺少文本或音频基础模型")
                    # Upstream saves its active weights while switching voices;
                    # give it a private copy rather than modifying the user's file.
                    args.runtime.mkdir(parents=True, exist_ok=True)
                    temp = tempfile.TemporaryDirectory(prefix="voice-worker-", dir=args.runtime)
                    config_path = Path(temp.name) / "tts_infer.yaml"
                    with config_path.open("w", encoding="utf-8") as target:
                        yaml.safe_dump(values, target, allow_unicode=True)
                    config = TTS_Config(str(config_path))
                    engine = TTS(config)
                    active = (str(gpt), str(sovits))
                elif active != (str(gpt), str(sovits)):
                    active = ("", "")
                    engine.init_vits_weights(str(sovits))
                    engine.init_t2s_weights(str(gpt))
                    active = (str(gpt), str(sovits))

                audio = b""
                if operation == "synthesize":
                    import numpy as np
                    import soundfile as sf

                    generator = engine.run(request["payload"])
                    try:
                        rate, samples = next(generator)
                    finally:
                        generator.close()
                    samples = np.asarray(samples)
                    if samples.size == 0 or not np.isfinite(samples).all() or not np.any(samples):
                        raise RuntimeError("语音模型未生成有效音频")
                    wave = io.BytesIO()
                    sf.write(wave, samples, int(rate), format="WAV")
                    audio = wave.getvalue()
                    if len(audio) > 128 * 1024 * 1024:
                        raise RuntimeError("生成的语音超过大小上限")
                header = {"id": request_id, "event": "result", "bytes": len(audio)}
                output.write(json.dumps(header, ensure_ascii=False).encode("utf-8") + b"\n")
                if audio:
                    output.write(audio)
            except Exception:
                traceback.print_exc(file=sys.stderr)
                # A failed load or inference may leave the upstream model in an
                # unknown state. Do not accept another request in this process.
                reply = {"id": request_id, "event": "error", "message": "本机语音模型加载或生成失败，请查看语音日志"}
                output.write(json.dumps(reply, ensure_ascii=False).encode("utf-8") + b"\n")
                return
    finally:
        if temp is not None:
            temp.cleanup()


if __name__ == "__main__":
    main()
