"""pi-H3's released two-evaluation DX grid and decoder-free video workflow.

Reference: Lakonik/ComfyUI-piFlow 4355cc4, workflows/pi-H3-DWD.json and
piflow_scheduler.py. Both output projections have a single velocity head.
The released workflow therefore uses deterministic Euler, with separate
video/audio shifts and H3's data-ward velocity convention.
"""
from time import perf_counter

import torch
from diffusers import MiniMaxH3Scheduler
from diffusers.modular_pipelines.minimax_h3.decoders import MiniMaxH3VideoDecodeStep
from diffusers.modular_pipelines.minimax_h3.modular_blocks_minimax_h3 import MiniMaxH3Blocks
from diffusers.modular_pipelines.modular_pipeline import SequentialPipelineBlocks

from huiyu_worker_lifecycle import load_sibling


class PiH3Scheduler(MiniMaxH3Scheduler):
    def set_timesteps(self, num_inference_steps, device=None):
        if num_inference_steps != 2:
            raise ValueError("pi-H3 DWD requires two evaluations")
        # min_raw_t=0, max_raw_t=0.93, final_step_size_scale=0.6.
        raw = torch.tensor([0.93, 0.93 * 0.6 / (1 + 0.6), 0], dtype=torch.float32)
        sigma = self.shift * raw / (1 + (self.shift - 1) * raw)
        # The inherited Euler update adds (sigma_i - sigma_next) * v_data.
        # The modular denoiser consumes t = 1 - sigma, including for anchors.
        super().set_timesteps(device=device, sigmas=sigma)


def pipeline(pipeline_class, conditioned):
    workflow = MiniMaxH3Blocks().get_workflow("fl2va" if conditioned else "t2va")
    blocks = {key: block for key, block in workflow.sub_blocks.items()
              if not isinstance(block, MiniMaxH3VideoDecodeStep)}
    if len(blocks) != len(workflow.sub_blocks) - 1:
        raise RuntimeError("The pinned H3 workflow must have one video VAE decode block")
    return pipeline_class(blocks=SequentialPipelineBlocks.from_blocks_dict(blocks))


def generate(pipe, args, data, control, device, observe_scheduler):
    dwd = load_sibling("h3_dwd")
    args.pop("output_type")  # Consumed only by the removed video VAE block.
    pipe.update_components(scheduler=PiH3Scheduler(shift=12), audio_scheduler=PiH3Scheduler(shift=3))
    with dwd.capture(pipe.transformer, data["frames"], data["height"], data["width"]) as features:
        with observe_scheduler(pipe.audio_scheduler, control):
            result = pipe(**args, output=["audio", "sampling_rate"])
        if pipe.scheduler.step_index != 2 or pipe.audio_scheduler.step_index != 2:
            raise RuntimeError("pi-H3 did not complete both audio/video updates")
        control.stage("decoding", component="dwd")
        if pipe._huiyu_memory.policy == "offload":
            pipe._huiyu_memory.offload_all()
        start = perf_counter()
        frames = dwd.decode(features, control, device)
        pipe._huiyu_dwd_observation = dict(h3Sampler="pi-flow-v2", h3Steps=pipe.scheduler.step_index,
            h3Decoder="dwd", h3DwdDecodeMs=round((perf_counter() - start) * 1000))
    return frames, result["audio"][0], result["sampling_rate"]
