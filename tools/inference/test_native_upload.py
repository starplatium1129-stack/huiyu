"""Packed-upload CPU semantics only; CUDA transfers/performance are not executed."""
import unittest
from unittest.mock import patch

import torch
from torch import nn

from native_upload import try_packed_upload


class SmallModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.weight = nn.Parameter(torch.arange(6, dtype=torch.float32).reshape(2, 3))
        self.weight_alias = self.weight
        self.bias = nn.Parameter(torch.tensor([.25, -.5]))
        self.bfloat = nn.Parameter(torch.full((2, 3), .5, dtype=torch.bfloat16))
        self.register_buffer("scale", torch.tensor(2., dtype=torch.float32))
        self.register_buffer("scale_alias", self.scale, persistent=False)
        self.register_buffer("indices", torch.tensor([1, 0], dtype=torch.int64))
        self.register_buffer("enabled", torch.tensor(True))

    def forward(self, value):
        result = torch.nn.functional.linear(value, self.weight, self.bias)
        result = result + torch.nn.functional.linear(value, self.bfloat.float())
        return (result * self.scale)[:, self.indices] if self.enabled else result


def snapshot(model):
    return [(name, tensor, tensor.detach().clone(), tensor.data_ptr(), hasattr(tensor, "_huiyu_packed_storage"))
            for name, tensor in list(model.named_parameters()) + list(model.named_buffers())]


class PackedUploadTests(unittest.TestCase):
    def test_components_have_independent_storage_with_unchanged_outputs(self):
        encoder, transformer = SmallModel(), SmallModel()
        value = torch.tensor([[1., 2., 3.]])
        expected = [module(value).detach() for module in (encoder, transformer)]
        self.assertTrue(try_packed_upload([encoder, transformer], target_device="cpu"))
        encoder_storage = {tensor.untyped_storage()._cdata for tensor in encoder.parameters()}
        transformer_storage = {tensor.untyped_storage()._cdata for tensor in transformer.parameters()}
        self.assertTrue(encoder_storage.isdisjoint(transformer_storage))
        for module, output in zip((encoder, transformer), expected):
            self.assertTrue(torch.equal(module(value), output))
        self.assertFalse(torch.cuda.is_initialized())

    def test_output_values_dtypes_parameter_identity_and_shared_objects_are_preserved(self):
        model = SmallModel()
        other = nn.Module()
        other.weight = model.weight
        other.register_buffer("shared_scale", model.scale)
        original = snapshot(model)
        value = torch.tensor([[1., 2., 3.]])
        expected = model(value).detach()
        with patch("torch.cuda.synchronize", side_effect=AssertionError("CPU test must not synchronize CUDA")), \
                patch("torch.cat", side_effect=AssertionError("must not concatenate CPU weight copies")), \
                patch("torch.Tensor.pin_memory", side_effect=AssertionError("must not pin a CPU weight copy")):
            self.assertTrue(try_packed_upload([model, other], target_device="cpu"))
        self.assertTrue(torch.equal(model(value), expected))
        self.assertIs(model.weight, model.weight_alias)
        self.assertIs(model.weight, other.weight)
        self.assertIs(model.scale, model.scale_alias)
        self.assertIs(model.scale, other.shared_scale)
        current = dict(list(model.named_parameters()) + list(model.named_buffers()))
        storage_by_dtype = {}
        for name, old, values, _, _ in original:
            tensor = current[name]
            self.assertIs(tensor, old)
            self.assertEqual((tensor.dtype, tensor.shape, tensor.device), (values.dtype, values.shape, values.device))
            self.assertTrue(torch.equal(tensor, values))
            self.assertEqual(tensor.storage_offset() * tensor.element_size() % 256, 0)
            storage_by_dtype.setdefault(tensor.dtype, set()).add(tensor.untyped_storage()._cdata)
            if isinstance(tensor, nn.Parameter):
                self.assertTrue(tensor._huiyu_packed_storage)
        self.assertTrue(all(len(storages) == 1 for storages in storage_by_dtype.values()))
        self.assertFalse(torch.cuda.is_initialized())

    def test_late_unsupported_tensors_leave_every_prior_parameter_and_buffer_untouched(self):
        for bad in (nn.Parameter(torch.zeros(2, 3).t()),
                    nn.Parameter(torch.zeros(2, dtype=torch.complex64)),
                    nn.Parameter(torch.empty(2, device="meta"))):
            model, other = SmallModel(), nn.Module()
            original = snapshot(model)
            other.weight = bad
            self.assertFalse(try_packed_upload([model, other], target_device="cpu"))
            for name, tensor, values, pointer, marked in original:
                self.assertEqual(tensor.data_ptr(), pointer, name)
                self.assertTrue(torch.equal(tensor, values), name)
                self.assertEqual(hasattr(tensor, "_huiyu_packed_storage"), marked)
        model = SmallModel()
        model.bias.grad = torch.ones_like(model.bias)
        original = snapshot(model)
        self.assertFalse(try_packed_upload([model], target_device="cpu"))
        for name, tensor, values, pointer, _ in original:
            self.assertEqual(tensor.data_ptr(), pointer, name)
            self.assertTrue(torch.equal(tensor, values), name)

    def test_distinct_parameters_with_shared_storage_or_overlapping_wrapped_memory_are_rejected(self):
        common = torch.arange(8, dtype=torch.float32)
        memory = bytearray(32)
        for first, second in ((common[:4], common[2:6]), (common[:4], common[4:]),
                              (torch.frombuffer(memory, dtype=torch.float32), torch.frombuffer(memory, dtype=torch.float32))):
            model = nn.Module()
            model.first, model.second = nn.Parameter(first), nn.Parameter(second)
            original = snapshot(model)
            self.assertFalse(try_packed_upload([model], target_device="cpu"))
            for name, tensor, values, pointer, marked in original:
                self.assertEqual(tensor.data_ptr(), pointer, name)
                self.assertTrue(torch.equal(tensor, values), name)
                self.assertFalse(marked)
                self.assertFalse(hasattr(tensor, "_huiyu_packed_storage"))

    def test_copy_failure_propagates_before_publishing_any_target_views(self):
        model = SmallModel()
        original = snapshot(model)
        with patch("torch.Tensor.copy_", side_effect=RuntimeError("injected copy failure")):
            with self.assertRaisesRegex(RuntimeError, "injected copy"):
                try_packed_upload([model], target_device="cpu")
        for name, tensor, values, pointer, marked in original:
            self.assertEqual(tensor.data_ptr(), pointer, name)
            self.assertTrue(torch.equal(tensor, values), name)
            self.assertEqual(hasattr(tensor, "_huiyu_packed_storage"), marked)


if __name__ == "__main__":
    unittest.main()
