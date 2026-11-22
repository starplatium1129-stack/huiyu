"""Real-ESRGAN AnimeVideo and RIFE v4.6, both explicitly on CPU."""
import os
from pathlib import Path
import shutil

from studio_export_assets import RIFE, SR_FILE, SR_SHA, checked_files
from studio_export_process import ExportError


def import_cpu_runtime():
    try:
        import torch
        import numpy
        from PIL import Image
    except ImportError as error:
        raise ExportError("STUDIO_EXPORT_RUNTIME_MISSING", "神经网络超分需要绘遇独立图像 Python 中的 PyTorch、NumPy 和 Pillow。") from error


class Enhancement:
    def __init__(self, model_root, upscale, interpolate):
        self.root = model_root
        self.net = None
        self.threads = min(4, os.cpu_count() or 1)
        if upscale:
            if not checked_files(model_root, {SR_FILE: SR_SHA}):
                raise ExportError("STUDIO_EXPORT_MODELS_MISSING", "缺少经过校验的 Real-ESRGAN AnimeVideo 权重，请准备导出增强组件。")
            self.net = self._network()
        self.rife = interpolate and os.name == "nt" and checked_files(model_root, RIFE)
        self.interpolator = ("rife-v4.6-cpu" if self.rife else "ffmpeg-minterpolate") if interpolate else "none"
        self.upscaler = "realesr-animevideov3-cpu" if upscale else "none"

    def _network(self):
        import torch
        from torch import nn
        torch.set_num_threads(self.threads)
        # Original AnimeVideo v3 is the compact SRVGG network: 17 convolutions
        # with channel-wise PReLU, pixel shuffle x4 and nearest-neighbour residual.
        class AnimeVideo(nn.Module):
            def __init__(self):
                super().__init__()
                ops = []
                for layer in range(17):
                    ops += [nn.Conv2d(3 if layer == 0 else 64, 64, 3, padding=1), nn.PReLU(64)]
                ops.append(nn.Conv2d(64, 48, 3, padding=1))
                self.body = nn.Sequential(*ops)

            def forward(self, x):
                learned = nn.functional.pixel_shuffle(self.body(x), 4)
                residual = nn.functional.interpolate(x, scale_factor=4, mode="nearest")
                return nn.functional.avg_pool2d(learned.add_(residual), 2)
        net = AnimeVideo().cpu().eval()
        weight = torch.load(self.root / SR_FILE, map_location="cpu", weights_only=True)
        net.load_state_dict(weight["params"], strict=True)
        return net.to(memory_format=torch.channels_last)

    def upscale(self, files, destination, session, update):
        import numpy as np
        from PIL import Image
        import torch
        destination.mkdir()
        core, halo = 192, 18
        with torch.inference_mode():
            for position, path in enumerate(files):
                session.check()
                with Image.open(path) as source:
                    rgb = np.array(source.convert("RGB"))
                h, w = rgb.shape[:2]
                frame = np.empty((h * 2, w * 2, 3), dtype=np.uint8)
                for top in range(0, h, core):
                    for left in range(0, w, core):
                        session.check()
                        bottom, right = min(top + core, h), min(left + core, w)
                        y0, x0 = max(0, top - halo), max(0, left - halo)
                        patch = rgb[y0:min(h, bottom + halo), x0:min(w, right + halo)]
                        tensor = torch.from_numpy(np.ascontiguousarray(patch)).permute(2, 0, 1).unsqueeze(0)
                        tensor = tensor.to(dtype=torch.float32, memory_format=torch.channels_last).div_(255)
                        out = self.net(tensor)[0, :, 2*(top-y0):2*(bottom-y0), 2*(left-x0):2*(right-x0)]
                        frame[top*2:bottom*2, left*2:right*2] = out.clamp_(0, 1).mul_(255).round_().byte().permute(1, 2, 0).numpy()
                with Image.fromarray(frame) as image:
                    image.save(destination / f"{position+1:08d}.png", compress_level=1)
                update((position + 1) / len(files))

    def interpolate(self, session, tools, source, target, n, fps, work, update):
        target.mkdir()
        if n == 1:
            file = next(source.glob("*.png"))
            for i in range(1, 3):
                shutil.copyfile(file, target / f"{i:08d}.png")
            return
        if self.rife:
            argv = [str(self.root / "rife-ncnn-vulkan.exe"), "-g", "-1", "-j", f"1:{self.threads}:1",
                    "-m", str(self.root / "rife-v4.6"), "-i", str(source), "-o", str(target),
                    "-n", str(2*n), "-f", "%08d.png"]
            session.run(argv, work, tick=lambda: update(min(.99, len(list(target.glob("*.png"))) / (2*n))))
        else:
            # Padding supplies the look-ahead at each individual shot's edges.
            # Its exact output length is fixed before the next shot is visited.
            vf = (f"tpad=start_mode=clone:start=2:stop_mode=clone:stop=3,"
                  f"minterpolate=fps={fps*2}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir,"
                  f"trim=start_frame=4:end_frame={4+2*n},setpts=PTS-STARTPTS")
            session.run([tools[0], "-filter_threads", str(self.threads), "-framerate", str(fps),
                         "-i", str(source / "%08d.png"), "-vf", vf, "-threads", "2",
                         "-frames:v", str(2*n), str(target / "%08d.png")], work,
                        progress=lambda sec: update(min(.99, sec * float(fps) / n)), ffmpeg=True)

    @staticmethod
    def sequence(directory, count):
        files = sorted(directory.glob("*.png"))
        if len(files) != count:
            raise ExportError("STUDIO_EXPORT_MISSING_FRAMES", f"分镜增强输出了 {len(files)} 帧，预期 {count} 帧。")
        # FFmpeg image2 numbering begins at 1; the pinned RIFE CLI does too.
        if any(path.name != f"{i:08d}.png" for i, path in enumerate(files, 1)):
            raise ExportError("STUDIO_EXPORT_MISSING_FRAMES", "分镜增强帧序号不连续。")
        return files
