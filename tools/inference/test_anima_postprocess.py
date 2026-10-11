"""CPU RCAS reference points and image boundary contracts; no GPU/model calls."""
import unittest

import torch

from anima_postprocess import rcas


class RcasTests(unittest.TestCase):
    def test_zero_is_exact_identity_and_positive_preserves_tensor_contract(self):
        for dtype in (torch.float32, torch.float16, torch.bfloat16):
            image = torch.linspace(0, 1, 2 * 3 * 4 * 5).reshape(2, 3, 4, 5).to(dtype).transpose(2, 3)
            original = image.clone()
            self.assertIs(rcas(image, 0), image)
            result = rcas(image, .75)
            self.assertEqual((result.shape, result.dtype, result.device), (image.shape, dtype, image.device))
            self.assertTrue(torch.equal(image, original))
            self.assertTrue(torch.isfinite(result).all())
            self.assertTrue(((result >= 0) & (result <= 1)).all())

    def test_amd_cross_filter_reference_points_and_replicated_corner(self):
        # Analytic RCAS examples, not a second implementation of the tensor
        # kernel: ring=.4, center=.5 gives limited w=-3/16 * 3/4 = -9/64.
        # Interior: (.5+w*1.6)/(1+4w)=22/35. At the replicated corner two
        # ring samples are .5, so (.5+w*1.8)/(1+4w)=79/140.
        image = torch.full((2, 3, 3, 3), .4)
        image[0, :, 1, 1] = .5
        image[1, :, 0, 0] = .5
        result = rcas(image, .75)
        torch.testing.assert_close(result[0, :, 1, 1], torch.full((3,), 22 / 35), atol=1e-6, rtol=0)
        torch.testing.assert_close(result[1, :, 0, 0], torch.full((3,), 79 / 140), atol=1e-6, rtol=0)
        self.assertGreater(result[0, 0, 1, 1].item(), image[0, 0, 1, 1].item())
        # A zero green channel constrains the shared RGB lobe to zero.
        image[:, 1] = 0
        torch.testing.assert_close(rcas(image, .75), image, atol=0, rtol=0)

    def test_black_white_flat_fields_and_single_pixel_edges_stay_finite(self):
        for height, width in ((1, 1), (1, 4), (4, 1), (4, 4)):
            image = torch.tensor([0, .5, 1], dtype=torch.float32).view(3, 1, 1, 1).expand(3, 3, height, width)
            torch.testing.assert_close(rcas(image, 1), image, atol=0, rtol=0)
        self.assertFalse(torch.cuda.is_initialized())

    def test_invalid_strength_and_non_rgb_contract_are_rejected(self):
        image = torch.zeros(1, 3, 2, 2)
        for strength in (True, -.1, 1.1, float("nan"), float("inf")):
            with self.subTest(strength=strength), self.assertRaises(ValueError):
                rcas(image, strength)
        for invalid in (torch.zeros(3, 2, 2), torch.zeros(1, 4, 2, 2),
                        torch.zeros(1, 3, 0, 2), image.to(torch.uint8)):
            with self.assertRaises(ValueError):
                rcas(invalid)


if __name__ == "__main__":
    unittest.main()
