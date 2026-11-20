"""Task-local Spectrum forecasting for the bundled dense MOSS transformer.

Adapted from hanjq17/Spectrum@4e41f91c93ff66b045332530dd7bcb4c60eafbab,
src/utils/basis_utils.py (Copyright 2026 Jiaqi Han, MIT; SPECTRUM-LICENSE).
Changes: bounded image-feature history, step-count normalization, CPU ridge
weights, streaming FP32 accumulation, separate CFG/skip-layer lanes, guarded
growing forecast windows, cancellation and explicit memory/finite fallback.
Window scheduling follows the MOSS sampler's window_size/flex_window rule:
https://github.com/sorryhyun/ComfyUI-Spectrum-KSampler/blob/main/moss.py
No ComfyUI plugin or Anima TeaCache coefficients are used.
"""
from collections import deque
import math


class SpectrumCache:
    HISTORY = 6
    WARMUP = 6
    TAIL = 3
    DEGREE = 4
    RIDGE = 0.1
    LOW_ERROR = 0.06
    RECOVERY_ERROR = 0.11
    HIGH_ERROR = 0.12
    MAX_ADAPTIVE_WINDOW = 4

    def __init__(self, control, branches, flex_window, *, adaptive=False):
        self.control, self.branches, self.adaptive = control, branches, adaptive
        self.flex_window = flex_window
        self.lanes = {}
        self.coefficients = {}
        self.step = self.total = 0
        self.budget_checked = False
        self.disabled = False
        self.stats = dict(algorithm="moss-spectrum-adaptive-v1" if adaptive else "moss-spectrum-v3", requested=True,
            actualForwards=0, forecastForwards=0, nonfiniteFallbacks=0,
            historySize=self.HISTORY, warmupSteps=self.WARMUP, tailSteps=self.TAIL,
            windowSize=2, flexWindow=flex_window, maxConsecutiveForecasts=0,
            tailHistoryBytesReleased=0,
            performanceVerified=False, qualityVerified=False,
            fallbackReason=None)
        if adaptive:
            self.stats.update(anchorChecks=0, anchorMeanError=None, anchorMaxError=None,
                              windowShrinks=0, windowGrowths=0)

    def clear(self):
        self.lanes.clear()
        self.coefficients.clear()

    def begin_step(self, step, total):
        self.step, self.total = step, total
        if step == max(0, total - self.TAIL):
            self.stats["tailHistoryBytesReleased"] = sum(
                features.numel() * features.element_size()
                for lane in self.lanes.values() for _, features in lane["history"])
            self.clear()

    def check_budget(self, current):
        import torch
        if not self.budget_checked:
            # Inspect free memory with the first real image projection already live.
            required = current.numel() * current.element_size() * (self.HISTORY * self.branches + 6)
            free, _ = torch.cuda.mem_get_info(current.device)
            self.budget_checked = True
            if free < required + 512 * 1024 * 1024:
                self._disable_for_memory()

    def _disable_for_memory(self):
        self.disabled = True
        self.clear()
        self.stats["fallbackReason"] = "insufficient-vram-headroom"

    def _invalid_history(self, lane, reason):
        if lane is not None:
            lane["history"].clear()
            lane["streak"] = 0
            if self.adaptive:
                lane["stable"], lane["window"] = 0, 1.0
        if reason.startswith("nonfinite"):
            self.stats["nonfiniteFallbacks"] += 1
        self.stats["fallbackReason"] = reason

    def predict(self, key, shape):
        import torch
        self.control.check()
        if self.disabled or self.step >= self.total - self.TAIL:
            return None
        lane = self.lanes.get(key)
        if lane is None or lane["shape"] != shape:
            lane = dict(shape=shape, history=deque(maxlen=self.HISTORY), streak=0, window=2.0, stable=0)
            self.lanes[key] = lane
        # Community MOSS window scheduling: an actual forward every floor(N)
        # steps, with N growing only after non-warmup actual observations.
        cap = max(1, math.floor(lane["window"])) - 1
        if (self.step < self.WARMUP
                or lane["streak"] >= cap or len(lane["history"]) < self.HISTORY):
            lane["streak"] = 0
            return None
        try:
            prediction = self._forecast(lane["history"])
            finite = bool(torch.isfinite(prediction).all().item())
        except torch.OutOfMemoryError:
            self._disable_for_memory()
            return None
        except torch.linalg.LinAlgError:
            self._invalid_history(lane, "forecast-fit-failed")
            return None
        if not finite:
            self._invalid_history(lane, "nonfinite-forecast")
            return None
        self.control.check()
        lane["streak"] += 1
        self.stats["forecastForwards"] += 1
        self.stats["maxConsecutiveForecasts"] = max(self.stats["maxConsecutiveForecasts"], lane["streak"])
        return prediction

    def update(self, key, features):
        import torch
        self.control.check()
        self.stats["actualForwards"] += 1
        if self.disabled:
            return
        lane = self.lanes.get(key)
        if lane is not None and not self.adaptive and self.step >= self.WARMUP:
            lane["window"] = round(lane["window"] + self.flex_window, 3)
        try:
            if not bool(torch.isfinite(features).all().item()):
                self._invalid_history(lane, "nonfinite-actual-features")
                return
            # No later prediction consumes the last three real features. Their
            # predecessors were released before the first tail block ran.
            if lane is None:
                return
            lane["streak"] = 0
            if self.adaptive and self.step >= self.WARMUP and len(lane["history"]) == self.HISTORY:
                self._adjust_window(lane, features)
            lane["history"].append((self.step, features.detach().clone()))
        except torch.OutOfMemoryError:
            self._disable_for_memory()

    @staticmethod
    def _sample(features, grid):
        # Slice evenly across both image axes and channels. These are strided
        # views of at most 8 * 8 * 32 scalars, including on rectangular images.
        height, width = grid
        dy, dx = math.ceil(height / 8), math.ceil(width / 8)
        dc = math.ceil(features.shape[-1] / 32)
        row, column, channel = dy // 2, dx // 2, dc // 2
        return features.unflatten(1, (height, width))[:, row::dy, column::dx, channel::dc]

    def _adjust_window(self, lane, actual):
        import torch
        grid = lane["shape"][:2]
        try:
            predicted = self._forecast(lane["history"], grid).float()
        except torch.linalg.LinAlgError:
            self._invalid_history(lane, "forecast-fit-failed")
            return
        observed = self._sample(actual, grid).float()
        norm = torch.linalg.vector_norm
        denominator = (norm(predicted) + norm(observed)).clamp_min(1e-6)
        error = (2 * norm(predicted - observed) / denominator).item()
        if not math.isfinite(error):
            self._invalid_history(lane, "nonfinite-forecast")
            return
        error = min(2., error)
        self.stats["anchorChecks"] += 1
        mean = self.stats["anchorMeanError"] or 0.
        self.stats["anchorMeanError"] = mean + (error - mean) / self.stats["anchorChecks"]
        self.stats["anchorMaxError"] = max(self.stats["anchorMaxError"] or 0., error)
        paused = lane["window"] == 1.0
        if error >= self.HIGH_ERROR:
            self.stats["windowShrinks"] += lane["window"] > 1
            lane["window"], lane["stable"] = 1.0, 0
        elif error <= self.LOW_ERROR or (paused and error < self.RECOVERY_ERROR):
            lane["stable"] += 1
            if lane["stable"] >= 2:
                # Two acceptable real steps may resume alternating real/forecast
                # steps. Further growth needs a fresh pair of low-error anchors.
                window = 2.0 if paused else min(self.MAX_ADAPTIVE_WINDOW, round(lane["window"] + self.flex_window, 3))
                self.stats["windowGrowths"] += window > lane["window"]
                lane["window"], lane["stable"] = window, 0
        else:
            lane["stable"] = 0

    def _forecast(self, history, grid=None):
        import torch
        key = (tuple(row[0] for row in history), self.step, self.total)
        weights = self.coefficients.get(key)
        if weights is None:
            weights = self._weights(*key)
            self.coefficients[key] = weights
        latest = history[-1][1]
        result = torch.zeros_like(self._sample(latest, grid) if grid else latest, dtype=torch.float32)
        for weight, (_, features) in zip(weights, history):
            self.control.check()
            result.add_(self._sample(features, grid) if grid else features, alpha=weight)
        return result.to(dtype=latest.dtype)

    def _weights(self, history_steps, step, total):
        import torch
        ticks = torch.tensor(history_steps, dtype=torch.float64, device="cpu")
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
        ratio = (step - history_steps[-1]) / (history_steps[-1] - history_steps[-2])
        weights[-1] += 0.5 * (1 + ratio)
        weights[-2] -= 0.5 * ratio
        return weights.tolist()
