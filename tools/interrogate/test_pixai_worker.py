import hashlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import pixai_worker as worker


class WorkerContractTests(unittest.TestCase):
    def assert_error(self, code, call):
        with self.assertRaises(worker.PixaiError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)

    def test_integrity_checks_exact_bytes_and_sha_before_custom_model_import(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.bin'
            content = b'pinned model bytes'
            manifest = {'files': [{'path': path.name, 'bytes': len(content),
                                   'sha256': hashlib.sha256(content).hexdigest()}]}
            self.assert_error('PIXAI_MODEL_MISSING', lambda: worker.verify_model(directory, manifest))
            path.write_bytes(b'truncated')
            self.assert_error('PIXAI_MODEL_INTEGRITY', lambda: worker.verify_model(directory, manifest))
            path.write_bytes(b'x' * len(content))
            self.assert_error('PIXAI_MODEL_INTEGRITY', lambda: worker.verify_model(directory, manifest))
            path.write_bytes(content)
            self.assertIs(worker.verify_model(directory, manifest), manifest)

    def test_general_tags_do_not_receive_character_style_meta_or_copyright(self):
        labels = ['dress', 'window', 'character_a', 'style_a', 'source_a', 'metadata_a',
                  'rating:g', 'rating:s', 'rating:q', 'rating:e']
        splits = [('general', 2), ('character', 1), ('style', 1), ('copyright', 1), ('meta', 1), ('rating', 4)]
        result = worker.result_payload(labels, splits, [0.8, 0.17, 0.28, 0.9, 0.9, 0.9, 0.7, 0.2, 0.08, 0.02], 0.17, {})
        self.assertEqual(result['tags'], ['dress'])
        self.assertEqual(result['scores'], {'dress': 0.8})
        self.assertEqual(result['characterTags'], ['character_a'])
        self.assertEqual(result['rating'], {'general': 0.7, 'sensitive': 0.2, 'questionable': 0.08, 'explicit': 0.02})
        self.assertEqual(result['engine'], 'pixai')

    def test_tag_and_character_limits_keep_highest_scores(self):
        labels = [f'general_{i}' for i in range(110)] + [f'character_{i}' for i in range(110)] + list(worker.RATING_NAMES)
        scores = [0.3 + i / 1000 for i in range(110)] * 2 + [0.9, 0.1, 0.02, 0.01]
        result = worker.result_payload(labels, [('general', 110), ('character', 110), ('rating', 4)], scores, 0.17, {})
        self.assertEqual(len(result['tags']), 100)
        self.assertEqual(len(result['characterTags']), 100)
        self.assertEqual(result['tags'][0], 'general_109')
        self.assertEqual(set(result['tags']), set(result['scores']))

    def test_threshold_and_invalid_numeric_outputs_are_rejected(self):
        for value in [True, '0.17', float('nan'), float('inf'), 0.04, 0.96]:
            self.assert_error('INVALID_PARAMETER', lambda: worker.threshold_value(value))
        self.assertEqual(worker.threshold_value(), 0.17)
        self.assert_error('PIXAI_INFERENCE_FAILED', lambda: worker.result_payload(['bad'], [('general', 1)], [float('nan')], 0.17, {}))

    def test_cuda_unavailable_or_low_memory_never_selects_cpu(self):
        cuda = SimpleNamespace(is_available=Mock(return_value=False), is_bf16_supported=Mock(return_value=True),
                               mem_get_info=Mock(return_value=(worker.MIN_FREE_BYTES - 1, 16 * 1024**3)),
                               set_per_process_memory_fraction=Mock())
        torch = SimpleNamespace(cuda=cuda)
        self.assert_error('PIXAI_GPU_UNAVAILABLE', lambda: worker.check_cuda(torch))
        cuda.is_available.return_value = True
        self.assert_error('PIXAI_GPU_BUSY', lambda: worker.check_cuda(torch))
        cuda.set_per_process_memory_fraction.assert_not_called()
        cuda.mem_get_info.return_value = (worker.MIN_FREE_BYTES, 16 * 1024**3)
        worker.check_cuda(torch)
        cuda.set_per_process_memory_fraction.assert_called_once_with(3 / 16, device=0)

    def test_image_20mib_allowed_and_one_byte_over_rejected(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'image.png'
            Image.new('RGB', (64, 64)).save(path)
            with path.open('ab') as output:
                output.write(b'\0' * (worker.MAX_IMAGE_BYTES - path.stat().st_size))
            image, meta = worker.read_image(str(path))
            image.close()
            self.assertEqual(meta['imageBytes'], worker.MAX_IMAGE_BYTES)
            with path.open('ab') as output:
                output.write(b'\0')
            self.assert_error('IMAGE_TOO_LARGE', lambda: worker.read_image(str(path)))

    def test_corrupt_images_and_excessive_dimensions_are_rejected(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'image.png'
            path.write_bytes(b'not an image')
            self.assert_error('INVALID_IMAGE', lambda: worker.read_image(str(path)))
            Image.new('RGB', (worker.MAX_SIDE + 1, 1)).save(path)
            self.assert_error('INVALID_IMAGE', lambda: worker.read_image(str(path)))
            self.assert_error('INVALID_IMAGE', lambda: worker.read_image('relative.png'))

    def test_serial_jsonl_reuses_model_and_recovers_after_bad_request(self):
        model = SimpleNamespace(infer=Mock(return_value={'ok': True, 'tags': ['dress']}))
        messages = io.StringIO('\n'.join([
            'not JSON', json.dumps({'requestId': 'a', 'imagePath': '/a.png'}),
            json.dumps({'requestId': 'b', 'imagePath': '/b.png', 'threshold': 0.35}), '',
        ]))
        output = []
        worker.serve(model, messages, output.append)
        self.assertEqual(output[0]['code'], 'INVALID_PARAMETER')
        self.assertEqual([row['requestId'] for row in output[1:]], ['a', 'b'])
        self.assertEqual(model.infer.call_count, 2)
        self.assertEqual(model.infer.call_args_list[0].args, ('/a.png', 0.17))
        self.assertEqual(model.infer.call_args_list[1].args, ('/b.png', 0.35))

    def test_oversized_jsonl_frame_stops_without_inference(self):
        model = SimpleNamespace(infer=Mock())
        output = []
        worker.serve(model, io.StringIO('x' * (16 * 1024 + 1)), output.append)
        self.assertEqual(output[0]['code'], 'INVALID_PARAMETER')
        model.infer.assert_not_called()


if __name__ == '__main__':
    unittest.main()
