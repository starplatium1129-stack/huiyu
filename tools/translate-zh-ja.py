#!/usr/bin/env python3
"""Translate short Chinese story/dialogue text to Japanese with a local CPU model.

Two modes:
  1. stdin mode (legacy): reads {"text": "..."} from stdin, prints one JSON line.
  2. --serve mode: keeps the model resident and serves HTTP on 127.0.0.1,
     so repeated translations skip the multi-second model load.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer


REPO_ROOT = Path(__file__).resolve().parents[1]
AI_ROOT = Path(os.environ.get("AI_WORKSPACE_ROOT", REPO_ROOT.parent / "AI"))
DEFAULT_MODEL = AI_ROOT / "Voice" / "models" / "translation" / "m2m100_418m"
MODEL_PATH = Path(os.environ.get("AICS_TRANSLATION_MODEL", DEFAULT_MODEL))
MAX_INPUT_CHARS = 2000
TRANSLATION_BEAMS = max(1, min(4, int(os.environ.get("AICS_TRANSLATION_BEAMS", "1"))))
SEGMENT_CACHE_LIMIT = 512
SEGMENT_CACHE_BYTES_LIMIT = 2 * 1024 * 1024

# Resident model state (serve mode)
_TOKENIZER = None
_MODEL = None
_MODEL_LOCK = threading.Lock()
_SEGMENT_CACHE: OrderedDict[str, tuple[str, int]] = OrderedDict()
_SEGMENT_CACHE_BYTES = 0
_SEGMENT_CACHE_IDENTITY = None


def fail(message: str, code: int = 1) -> int:
    print(json.dumps({"error": message}, ensure_ascii=False))
    return code


def segments(text: str) -> list[str]:
    """Keep dialogue punctuation while staying below the M2M100 input limit."""
    parts = re.split(r"(?<=[。！？!?；;\n])", text.strip())
    result: list[str] = []
    for part in parts:
        part = part.strip()
        while len(part) > 240:
            split_at = max(part.rfind(mark, 0, 240) for mark in "，,、 ")
            split_at = split_at if split_at > 24 else 240
            result.append(part[:split_at + 1].strip())
            part = part[split_at + 1:].strip()
        if part:
            result.append(part)
    return result or [text.strip()]


def normalize_japanese(text: str) -> str:
    text = re.sub(r"\s+([、。！？])", r"\1", text)
    text = re.sub(r"([「『（])\s+", r"\1", text)
    text = re.sub(r"\s+([」』）])", r"\1", text)
    return text.strip()


def load_model():
    """Load tokenizer and model once; reused across requests in serve mode."""
    global _TOKENIZER, _MODEL
    if _TOKENIZER is not None and _MODEL is not None:
        return _TOKENIZER, _MODEL
    if not MODEL_PATH.is_dir():
        raise RuntimeError("本地中日翻译模型尚未安装；请先运行 tools\\install-translation-model.ps1。")
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 4)))
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_PATH, local_files_only=True)
    model.eval()
    if hasattr(tokenizer, "src_lang"):
        tokenizer.src_lang = "zh"
    _TOKENIZER, _MODEL = tokenizer, model
    return tokenizer, model


def bind_segment_cache(tokenizer, model) -> None:
    """A resident model/tokenizer and generation policy own one bounded cache."""
    global _SEGMENT_CACHE_IDENTITY, _SEGMENT_CACHE_BYTES
    identity = _SEGMENT_CACHE_IDENTITY
    if (identity is not None and identity[0] is tokenizer and identity[1] is model
            and identity[2] == TRANSLATION_BEAMS and identity[3] is normalize_japanese):
        return
    _SEGMENT_CACHE.clear()
    _SEGMENT_CACHE_BYTES = 0
    _SEGMENT_CACHE_IDENTITY = (tokenizer, model, TRANSLATION_BEAMS, normalize_japanese)


def generate_segments(parts: list[str], tokenizer, model) -> list[str]:
    with torch.inference_mode():
        encoded = tokenizer(
            parts,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=384,
        )
        options = {"max_new_tokens": 384, "num_beams": TRANSLATION_BEAMS}
        if TRANSLATION_BEAMS > 1:
            options["early_stopping"] = True
        if hasattr(tokenizer, "get_lang_id"):
            options["forced_bos_token_id"] = tokenizer.get_lang_id("ja")
        generated = model.generate(**encoded, **options)
        translations = tokenizer.batch_decode(generated, skip_special_tokens=True)
    if len(translations) != len(parts):
        raise RuntimeError("中日翻译返回的分句数量不完整。")
    translations = [normalize_japanese(translation) for translation in translations]
    if any(not translation for translation in translations):
        raise RuntimeError("中日翻译返回了空白分句。")
    return translations


def remember_segments(parts: list[str], translations: list[str]) -> None:
    global _SEGMENT_CACHE_BYTES
    # Prepare every entry before writing: a failed/partial batch adds nothing.
    entries = [
        (part, translation, len(part.encode("utf-8")) + len(translation.encode("utf-8")))
        for part, translation in zip(parts, translations)
    ]
    for part, translation, size in entries:
        if size > SEGMENT_CACHE_BYTES_LIMIT:
            continue
        _SEGMENT_CACHE[part] = (translation, size)
        _SEGMENT_CACHE_BYTES += size
        while (len(_SEGMENT_CACHE) > SEGMENT_CACHE_LIMIT
               or _SEGMENT_CACHE_BYTES > SEGMENT_CACHE_BYTES_LIMIT):
            _, (_, removed_size) = _SEGMENT_CACHE.popitem(last=False)
            _SEGMENT_CACHE_BYTES -= removed_size


def translate_segments(text: str) -> list[dict[str, str]]:
    # Serialize model access and its cache together for both HTTP and stdin.
    with _MODEL_LOCK:
        tokenizer, model = load_model()
        bind_segment_cache(tokenizer, model)
        parts = segments(text)
        resolved: dict[str, str] = {}
        missing: list[str] = []
        for part in dict.fromkeys(parts):
            cached = _SEGMENT_CACHE.get(part)
            if cached is None:
                missing.append(part)
            else:
                _SEGMENT_CACHE.move_to_end(part)
                resolved[part] = cached[0]
        if missing:
            translations = generate_segments(missing, tokenizer, model)
            remember_segments(missing, translations)
            resolved.update(zip(missing, translations))
        return [{"source": part, "translation": resolved[part]} for part in parts]


def translate_payload(text: str) -> dict:
    translated = translate_segments(text)
    return {
        "translation": "\n".join(item["translation"] for item in translated),
        "segments": translated,
    }


# ─── stdin 单次模式（保持向后兼容）───

def main_stdin() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        text = str(request.get("text") or "").strip()
    except json.JSONDecodeError:
        return fail("翻译请求格式无效。")
    if not text or len(text) > MAX_INPUT_CHARS:
        return fail("待翻译中文需在 1—2000 字之间。")
    try:
        print(json.dumps(translate_payload(text), ensure_ascii=False))
        return 0
    except Exception as error:
        return fail(str(error))


# ─── 常驻 HTTP 服务模式 ───

class TranslateHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        sys.stderr.write("[translate] " + (format % args) + "\n")

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib signature
        if self.path == "/health":
            self._send_json(200, {
                "ok": True,
                "engine": "m2m100",
                "model": MODEL_PATH.name,
                "beams": TRANSLATION_BEAMS,
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib signature
        if self.path != "/translate":
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > 64 * 1024:
            self._send_json(400, {"error": "请求体大小无效。"})
            return
        try:
            request = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            text = str(request.get("text") or "").strip()
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "翻译请求格式无效。"})
            return
        if not text or len(text) > MAX_INPUT_CHARS:
            self._send_json(400, {"error": "待翻译中文需在 1—2000 字之间。"})
            return
        try:
            payload = translate_payload(text)
            self._send_json(200, payload)
        except Exception as error:  # noqa: BLE001 - 把异常细节回传给网关
            self._send_json(500, {"error": str(error)})


def serve(port: int) -> int:
    try:
        print("[translate] 正在加载本地中日翻译模型…", file=sys.stderr, flush=True)
        load_model()
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", port), TranslateHandler)
    server.daemon_threads = True
    # 就绪标记：网关轮询 /health，同时这行日志方便人工排查
    print(f"[translate] 中日翻译服务已就绪: http://127.0.0.1:{port}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="本地中日翻译")
    parser.add_argument("--serve", action="store_true", help="以常驻 HTTP 服务方式运行（模型只加载一次）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("AICS_TRANSLATE_PORT", "5310")), help="常驻服务监听端口")
    args = parser.parse_args()
    if args.serve:
        return serve(args.port)
    return main_stdin()


if __name__ == "__main__":
    raise SystemExit(main())
