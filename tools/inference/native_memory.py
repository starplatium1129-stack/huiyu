"""Budgeted component/block placement through pinned Diffusers offload APIs.

No prefetch streams: conditional Anima/TeaCache and dual video denoisers must
not leave an unvisited prefetched group on CUDA. Placement never changes dtype.
"""
import copy


def memory_info(device):
    import torch
    return getattr(torch, device.type).mem_get_info(device)


def tensor_bytes(module):
    tensors = {id(tensor): tensor for tensor in (*module.parameters(), *module.buffers())}
    return sum(tensor.numel() * tensor.element_size() for tensor in tensors.values())


def keep_token_table_on_cpu(language, *, copy_weight=False):
    """Read only the rows needed for inference from an immutable BF16 vocabulary."""
    import torch

    table = language.embed_tokens
    if (type(table) is not torch.nn.Embedding or table.weight.device.type != "cpu"
            or table.max_norm is not None or table.weight.dtype != torch.bfloat16):
        return

    class HostLookup(torch.nn.Module):
        def __init__(self, embedding):
            super().__init__()
            # A plain tensor stays outside placement hooks. Resident Anima can
            # outlive the source-file lease and needs an independent snapshot.
            self.weight = embedding.weight.detach()
            if copy_weight:
                self.weight = self.weight.clone()
            self.padding_idx = embedding.padding_idx

        def forward(self, ids):
            rows = torch.nn.functional.embedding(ids.cpu(), self.weight, self.padding_idx)
            return rows.to(device=ids.device)

    language.embed_tokens = HostLookup(table)


def block_layout(module):
    """Find block lists and the ancestor names accepted by apply_group_offloading."""
    import torch
    ancestors, blocks, grouped = set(), [], set()
    for path, child in module.named_modules():
        if isinstance(child, (torch.nn.ModuleList, torch.nn.Sequential)):
            if any(path.startswith(parent + ".") for parent in grouped):
                continue
            grouped.add(path)
            blocks.extend(list(child.children()))
            ancestors.update(path.split(".")[:-1])
    block_parameters = {id(tensor) for block in blocks for tensor in (*block.parameters(), *block.buffers())}
    remainder = sum(tensor.numel() * tensor.element_size()
                    for tensor in {id(t): t for t in (*module.parameters(), *module.buffers())}.values()
                    if id(tensor) not in block_parameters)
    return ancestors, blocks, remainder


def placement(size, budget, largest, remainder):
    if size <= budget:
        return "component", None
    if largest is None or largest + remainder > budget:
        return "leaf_level", None
    return "block_level", max(1, min(8, (budget - remainder) // max(1, largest)))


class Residency:
    """One existing worker owns placement; ComponentsManager owns stage handoff."""
    def __init__(self, components, policy, *, activation_reserve=None, device="cuda:0"):
        import torch
        self.device = torch.device(device)
        self.activation_reserve = activation_reserve
        self.policy, self.manager, self.grouped = policy, None, []
        self.bound = False
        self.modules = {}
        self.layer_plans = []
        self.report = dict(strategy="budgeted-offload-v1", components=[])
        if policy not in ("resident", "offload"):
            raise ValueError("Use resident or offload")
        try:
            if policy == "resident":
                for name, module in components.items():
                    self.add(name, module)
                return
            from diffusers import ComponentsManager
            self.refresh_budget()
            self.manager = ComponentsManager()
            for name, module in components.items():
                self.add(name, module)
            if self.modules:
                self._activate()
        except BaseException:
            self.close()
            raise

    def refresh_budget(self):
        import torch
        api = getattr(torch, self.device.type)
        with api.device(self.device):
            api.empty_cache()
        free, total = memory_info(self.device)
        reserve = self.activation_reserve if self.activation_reserve is not None else max(1024 ** 3, total // 4)
        budget = max(0, free - reserve)
        self.report.update(freeBytes=free, activationReserveBytes=reserve, weightBudgetBytes=budget)
        return budget

    def add(self, name, module):
        import torch
        if not isinstance(module, torch.nn.Module):
            return
        self.modules[name] = module
        size = tensor_bytes(module)
        row = dict(name=name, mode="resident" if self.policy == "resident" else "component", weightBytes=size)
        self.report["components"].append(row)
        if self.policy == "resident":
            module.to(self.device)
            return
        from diffusers.hooks.group_offloading import apply_group_offloading
        budget = self.report["weightBudgetBytes"]
        layered = name in ("text_encoder", "text_encoder_2", "text_conditioner", "transformer", "transformer_2")
        # VAE encode/decode can bypass forward; preserve its component placement.
        if layered:
            largest, remainder = None, 0
            if size > budget:
                ancestors, blocks, remainder = block_layout(module)
                if name == "text_encoder":
                    # Qwen VLM calls embed_tokens before language_model.forward.
                    ancestors.add("embed_tokens")
                largest = max((tensor_bytes(block) for block in blocks), default=None)
                mode, count = placement(size, budget, largest, remainder)
                self.grouped.append(module)
                apply_group_offloading(module, onload_device=self.device,
                    offload_device=torch.device("cpu"), offload_type=mode,
                    num_blocks_per_group=count, block_modules=sorted(ancestors),
                    use_stream=False, non_blocking=False)
                row.update(mode=mode, blocksPerGroup=count)
            self.layer_plans.append((size, largest, remainder, (row["mode"], row.get("blocksPerGroup"))))
        self.manager.add(name, module)

    def _activate(self):
        self.manager.enable_auto_cpu_offload(device=self.device,
            offload_strategy=lambda hooks, model_id, model, execution_device: hooks)
        self._invalidate_registries()

    def bind(self, pipeline):
        if self.bound and self.policy == "offload":
            # Re-evaluate real free memory at each task, after the previous
            # task's scheduler/wrappers and activations have been retired.
            self.offload_all()
            budget = self.refresh_budget()
            if any(placement(size, budget, largest, remainder) != previous
                   for size, largest, remainder, previous in self.layer_plans):
                modules = dict(self.modules)
                self.close()
                self.__init__(modules, self.policy, activation_reserve=self.activation_reserve, device=self.device)
        if self.manager is not None and not self.manager.model_hooks:
            self._activate()
        self.bound = True
        pipeline._huiyu_memory = self

    def observation(self):
        return copy.deepcopy(self.report)

    def finish(self):
        self.offload_all()

    def _invalidate_registries(self):
        # CacheMixin keeps descendant registries by reference. A placement
        # replan changes that set; later LoRA unload can remove its modules.
        # Do not keep stale registry/model references or miss newly added hooks.
        for module in self.modules.values():
            registry = getattr(module, "_diffusers_hook", None)
            if registry is not None:
                registry.invalidate_child_registries_cache()

    def offload_all(self):
        if self.manager is not None:
            for hook in self.manager.model_hooks or ():
                hook.offload()
        # Upstream post_forward does not run when inference raises/cancels.
        # Synchronous group transfers leave no pending prefetch to drain.
        seen = set()
        for module in self.grouped:
            for child in module.modules():
                registry = getattr(child, "_diffusers_hook", None)
                hook = registry.get_hook("group_offloading") if registry is not None else None
                if hook is not None and id(hook.group) not in seen:
                    seen.add(id(hook.group))
                    hook.group.offload_()

    def close(self):
        # Keep ownership until all transfers/hooks have actually retired.
        self._invalidate_registries()
        self.offload_all()
        if self.manager is not None:
            self.manager.disable_auto_cpu_offload()
            self.manager.components.clear()
            self.manager = None
        for module in self.grouped:
            for child in module.modules():
                registry = getattr(child, "_diffusers_hook", None)
                if registry is not None:
                    registry.remove_hook("group_offloading", recurse=False)
        self.grouped.clear()
        self.modules.clear()
