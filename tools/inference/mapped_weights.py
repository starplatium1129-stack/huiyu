"""Read-only safetensors views for local inference, without Windows copy-on-write commit.

The native asset lease keeps checkpoint files stable. Validate the safetensors
layout before mapping; views retain their buffer until the resident model retires.
This reader is scoped to immutable Qwen/MOSS inference, never LoRA mutation.
"""
import json
import math
import mmap
import os
import struct
import warnings

TYPES = {"F64": ("float64", 8), "F32": ("float32", 4), "F16": ("float16", 2),
         "BF16": ("bfloat16", 2), "I64": ("int64", 8), "I32": ("int32", 4),
         "I16": ("int16", 2), "I8": ("int8", 1), "U8": ("uint8", 1),
         "U16": ("uint16", 2), "U32": ("uint32", 4), "U64": ("uint64", 8),
         "BOOL": ("bool", 1), "F8_E4M3": ("float8_e4m3fn", 1), "F8_E5M2": ("float8_e5m2", 1)}


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"Duplicate safetensors key: {key}")
        value[key] = item
    return value


class TensorSlice:
    def __init__(self, reader, name):
        self.reader, self.name = reader, name

    def get_shape(self):
        return list(self.reader.header[self.name]["shape"])

    def get_dtype(self):
        return self.reader.header[self.name]["dtype"]

    def __getitem__(self, index):
        return self.reader.get_tensor(self.name)[index]


class ReadOnlyWeights:
    def __init__(self, filename, framework="pt", device="cpu", *, backend=None):
        import torch
        if framework not in ("pt", "pytorch"):
            raise ValueError("Read-only weights support PyTorch only")
        self.device = torch.device(f"cuda:{device}" if isinstance(device, int) else device)
        self.file = open(filename, "rb", buffering=0)
        try:
            file_size = os.fstat(self.file.fileno()).st_size
            size = struct.unpack("<Q", self.file.read(8))[0]
            if not 0 < size <= min(100_000_000, file_size - 8):
                raise ValueError("Invalid safetensors header length")
            self.header = json.loads(self.file.read(size), object_pairs_hook=unique_object)
            if not isinstance(self.header, dict):
                raise ValueError("Expected safetensors metadata object")
            self.offset = 8 + size
            self.meta = self.header.get("__metadata__")
            if self.meta is not None and (not isinstance(self.meta, dict)
                    or any(not isinstance(value, str) for value in self.meta.values())):
                raise ValueError("Invalid safetensors string metadata")
            self.names = [name for name in self.header if name != "__metadata__"]
            ranges = []
            for name in self.names:
                entry = self.header[name]
                if not isinstance(entry, dict) or entry.get("dtype") not in TYPES:
                    raise ValueError(f"Unsupported safetensors tensor: {name}")
                shape, offsets = entry.get("shape"), entry.get("data_offsets")
                if (not isinstance(shape, list) or len(shape) > 64
                        or any(type(dim) is not int or dim < 0 for dim in shape)
                        or not isinstance(offsets, list) or len(offsets) != 2
                        or any(type(offset) is not int or offset < 0 for offset in offsets)):
                    raise ValueError(f"Invalid safetensors shape/offsets: {name}")
                start, end = offsets
                if end > file_size - self.offset or end - start != math.prod(shape) * TYPES[entry["dtype"]][1]:
                    raise ValueError(f"Safetensors shape does not match payload: {name}")
                ranges.append((start, end))
            cursor = 0
            for start, end in sorted(ranges):
                if start != cursor:
                    raise ValueError("Overlapping or incomplete safetensors payload")
                cursor = end
            if cursor != file_size - self.offset:
                raise ValueError("Trailing or missing safetensors payload")
            self.mapping = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
        except BaseException:
            self.file.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *args):
        # torch.frombuffer owns each memoryview; do not close a mapping while
        # loaded tensors still refer to it. Metadata-only readers release here.
        self.mapping = None
        self.file = None

    def keys(self):
        return list(self.names)

    def offset_keys(self):
        return sorted(self.names, key=lambda name: self.header[name]["data_offsets"][0])

    def metadata(self):
        return self.meta

    def get_slice(self, name):
        return TensorSlice(self, name)

    def get_tensor(self, name):
        import torch
        entry = self.header[name]
        start, end = entry["data_offsets"]
        dtype = getattr(torch, TYPES[entry["dtype"]][0])
        if start == end:
            return torch.empty(entry["shape"], dtype=dtype, device=self.device)
        buffer = memoryview(self.mapping)[self.offset + start:self.offset + end]
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="The given buffer is not writable")
            tensor = torch.frombuffer(buffer, dtype=dtype).reshape(entry["shape"])
        tensor.untyped_storage()._huiyu_file_slice = (self.file, self.offset + start)
        return tensor.to(self.device)

    def get_tensors(self):
        return {name: self.get_tensor(name) for name in self.names}
