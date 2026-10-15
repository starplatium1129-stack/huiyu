"""Single-frame spatial feather assembly shared by VAE and fixed RRDB.

Independent linear partition-of-unity implementation: overlapping tiles have
symmetric ramps, multiplied at corners, then weighted sums are normalized.
The product uses CPU FP32 intermediates, never a complete upscaled GPU canvas.
"""


def finite_rows(values):
    """Reduce CPU image finiteness with only 128 rows of boolean scratch."""
    import torch
    finite = torch.ones((), dtype=torch.bool, device=values.device)
    for batch in values:
        for top in range(0, batch.shape[-2], 128):
            finite &= torch.isfinite(batch[..., top:top + 128, :]).all()
    return finite


def stitch(samples, operation, *, tile, overlap, scale, channels, report):
    import torch
    height, width = samples.shape[-2:]
    target = (round(height * scale), round(width * scale))
    result = torch.zeros((samples.shape[0], channels, *target), dtype=torch.float32, device="cpu")
    finite = torch.isfinite(samples).all()
    positions = [range(0, length - overlap, tile - overlap) if length > tile else (0,)
                 for length in (height, width)]
    whole = height <= tile and width <= tile
    calls = 0
    for batch in range(samples.shape[0]):
        divisor = None if whole else torch.zeros((1, 1, *target), dtype=torch.float32, device="cpu")
        for top in positions[0]:
            for left in positions[1]:
                patch = samples[batch:batch + 1, :, top:top + tile, left:left + tile]
                predicted = operation(patch)
                expected = (1, channels, round(patch.shape[-2] * scale), round(patch.shape[-1] * scale))
                if tuple(predicted.shape) != expected:
                    raise ValueError("Spatial tile returned incompatible output dimensions")
                finite = finite.to(predicted.device) & torch.isfinite(predicted).all()
                pixels = predicted.detach().to(device="cpu", dtype=torch.float32)
                calls += 1
                del predicted, patch
                y, x = round(top * scale), round(left * scale)
                bottom, right = y + pixels.shape[-2], x + pixels.shape[-1]
                destination = result[batch:batch + 1, :, y:bottom, x:right]
                if whole:
                    destination.copy_(pixels)
                else:
                    feather = round(overlap * scale)
                    axes = []
                    for length in pixels.shape[-2:]:
                        coordinate = torch.arange(1, length + 1, dtype=torch.float32)
                        axes.append((coordinate / feather).clamp_max(1) *
                                    (coordinate.flip(0) / feather).clamp_max(1)
                                    if 0 < feather < length else torch.ones(length))
                    # Keep each full-tile ramp and the original separate FP32
                    # multiply/add order. CPU pixels may alias the operation's
                    # output, so bound scratch without modifying those pixels.
                    for row in range(0, pixels.shape[-2], 128):
                        end = min(row + 128, pixels.shape[-2])
                        weight = (axes[0][row:end, None] * axes[1][None, :])[None, None]
                        destination[:, :, row:end].add_(pixels[:, :, row:end] * weight)
                        divisor[:, :, y + row:y + end, x:right].add_(weight)
                        del weight
                del pixels, destination
        if divisor is not None:
            result[batch:batch + 1].div_(divisor)
    if not bool(finite) or not bool(finite_rows(result)):
        raise ValueError("Spatial tile input/output contains nonfinite values; refusing corrupted output")
    report.update(tileSize=tile, overlap=overlap, tileCount=calls, outputDevice="cpu")
    return result
