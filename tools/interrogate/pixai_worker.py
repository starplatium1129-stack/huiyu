"""Offline, serial JSONL PixAI worker. Rust owns cancellation and process lifetime."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import traceback
import warnings

ENGINE = 'pixai'
MODEL = 'pixai-tagger-v1.0'
MANIFEST = Path(__file__).with_name('pixai-manifest.json')
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_SIDE = 8192
MAX_PIXELS = 32 * 1024 * 1024
ALLOCATOR_BYTES = 3 * 1024**3
MIN_FREE_BYTES = 4 * 1024**3
RATING_NAMES = {'rating:g': 'general', 'rating:s': 'sensitive',
                'rating:q': 'questionable', 'rating:e': 'explicit'}


class PixaiError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def threshold_value(value=0.17):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PixaiError('INVALID_PARAMETER', '反推阈值必须是数字')
    if not math.isfinite(value) or not 0.05 <= value <= 0.95:
        raise PixaiError('INVALID_PARAMETER', '反推阈值需在 0.05–0.95 之间')
    return float(value)


def verify_model(model_dir, manifest=None):
    manifest = manifest or json.loads(MANIFEST.read_text(encoding='utf-8'))
    model_dir = Path(model_dir)
    for entry in manifest['files']:
        file = model_dir / entry['path']
        try:
            if not file.is_file():
                raise PixaiError('PIXAI_MODEL_MISSING', f"PixAI 模型文件缺失：{entry['path']}")
            if file.stat().st_size != entry['bytes']:
                raise PixaiError('PIXAI_MODEL_INTEGRITY', f"PixAI 模型文件体积不匹配：{entry['path']}")
            with file.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            if digest != entry['sha256']:
                raise PixaiError('PIXAI_MODEL_INTEGRITY', f"PixAI 模型文件校验失败：{entry['path']}")
        except OSError as error:
            raise PixaiError('PIXAI_MODEL_MISSING', '无法读取本机 PixAI 模型文件') from error
    return manifest


def read_image(image_path):
    from PIL import Image, ImageOps, UnidentifiedImageError
    if not isinstance(image_path, str) or not os.path.isabs(image_path):
        raise PixaiError('INVALID_IMAGE', '反推图片路径无效')
    path = Path(image_path)
    try:
        if not path.is_file() or path.stat().st_size == 0:
            raise PixaiError('INVALID_IMAGE', '无法读取反推图片')
        if path.stat().st_size > MAX_IMAGE_BYTES:
            raise PixaiError('IMAGE_TOO_LARGE', '图片超过 20MB 限制')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format not in {'PNG', 'JPEG', 'WEBP', 'GIF'}:
                    raise PixaiError('INVALID_IMAGE', '仅支持 PNG、JPEG、WebP 或 GIF 图片')
                width, height = image.size
                if min(width, height) < 1 or max(width, height) > MAX_SIDE or width * height > MAX_PIXELS:
                    raise PixaiError('INVALID_IMAGE', '图片尺寸超过 8192 边长或 3200 万像素限制')
                source_format = image.format
                image.seek(0)
                image.load()
                loaded = ImageOps.exif_transpose(image).copy()
        return loaded, {'width': loaded.width, 'height': loaded.height,
                        'imageBytes': path.stat().st_size, 'sourceFormat': source_format}
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError,
            Image.DecompressionBombWarning) as error:
        raise PixaiError('INVALID_IMAGE', '图片损坏或无法安全解码，请换一张图片') from error


def result_payload(labels, splits, probabilities, threshold, meta):
    threshold = threshold_value(threshold)
    if len(labels) != len(probabilities) or sum(count for _, count in splits) != len(labels):
        raise PixaiError('PIXAI_INFERENCE_FAILED', 'PixAI 标签与结果维度不匹配')
    if any(not math.isfinite(score) or not 0 <= score <= 1 for score in probabilities):
        raise PixaiError('PIXAI_INFERENCE_FAILED', 'PixAI 返回了无效置信度')
    groups = {}
    offset = 0
    for category, count in splits:
        groups[category] = sorted(zip(labels[offset:offset + count], probabilities[offset:offset + count]),
                                  key=lambda pair: pair[1], reverse=True)
        offset += count
    general = [(tag, float(score)) for tag, score in groups.get('general', []) if score > threshold][:100]
    characters = [tag for tag, score in groups.get('character', []) if score > 0.27][:100]
    ratings = {RATING_NAMES[tag]: float(score) for tag, score in groups.get('rating', []) if tag in RATING_NAMES}
    if set(ratings) != set(RATING_NAMES.values()):
        raise PixaiError('PIXAI_INFERENCE_FAILED', 'PixAI 分级结果缺失')
    return {'ok': True, 'engine': ENGINE, 'model': MODEL,
            'tags': [tag for tag, _ in general], 'scores': dict(general),
            'characterTags': characters, 'rating': ratings, 'meta': meta}


def check_cuda(torch):
    if not torch.cuda.is_available():
        raise PixaiError('PIXAI_GPU_UNAVAILABLE', 'PixAI 需要可用的 NVIDIA CUDA 显卡，不会自动切换 CPU')
    if not torch.cuda.is_bf16_supported():
        raise PixaiError('PIXAI_GPU_UNAVAILABLE', '当前显卡不支持 PixAI 所需的 BF16 推理')
    free, total = torch.cuda.mem_get_info()
    if free < MIN_FREE_BYTES:
        raise PixaiError('PIXAI_GPU_BUSY', 'PixAI 加载需要至少约 4GB 空闲显存，请等待生图结束后重试')
    torch.cuda.set_per_process_memory_fraction(ALLOCATOR_BYTES / total, device=0)


class PixaiModel:
    def __init__(self, model_dir, deps_dir=None, torch_site_packages=None):
        started = time.perf_counter()
        self.model = None
        self.processor = None
        self.torch = None
        self.meta = {}
        manifest = verify_model(model_dir)
        os.environ.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                           'HF_HUB_DISABLE_TELEMETRY': '1', 'HF_HUB_DISABLE_PROGRESS_BARS': '1',
                           'TOKENIZERS_PARALLELISM': 'false', 'PYTHONDONTWRITEBYTECODE': '1'})
        sys.dont_write_bytecode = True
        for location in reversed([deps_dir, torch_site_packages]):
            if location:
                sys.path.insert(0, str(Path(location).resolve()))
        try:
            with contextlib.redirect_stdout(sys.stderr):
                import torch
                self.torch = torch
                torch.set_num_threads(2)
                torch.backends.cuda.matmul.allow_tf32 = False
                check_cuda(torch)
                spec = importlib.util.spec_from_file_location('tagger_pipeline', Path(model_dir) / 'tagger_pipeline.py')
                official = importlib.util.module_from_spec(spec)
                sys.modules['tagger_pipeline'] = official
                spec.loader.exec_module(official)
                model, loading = official.ViTDetCls.from_pretrained(
                    str(model_dir), local_files_only=True, dtype=torch.bfloat16, output_loading_info=True)
                if any(loading.get(key) for key in ['missing_keys', 'unexpected_keys', 'mismatched_keys', 'error_msgs']):
                    raise PixaiError('PIXAI_MODEL_INTEGRITY', 'PixAI 权重与固定模型结构不匹配')
                model.eval()
                # Transformers' meta initialization may omit deterministic,
                # nonpersistent RoPE buffers. Rebuild only those frequencies;
                # remove when upstream materializes them during local loading.
                for block in model.blocks:
                    if block.attn.freqs_cis is not None and block.attn.freqs_cis.is_meta:
                        block.attn._setup_rope_freqs()
                if any(t.is_meta for t in list(model.parameters()) + list(model.buffers())):
                    raise PixaiError('PIXAI_MODEL_INTEGRITY', 'PixAI 权重尚未完整加载')
                if any(parameter.dtype != torch.bfloat16 for parameter in model.parameters()):
                    raise PixaiError('PIXAI_MODEL_INTEGRITY', 'PixAI 未按 BF16 精度加载')
                model.to(device='cuda:0')
                torch.cuda.synchronize()
                self.model = model
                self.processor = official.RescalePadProcessor.from_pretrained(str(model_dir), local_files_only=True)
                self.meta = {'revision': manifest['revision'], 'precision': 'BF16 / FP32 sigmoid',
                             'inputSize': 1008, 'allocatorLimitBytes': ALLOCATOR_BYTES,
                             'gpu': torch.cuda.get_device_name(0), 'loadSeconds': round(time.perf_counter() - started, 4)}
        except ImportError as error:
            traceback.print_exception(error, file=sys.stderr)
            self.close()
            raise PixaiError('PIXAI_DEPENDENCY_MISSING', 'PixAI Python 依赖缺失，请运行 models:prepare-pixai') from error
        except Exception as error:
            self.close()
            self.raise_runtime_error(error)

    def raise_runtime_error(self, error):
        if isinstance(error, PixaiError):
            raise error
        traceback.print_exception(error, file=sys.stderr)
        if self.torch is not None and isinstance(error, self.torch.cuda.OutOfMemoryError):
            raise PixaiError('PIXAI_OUT_OF_MEMORY', 'PixAI 显存不足或超过 3GB 推理分配预算，请等待其他任务结束') from error
        raise PixaiError('PIXAI_INFERENCE_FAILED', 'PixAI 本机推理失败，请检查模型与 CUDA 环境') from error

    def infer(self, image_path, threshold=0.17):
        threshold = threshold_value(threshold)
        image, image_meta = read_image(image_path)
        torch = self.torch
        inputs = logits = probabilities = None
        started = time.perf_counter()
        try:
            with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                inputs = self.processor(image)['pixel_values'].to(device='cuda:0', dtype=torch.bfloat16)
                if tuple(inputs.shape) != (1, 3, 1008, 1008):
                    raise PixaiError('PIXAI_INFERENCE_FAILED', 'PixAI 图片预处理尺寸不匹配')
                torch.cuda.reset_peak_memory_stats()
                logits = self.model(inputs)
                probabilities = logits.float().sigmoid()[0].cpu().tolist()
                meta = {**self.meta, **image_meta, 'inferenceSeconds': round(time.perf_counter() - started, 6),
                        'peakAllocatedBytes': torch.cuda.max_memory_allocated(),
                        'peakReservedBytes': torch.cuda.max_memory_reserved(), 'characterThreshold': 0.27}
                return result_payload(self.model.config.tags, self.model.config.tags_split, probabilities, threshold, meta)
        except Exception as error:
            self.raise_runtime_error(error)
        finally:
            image.close()
            del inputs, logits, probabilities

    def close(self):
        self.processor = None
        self.model = None
        if self.torch is not None and self.torch.cuda.is_initialized():
            self.torch.cuda.empty_cache()


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(',', ':')), flush=True)


def error_payload(error):
    if isinstance(error, PixaiError):
        return {'ok': False, 'code': error.code, 'error': str(error)}
    traceback.print_exception(error, file=sys.stderr)
    return {'ok': False, 'code': 'PIXAI_INFERENCE_FAILED', 'error': 'PixAI 本机推理失败，请检查模型与 CUDA 环境'}


def serve(model, incoming=sys.stdin, writer=emit):
    while True:
        line = incoming.readline(16 * 1024 + 1)
        if not line:
            return
        request_id = None
        try:
            if len(line) > 16 * 1024:
                raise PixaiError('INVALID_PARAMETER', 'PixAI 请求过长')
            try:
                request = json.loads(line)
            except json.JSONDecodeError as error:
                raise PixaiError('INVALID_PARAMETER', 'PixAI 请求 JSON 无效') from error
            if not isinstance(request, dict):
                raise PixaiError('INVALID_PARAMETER', 'PixAI 请求必须是 JSON 对象')
            request_id = request.get('requestId')
            if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
                raise PixaiError('INVALID_PARAMETER', 'PixAI 请求身份无效')
            result = model.infer(request.get('imagePath'), request.get('threshold', 0.17))
            writer({'requestId': request_id, **result})
        except Exception as error:
            writer({'requestId': request_id, **error_payload(error)})
            if len(line) > 16 * 1024:
                return


def main():
    # The JSONL protocol is UTF-8 even when launched under Windows CP936.
    for stream in [sys.stdin, sys.stdout, sys.stderr]:
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='strict')
    parser = argparse.ArgumentParser(description='Offline serial PixAI JSONL worker; model remains loaded until shutdown.')
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--deps-dir', type=Path)
    parser.add_argument('--torch-site-packages', type=Path)
    args = parser.parse_args()
    model = None
    try:
        model = PixaiModel(args.model_dir.resolve(), args.deps_dir, args.torch_site_packages)
        emit({'kind': 'ready', 'ok': True, 'engine': ENGINE, 'model': MODEL, 'meta': model.meta})
        serve(model)
        return 0
    except Exception as error:
        emit({'kind': 'ready', 'engine': ENGINE, 'model': MODEL, **error_payload(error)})
        return 1
    finally:
        if model is not None:
            model.close()


if __name__ == '__main__':
    sys.exit(main())
