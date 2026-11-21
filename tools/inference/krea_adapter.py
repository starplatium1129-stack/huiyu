"""Image-only Krea 2 execution on the pinned RAW/Turbo Diffusers pipelines."""
from contextlib import ExitStack

from huiyu_worker_lifecycle import load_sibling

GIB = 1024**3


class Residency(load_sibling("mapped_residency").Residency):
    """Respect both CUDA free memory and WDDM's system-wide allocation limit."""
    def __init__(self, components, pixels, *, root, identity, protection):
        self.pixels = pixels
        self.changing_stage = False
        self.bounded_upload = False
        self.transport = None
        self.available_commit = load_sibling("video_memory").available_commit
        if protection is not None and (root / ".huiyu-krea-transport/receipt").is_file():
            self.transport = load_sibling("krea_transport").open_transport(
                root, components["transformer"], identity=identity, protection=protection)
        try:
            super().__init__(components, "offload", pixels, image_conditioned=False, decode_pixels=pixels,
                             retain_components=True, stream_text=True)
        except BaseException:
            if self.transport is not None:
                self.transport.close()
            raise

    def _headroom(self):
        commit = self.available_commit()
        if commit is None:
            return None
        # Leave room for the desktop, the launcher and concurrent application
        # allocations. CUDA's free-byte counter alone misses Windows commit.
        self.report["availableCommitBytes"] = commit
        self.report["minimumAvailableCommitBytes"] = min(self.report.get("minimumAvailableCommitBytes", commit), commit)
        return max(0, commit - 2 * GIB)

    def bind(self, pipeline):
        if self.transport is not None:
            self.transport.report.update(uploads=0, packedBytes=0)
        self.report.pop("minimumAvailableCommitBytes", None)
        self.report["reclaimedWeightBytes"] = 0
        self.report["lowCommitStreamGroups"] = 0
        super().bind(pipeline)

    def add(self, name, module):
        start = len(self.records)
        super().add(name, module)
        for record in self.records[start:]:
            # A group can surround a whole module and still need its weights
            # after a nested layer returns. Evict only groups outside forward.
            group = record["group"]
            def onload(record=record, original=group.onload_):
                record["executing"] = True
                original()

            def offload(record=record, original=group.offload_):
                try:
                    original()
                finally:
                    record["executing"] = False

            group.onload_, group.offload_ = onload, offload

    def refresh_budget(self):
        budget = super().refresh_budget()
        available = self._headroom()
        if available is not None:
            budget = min(budget, max(0, available - self.activation_reserve))
            self.report["weightBudgetBytes"] = budget
        return budget

    def plan(self, pixels, *, image_conditioned=False, control=None, decode_pixels):
        import torch
        self.pixels = pixels
        torch.cuda.empty_cache()
        super().plan(pixels, image_conditioned=image_conditioned, control=control,
                     decode_pixels=decode_pixels, available_bytes=self._headroom())
        # The plan may just have restored warm weights to their file views.
        # WDDM can reuse that commit once CUDA relinquishes the cached slabs.
        torch.cuda.empty_cache()

    def reclaim(self, required, current):
        import torch
        torch.cuda.empty_cache()
        available = self._headroom()
        if available is None or available >= required:
            return available
        protected = set(current["sources"])
        for record in self.records:
            if record.get("executing"):
                protected.update(record["sources"])
        for record in reversed(self.records):
            if not record["keep"] or not protected.isdisjoint(record["sources"]):
                continue
            released = sum(t.numel() * t.element_size() for t in record["sources"] if t.device.type == "cuda")
            if released:
                record["keep"] = False
                self.restore(record)
                self.report["reclaimedWeightBytes"] += released
                torch.cuda.empty_cache()
                available = self._headroom()
                if available is None or available >= required:
                    break
        return available

    def make_room(self, required):
        import torch
        available = self._headroom()
        if available is not None:
            free, _ = torch.cuda.mem_get_info()
            required += max(0, free - available)
        super().make_room(required)

    def enter(self, name):
        if self.active == name:
            return
        if self.control is not None:
            self.plan(self.pixels, control=self.control, decode_pixels=self.pixels)
        if name == "vae":
            # Release DiT weights before VAE.decode's component hook uploads
            # the decoder. Its full-frame working set scales with output area.
            self.make_room(max(GIB, self.pixels * 4400) + self.modules["vae"].num_parameters() * 2)
        self.changing_stage = True
        try:
            super().enter(name)
        finally:
            self.changing_stage = False

    def load_record(self, record):
        missing = sum(source.numel() * source.element_size() for t, source in record["sources"].items()
                      if t.device.type != "cuda")
        if missing:
            available = self._headroom()
            if available is not None:
                if self.changing_stage and record["keep"] and available < missing + self.report["activationReserveBytes"]:
                    # A later streamed group and its activations have priority
                    # over preloading weights that have not started computing.
                    record["keep"] = False
                    return
                if available < missing:
                    available = self.reclaim(missing, record)
                if available is not None and available < missing:
                    # After all reclaimable groups and CUDA slabs have retired,
                    # a single, immediately consumed group may use up to half
                    # the reserve. Its hook drops the weights on return.
                    commit = self.report["availableCommitBytes"]
                    if self.changing_stage or commit < missing + GIB:
                        raise load_sibling("adapter_contract").AdapterError("NATIVE_OUT_OF_MEMORY",
                            f"Windows 可提交内存不足以加载 Krea {record['name']} 层。"
                            f"系统余量 {commit // 2**20} MiB，该层需要 {missing // 2**20} MiB。")
                    record["keep"] = False
                    self.report["lowCommitStreamGroups"] += 1
                # Stage hot mmap pages in bounded pinned buffers under pressure.
                # Large pageable uploads can themselves consume host memory.
                self.bounded_upload = available is not None and available < missing + self.report["activationReserveBytes"] + GIB
        super().load_record(record)

    def to_cuda(self, source, retain):
        if self.transport is not None:
            restored = self.transport.upload(source, self.upload_packed)
            if restored is not None:
                return restored
        return super().to_cuda(source, retain, mapped_pages=self.bounded_upload and not retain)

    def upload_packed(self, packed):
        return super().to_cuda(packed, False, mapped_pages=True)

    def close(self):
        try:
            super().close()
        finally:
            if self.transport is not None:
                self.transport.close()
                self.transport = None

    def finish(self):
        super().finish()
        for hook in self.manager.model_hooks or ():
            if hook.model is self.modules["vae"]:
                hook.offload()
        self.active = None
        self.plan(self.pixels, decode_pixels=self.pixels)

    def decode_tile(self, latents):
        import torch
        height, width = latents.shape[-2:]
        free, _ = torch.cuda.mem_get_info()
        available = self._headroom()
        if available is not None:
            free = min(free, available)
        per_pixel = 2200 * 64 * latents.element_size()
        if height * width * per_pixel <= free:
            return None
        tile = 32
        while tile * 2 <= max(height, width) and min(height, tile * 2) * min(width, tile * 2) * per_pixel <= free:
            tile *= 2
        return tile


def configure(pipeline):
    # The Krea text encoder reads twelve language-layer taps. It never uses
    # Qwen's vision tower or autoregressively extends a KV cache.
    encoder = pipeline.text_encoder
    encoder.visual = None
    encoder.language_model.config.use_cache = False


def _replace(stack, owner, name, value):
    if name in vars(owner):
        stack.callback(setattr, owner, name, getattr(owner, name))
    else:
        stack.callback(delattr, owner, name)
    setattr(owner, name, value)


def _reuse_forward(stack, module, report, counter):
    original = module.forward
    values = {}

    def forward(source, **kwargs):
        # A nonempty padding mask can vary independently of the source tensor.
        # Keep the ordinary implementation for that case.
        if kwargs.get("attention_mask") is not None:
            return original(source, **kwargs)
        key = id(source)
        if key in values:
            report[counter] += 1
            return values[key][1]
        output = original(source, **kwargs)
        # The worker renders a single image. RAW can have one extra CFG branch.
        if len(values) < 2:
            values[key] = (source, output)
        return output

    _replace(stack, module, "forward", forward)
    stack.callback(values.clear)


def generate(pipeline, args, control, observation):
    import torch
    report = dict(textTokens=[], conditioningHits=0, conditioningMisses=0,
                  fusionHits=0, projectionHits=0, rotaryHits=0)
    original_encode = pipeline.encode_prompt
    transformer = pipeline.transformer
    sampling = False
    positions = {}

    def encode(*, prompt, max_sequence_length, **kwargs):
        # Upstream pads between the user prompt and assistant suffix. Its
        # mRoPE positions count only valid tokens, and masked keys contribute
        # nothing. Preserve the same tokens/truncation and omit those PAD lanes.
        text = prompt if isinstance(prompt, str) else prompt[0]
        prefix = pipeline.prompt_template_encode_start_idx
        suffix = pipeline.prompt_template_encode_num_suffix_tokens
        ids = pipeline.tokenizer(pipeline.prompt_template_encode_prefix + text, truncation=True,
                                 max_length=max_sequence_length + prefix - suffix).input_ids
        length = max(1, len(ids) - prefix + suffix)
        features, mask = original_encode(prompt=text, max_sequence_length=length, **kwargs)
        report["textTokens"].append(features.shape[1])
        return features, None if bool(mask.all()) else mask

    def before_transformer(_module, inputs, kwargs):
        nonlocal sampling
        control.check()
        if not sampling:
            sampling = True
            control.stage("sampling")
        # RAW invokes the unconditional branch with the positive branch's
        # position grid. Each compacted branch needs its own zero text rows
        # followed by exactly the same image coordinates.
        text_len = kwargs["encoder_hidden_states"].shape[1]
        image_len = kwargs["hidden_states"].shape[1]
        grid = kwargs["position_ids"]
        if grid.shape[0] != text_len + image_len:
            if text_len not in positions:
                positions[text_len] = torch.cat((grid.new_zeros((text_len, 3)), grid[-image_len:]))
            kwargs["position_ids"] = positions[text_len]
        return inputs, kwargs

    vae_events = []
    with ExitStack() as stack:
        _replace(stack, pipeline, "encode_prompt", encode)
        handle = transformer.register_forward_pre_hook(before_transformer, with_kwargs=True, prepend=True)
        stack.callback(handle.remove)
        for module, counter in ((transformer.text_fusion, "fusionHits"), (transformer.txt_in, "projectionHits"),
                                (transformer.rotary_emb, "rotaryHits")):
            _reuse_forward(stack, module, report, counter)
        for block in transformer.transformer_blocks:
            handle = block.register_forward_pre_hook(lambda *_: control.check())
            stack.callback(handle.remove)
        # Krea and Anima use the same Qwen single-frame VAE. The public
        # decode method retains its placement hooks; tiled decode is retried
        # only on accelerator OOM and each tile remains cancellable.
        _replace(stack, pipeline.vae, "_huiyu_vae_events", vae_events)
        stack.enter_context(load_sibling("anima_vae")._single_frame(
            pipeline.vae, "decode", load_sibling("anima_tiling"), check=control.check,
            decode_tile=getattr(pipeline._huiyu_memory, "decode_tile", None)))
        output = pipeline(**args)
    report.update(pipeline._huiyu_krea_conditioning)
    memory = pipeline._huiyu_memory.report
    transport = getattr(pipeline._huiyu_memory, "transport", None)
    if transport is not None and transport.report["uploads"]:
        report.update(weightTransport="fp8-to-bf16", transferredMatrices=transport.report["uploads"],
                      packedTransferBytes=transport.report["packedBytes"])
    for field in ("minimumAvailableCommitBytes", "reclaimedWeightBytes", "lowCommitStreamGroups"):
        if field in memory:
            observation["memoryScheduling"][field] = memory[field]
    if vae_events:
        report.update(vaeDecode=vae_events[-1]["mode"], vaeTiles=vae_events[-1]["tileCount"])
    observation["kreaExecution"] = report
    return output
