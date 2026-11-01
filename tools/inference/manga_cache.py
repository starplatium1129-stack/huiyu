"""One recent Qwen redraw and line map, protected by worker-owned file leases.

Only exact input pixels and an identical effective redraw request may reuse the
RGB result. Post-processing receives its own copy. Nothing is persisted and an
invalid/lost model lease, cancellation or worker exit discards the result.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
from huiyu_worker_lifecycle import load_sibling


class Cache:
    def __init__(self):
        self.weights = None
        self.rewritten = None
        self.line_lease = None
        self.lines = None

    def adapters(self):
        if self.weights is None:
            self.weights = load_sibling("resident_adapters").PipelineCache()
        return self.weights

    @staticmethod
    def key(root, request, rgb):
        return (str(Path(root).resolve()), os.environ.get("HUIYU_INFERENCE_MEMORY", "resident"),
                json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=False),
                rgb.shape, hashlib.sha256(memoryview(rgb)).digest())

    def protected(self):
        return (self.weights is not None and self.weights.components is not None
                and self.weights.protection is not None and self.weights.lease.valid()
                and self.weights.lease.protection_token() is self.weights.protection)

    def get(self, key):
        if not self.protected():
            self.rewritten = None
        if self.rewritten is None:
            return None
        previous, protection, rgb, observation = self.rewritten
        if protection is not self.weights.protection:
            self.rewritten = None
            return None
        if previous != key:
            return None
        observation = copy.deepcopy(observation)
        observation["resultReused"] = True
        # No prefix transfer occurred in this task; retain pixel/model
        # provenance without replaying the source task's execution counters.
        observation.pop("qwenPrefixCache", None)
        observation.pop("prefixCacheDevice", None)
        return rgb.copy(), observation

    def put(self, key, rgb, observation):
        # The current contract caps redraws at 2 megapixels (~6 MiB RGB).
        self.rewritten = None
        if self.protected() and rgb.nbytes <= 6 * 1024**2:
            self.rewritten = (key, self.weights.protection, rgb.copy(), copy.deepcopy(observation))

    def clear(self):
        self.rewritten = None
        self.lines = None
        if self.line_lease is not None:
            self.line_lease.close()
        if self.weights is not None:
            self.weights.clear()

    def line_input(self, weight, rgb):
        if self.line_lease is None:
            self.line_lease = load_sibling("locked_identity").AssetIdentityLease(tree=False)
        # Acquire protection only. The extractor still hashes and loads the same
        # open file on every miss, including unsupported/unprotected filesystems.
        self.line_lease.acquire(weight, lambda _path: None)
        token = self.line_lease.protection_token()
        key = (str(weight.resolve()), rgb.shape, str(rgb.dtype), hashlib.sha256(memoryview(rgb)).digest())
        if self.lines is not None:
            previous, protection, pen, observation = self.lines
            if token is None or token is not protection:
                self.lines = None
            elif previous == key:
                observation = copy.deepcopy(observation)
                observation["resultReused"] = True
                return key, token, (pen.copy(), observation)
        return key, token, None

    def put_line(self, key, token, pen, observation):
        self.lines = None
        if token is not None and token is self.line_lease.protection_token() and pen.nbytes <= 8 * 1024**2:
            self.lines = (key, token, pen.copy(), copy.deepcopy(observation))
