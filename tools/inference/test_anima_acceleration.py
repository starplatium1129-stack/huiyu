"""CPU equality of the changed attention math; GPU/compile quality is separate."""
import unittest
from unittest.mock import patch

import anima_acceleration as acceleration


class AccelerationTests(unittest.TestCase):
    def test_rejects_unknown_mode_and_external_backend(self):
        with patch.object(acceleration, "MODE", "unknown"), self.assertRaisesRegex(ValueError, "must be"):
            acceleration.validate()
        with patch.dict(acceleration.os.environ, {"DIFFUSERS_ATTN_BACKEND": "sage"}), self.assertRaisesRegex(ValueError, "instead of"):
            acceleration.validate()

    def test_sage_candidate_checks_exact_dependency_versions_before_cuda(self):
        with patch.object(acceleration, "MODE", "sage"), \
                patch.object(acceleration.importlib.metadata, "version", return_value="0.0"):
            with self.assertRaises(ValueError):
                acceleration.validate()

    def test_repeatless_processor_preserves_self_and_cross_attention(self):
        import torch
        from diffusers.models.attention_dispatch import attention_backend
        from diffusers.models.attention_processor import Attention
        from diffusers.models.transformers.transformer_cosmos import CosmosAttnProcessor2_0
        torch.manual_seed(123)
        attn = Attention(query_dim=32, heads=4, dim_head=8, qk_norm="rms_norm", out_bias=False).eval()
        hidden, encoder = torch.randn(1, 8, 32), torch.randn(1, 5, 32)
        original, accelerated = CosmosAttnProcessor2_0(), acceleration._CosmosProcessor()
        with torch.no_grad(), attention_backend("native"):
            for context in (None, encoder):
                torch.testing.assert_close(accelerated(attn, hidden, context), original(attn, hidden, context), rtol=0, atol=0)


if __name__ == "__main__":
    unittest.main()
