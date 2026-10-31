"""Budgeted component/block placement through pinned Diffusers offload APIs.

No prefetch streams: conditional Anima/TeaCache and dual video denoisers must
not leave an unvisited prefetched group on CUDA. Placement never changes dtype.
"""
import copy


def tensor_bytes(module):
    tensors = {id(tensor): tensor for tensor in (*module.parameters(), *module.buffers())}
    return sum(tensor.numel() * tensor.element_size() for tensor in tensors.values())


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


class Residency:
    """One existing worker owns placement; ComponentsManager owns stage handoff."""
    def __init__(self, components, policy, *, activation_reserve=None):
        import torch
        self.policy, self.manager, self.grouped = policy, None, []
        self.bound = False
        self.modules = {}
        self.report = dict(strategy="budgeted-offload-v1", components=[])
        if policy not in ("resident", "offload"):
            raise ValueError("Use resident or offload")
        try:
            if policy == "resident":
                for name, module in components.items():
                    self.add(name, module)
                return
            from diffusers import ComponentsManager
            torch.cuda.empty_cache()  # Reclaim inactive reserves before measuring the weights budget.
            free, total = torch.cuda.mem_get_info(0)
            # A conservative weights budget, not an activation/OOM guarantee.
            # External users of the device and requested image/video shapes still matter.
            reserve = activation_reserve if activation_reserve is not None else max(1024 ** 3, total // 4)
            budget = max(0, free - reserve)
            self.report.update(freeBytes=free, activationReserveBytes=reserve, weightBudgetBytes=budget)
            self.manager = ComponentsManager()
            for name, module in components.items():
                self.add(name, module)
            if self.modules:
                self._activate()
        except BaseException:
            self.close()
            raise

    def add(self, name, module):
        import torch
        if not isinstance(module, torch.nn.Module):
            return
        self.modules[name] = module
        size = tensor_bytes(module)
        row = dict(name=name, mode="resident" if self.policy == "resident" else "component", weightBytes=size)
        self.report["components"].append(row)
        if self.policy == "resident":
            module.to("cuda:0")
            return
        from diffusers.hooks.group_offloading import apply_group_offloading
        budget = self.report["weightBudgetBytes"]
        layered = name in ("text_encoder", "text_encoder_2", "text_conditioner", "transformer", "transformer_2")
        # VAE encode/decode can bypass forward; preserve its component placement.
        if layered and size > budget:
            ancestors, blocks, remainder = block_layout(module)
            if name == "text_encoder":
                # Qwen VLM calls embed_tokens before language_model.forward.
                # Give that child its own group instead of waiting for the parent.
                ancestors.add("embed_tokens")
            largest = max((tensor_bytes(block) for block in blocks), default=0)
            mode = "block_level" if blocks and largest + remainder <= budget else "leaf_level"
            count = max(1, min(8, (budget - remainder) // max(1, largest))) if mode == "block_level" else None
            self.grouped.append(module)
            apply_group_offloading(module, onload_device=torch.device("cuda:0"),
                offload_device=torch.device("cpu"), offload_type=mode,
                num_blocks_per_group=count, block_modules=sorted(ancestors),
                use_stream=False, non_blocking=False)
            row.update(mode=mode, blocksPerGroup=count)
        self.manager.add(name, module)

    def _activate(self):
        import torch
        self.manager.enable_auto_cpu_offload(device=torch.device("cuda:0"),
            offload_strategy=lambda hooks, model_id, model, execution_device: hooks)
        self._invalidate_registries()

    def bind(self, pipeline):
        if self.bound and self.policy == "offload":
            # Re-evaluate real free memory at each task, after the previous
            # task's scheduler/wrappers and activations have been retired.
            modules = dict(self.modules)
            self.close()
            self.__init__(modules, self.policy)
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
