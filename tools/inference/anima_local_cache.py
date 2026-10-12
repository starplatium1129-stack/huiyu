"""Experimental local-risk cache metric and empirical calibration envelopes.

Continuous raster-token groups are coarse features, not semantic regions.
No model imports occur until relative_changes is explicitly called.
"""
import math

METRIC = "raster-contiguous-c16-fp32-v1"
MAX_GROUPS = 16


def relative_changes(current, previous):
    """Return device scalars [global mean relative L1, worst token-group L1]."""
    import torch
    import torch.nn.functional as F
    if current.ndim != 3 or current.shape != previous.shape or not all(current.shape):
        raise ValueError("Local cache requires equal nonempty [batch, tokens, channels] features")
    current, previous = current.float(), previous.float()
    difference = (current - previous).abs().mean(dim=-1)
    reference = previous.abs().mean(dim=-1)
    global_change = difference.mean() / reference.mean().clamp_min(1e-8)
    tokens = difference.shape[1]
    width = math.ceil(tokens / MAX_GROUPS)
    groups = math.ceil(tokens / width)
    padding = groups * width - tokens
    numerator = F.pad(difference, (0, padding)).reshape(-1, groups, width).sum(dim=-1)
    denominator = F.pad(reference, (0, padding)).reshape(-1, groups, width).sum(dim=-1)
    counts = torch.full((groups,), width, dtype=torch.float32, device=current.device)
    counts[-1] = tokens - (groups - 1) * width
    local_change = (numerator / torch.maximum(denominator, counts * 1e-8)).amax()
    return torch.stack((global_change, local_change))


def envelopes(phase_points):
    """Three empirical upper envelopes; never a semantic/error guarantee."""
    result = []
    for samples in phase_points:
        observed = {}
        for x, y in samples:
            observed[x] = max(y, observed.get(x, 0))
        if len(samples) < 3 or len(observed) < 2:
            raise ValueError("Each phase needs >=3 paired observations and >=2 distinct proxies")
        ordered = sorted(observed.items())
        size = max(1, math.ceil(len(ordered) / 31))
        points = []
        for start in range(0, len(ordered), size):
            group = ordered[start:start + size]
            upper = max(y for _, y in group)
            if not points:
                points.append([group[0][0], upper])
            if group[-1][0] != points[-1][0]:
                points.append([group[-1][0], upper])
        result.append(points)
    return result


def execution_identity(profile):
    result = {key: profile[key] for key in ("schemaVersion", "algorithm")}
    if profile["schemaVersion"] == 3:
        result.update(localMetric=profile["localMetric"], maxGroups=profile["maxGroups"])
    return result


def verify_execution(report, profile):
    if profile["schemaVersion"] != 3:
        return
    stats = report.get("stats", {})
    if (report.get("cacheProfile") != execution_identity(profile)
            or type(stats.get("localChecks")) is not int or stats["localChecks"] <= 0
            or type(stats.get("localRiskRejects")) is not int or stats["localRiskRejects"] < 0):
        raise ValueError("Local candidate lacks matching algorithm/metric and actual guard observations")
