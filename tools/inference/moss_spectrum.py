"""Task-local Spectrum forecasting for the bundled dense MOSS transformer.

Adapted from hanjq17/Spectrum@4e41f91c93ff66b045332530dd7bcb4c60eafbab,
src/utils/basis_utils.py (Copyright 2026 Jiaqi Han, MIT; SPECTRUM-LICENSE).
Changes: bounded image-feature history, step-count normalization, CPU ridge
weights, streaming FP32 accumulation, separate CFG/skip-layer lanes, fixed
warmup/refresh/tail schedule, cancellation and explicit memory/finite fallback.
No ComfyUI plugin or Anima TeaCache coefficients are used.
"""
from collections import deque


class SpectrumCache:
    HISTORY = 6
    WARMUP = 6
    TAIL = 3
    DEGREE = 4
    RIDGE = 0.1

    def __init__(self, control, scheduler, branches):
        self.control, self.scheduler, self.branches = control, scheduler, branches
        self.lanes = {}
        self.budget_checked = False
        self.disabled = False
        self.stats = dict(algorithm="moss-spectrum-v1", requested=True,
            actualForwards=0, forecastForwards=0, nonfiniteFallbacks=0,
            historySize=self.HISTORY, warmupSteps=self.WARMUP, tailSteps=self.TAIL,
            maxConsecutiveForecasts=1, performanceVerified=False, qualityVerified=False,
            fallbackReason=None)

    def clear(self):
        self.lanes.clear()

    def _lane(self, key):
        return self.lanes.setdefault(key, dict(step=-1, history=deque(maxlen=self.HISTORY),
            forecast=False, shape=None))

    def predict(self, key, current):
        import torch
        self.control.check()
        lane = self._lane(key)
        lane["step"] += 1
        shape = (tuple(current.shape), current.dtype, current.device)
        if lane["shape"] != shape:
            lane["history"].clear()
            lane["shape"], lane["forecast"] = shape, False
        if not self.budget_checked:
            # History keeps only image features, never the much longer text stream.
            # Leave room for the next block's activations and FP32 accumulation.
            required = current.numel() * current.element_size() * (self.HISTORY * self.branches + 6)
            free, _ = torch.cuda.mem_get_info(current.device)
            self.budget_checked = True
            if free < required + 512 * 1024 * 1024:
                self.disabled = True
                self.stats["fallbackReason"] = "insufficient-vram-headroom"
        step, total = lane["step"], len(self.scheduler.timesteps)
        if (self.disabled or step < self.WARMUP or step >= total - self.TAIL
                or lane["forecast"] or len(lane["history"]) < self.HISTORY):
            lane["forecast"] = False
            return None
        try:
            prediction = self._forecast(lane["history"], step, total)
        except torch.linalg.LinAlgError:
            lane["history"].clear()
            self.stats["fallbackReason"] = "forecast-fit-failed"
            return None
        if not bool(torch.isfinite(prediction).all().item()):
            lane["history"].clear()
            self.stats["nonfiniteFallbacks"] += 1
            self.stats["fallbackReason"] = "nonfinite-forecast"
            return None
        self.control.check()
        lane["forecast"] = True
        self.stats["forecastForwards"] += 1
        return prediction

    def update(self, key, features):
        import torch
        self.control.check()
        lane = self._lane(key)
        self.stats["actualForwards"] += 1
        if self.disabled:
            return
        if not bool(torch.isfinite(features).all().item()):
            lane["history"].clear()
            self.stats["nonfiniteFallbacks"] += 1
            self.stats["fallbackReason"] = "nonfinite-actual-features"
            return
        lane["history"].append((lane["step"], features.detach().clone()))

    def _forecast(self, history, step, total):
        import torch
        ticks = torch.tensor([row[0] for row in history], dtype=torch.float64, device="cpu")
        query = torch.tensor([step], dtype=torch.float64, device="cpu")

        def design(values):
            tau = 2 * values / max(1, total - 1) - 1
            columns = [torch.ones_like(tau), tau]
            for _ in range(2, self.DEGREE + 1):
                columns.append(2 * tau * columns[-1] - columns[-2])
            return torch.stack(columns, -1)

        matrix, query = design(ticks), design(query)
        gram = matrix.T @ matrix + self.RIDGE * torch.eye(self.DEGREE + 1, dtype=matrix.dtype, device="cpu")
        # Compute only scalar forecast weights on CPU. Stream their weighted sum
        # on CUDA instead of allocating a [history, features] FP32 matrix.
        weights = (query @ torch.cholesky_solve(matrix.T, torch.linalg.cholesky(gram)))[0] * 0.5
        ratio = (step - history[-1][0]) / (history[-1][0] - history[-2][0])
        weights[-1] += 0.5 * (1 + ratio)
        weights[-2] -= 0.5 * ratio
        result = torch.zeros_like(history[-1][1], dtype=torch.float32)
        for weight, (_, features) in zip(weights.tolist(), history):
            self.control.check()
            result.add_(features, alpha=weight)
        return result.to(dtype=history[-1][1].dtype)
