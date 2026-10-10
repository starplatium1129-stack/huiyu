"""Bounded product observations; no added CUDA sync, tensor readback or CUDA init.

PyTorch 2.8 native allocator reset/getStats use CPU bookkeeping under a mutex:
https://github.com/pytorch/pytorch/blob/v2.8.0/c10/cuda/CUDACachingAllocator.cpp#L1674-L1720
https://github.com/pytorch/pytorch/blob/v2.8.0/torch/cuda/memory.py#L329-L344
This source inspection does not measure device overhead or total device VRAM.
"""
import math
import time


def _counts(values, names):
    return {name: values[name] for name in names
            if type(values.get(name)) is int and values[name] >= 0}


class RuntimeMetrics:
    def __init__(self, torch, started):
        self.torch, self.started = torch, started
        self.timings, self.mask_cache = {}, None
        self.tracking = False
        self.memory = dict(status="unverified", reason="not-started", deviceIndex=0,
            scope="image-preparation-through-pipeline", peakAllocatedBytes=None, peakReservedBytes=None)

    def begin_memory(self, explicit_report=False):
        try:
            # Existing TeaCache/measure/collect reports already attempted reset.
            # Preserve that one attempt; never initialize CUDA or retry on failure.
            if not explicit_report and not self.torch.cuda.is_initialized():
                self.memory["reason"] = "cuda-uninitialized-at-window-start"
            elif self.torch.cuda.get_allocator_backend() != "native":
                self.memory["reason"] = "unsupported-allocator"
            else:
                self.torch.cuda.reset_peak_memory_stats(0)
                self.tracking = True
        except Exception:
            self.memory["reason"] = "allocator-observation-error"

    def finish_memory(self):
        if not self.tracking:
            return
        self.tracking = False
        try:
            values = self.torch.cuda.memory_stats(0)
            allocated, reserved = (values[key] for key in ("allocated_bytes.all.peak", "reserved_bytes.all.peak"))
            if any(type(value) is not int or value < 0 for value in (allocated, reserved)):
                raise ValueError("Invalid allocator counters")
            self.memory.update(status="per-job-allocator", reason=None,
                peakAllocatedBytes=allocated, peakReservedBytes=reserved)
        except Exception:
            self.memory["reason"] = "allocator-observation-error"

    def image_prepared(self, started, report, resident, cache_mask, automatic):
        self.timings["imagePreparationWallSeconds"] = time.perf_counter() - started
        if resident is not None and cache_mask and automatic:
            self.mask_cache = resident.mask_cache.stats()
        if report is not None:
            report["imagePreparationSeconds"] = self.timings["imagePreparationWallSeconds"]
            report["maskCacheEnabled"] = resident is not None and cache_mask
            if self.mask_cache is not None:
                report["maskCache"] = self.mask_cache

    def model_acquired(self, started, report, reused, fingerprint, post_load_fingerprint):
        if report is not None:
            self.torch.cuda.synchronize()  # Existing TeaCache report boundary, never added for product observations.
        self.timings["modelAcquireWallSeconds"] = time.perf_counter() - started
        self.timings["residentFingerprintSeconds"] = fingerprint
        if report is not None:
            report.update(residentFingerprintSeconds=fingerprint, modelReused=reused,
                modelLoadSeconds=self.timings["modelAcquireWallSeconds"] - post_load_fingerprint)

    def pipeline_finished(self, started, report, tea, cache_text):
        if report is not None:
            self.torch.cuda.synchronize()  # Preserve the pre-existing report, including its timing scope.
        elapsed = time.perf_counter() - started
        self.timings["pipelineWallSeconds"] = elapsed
        self.finish_memory()
        if report is not None:
            report.update(pipelineSeconds=elapsed, generationSeconds=elapsed,
                timingScope="pipeline includes encoding, denoising and decoding; modelLoad includes LoRAs",
                samples=tea.samples if tea is not None else [], stats=dict(tea.stats) if tea is not None else None,
                peakAllocatedBytes=self.memory["peakAllocatedBytes"], textCacheEnabled=cache_text)

    def result(self, output, reused, resident, cache_text, cache_mask, tea, report, completed_steps):
        self.timings.update(workerWallSeconds=time.perf_counter() - self.started,
                            outputSaveSeconds=output["outputSaveSeconds"])
        text = dict(enabled=resident is not None and cache_text)
        if text["enabled"]:
            text.update(_counts(resident.text_cache.stats(), ("hits", "misses", "entries", "cpuBytes")))
        mask = dict(enabled=resident is not None and cache_mask, used=self.mask_cache is not None)
        if self.mask_cache is not None:
            mask.update({name: self.mask_cache[name] for name in ("modelReused", "resultReused")
                         if type(self.mask_cache.get(name)) is bool})
            mask.update(_counts(self.mask_cache, ("resultBytes",)))
            value = self.mask_cache.get("fingerprintSeconds")
            if type(value) in (float, int) and math.isfinite(value) and value >= 0:
                mask["fingerprintSeconds"] = value
        cached = dict(enabled=report is not None and report["teaCacheEnabled"])
        if tea is not None:
            cached.update(_counts(tea.stats, ("fullComputes", "skippedComputes", "skippedBlocks", "resets", "nonfinite")))
        return dict(schemaVersion=1, timingMode="cpu-wall-no-extra-sync", timingsAreAdditive=False,
            existingReportSynchronization=report is not None, timings=self.timings, baseReused=reused, completedSteps=completed_steps,
            textCache=text, maskCache=mask, teaCache=cached, memory=self.memory)
