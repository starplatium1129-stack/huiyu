"""Small real files and Windows CNG lifecycle checks; no weights or GPU required."""
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_hash


class NativeHashTests(unittest.TestCase):
    def test_known_sha256_and_partial_final_chunk(self):
        cases = (
            (b"", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            (b"abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            (bytes(range(256)) * 4096 + b"tail", "27179059975dd520b91fa660e46f2d163b957569f8fe2f916fb8ef2a957f54d8"),
        )
        with tempfile.TemporaryDirectory() as directory, patch.object(native_hash, "_CHUNK_BYTES", 65537):
            path = Path(directory) / "content.bin"
            for payload, expected in cases:
                with self.subTest(size=len(payload)):
                    path.write_bytes(payload)
                    self.assertEqual(native_hash.file_sha256(path), expected)

    def test_portable_provider_reads_full_file(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(native_hash, "_bcrypt", None):
            path = Path(directory) / "content.bin"
            path.write_bytes(b"abc")
            self.assertEqual(native_hash.file_sha256(path),
                             "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

    @unittest.skipIf(native_hash._bcrypt is None, "Requires the real Windows CNG provider")
    def test_read_failure_releases_native_resources(self):
        class FailingSource(io.BytesIO):
            def readinto(self, buffer):
                raise OSError("input read failed")

        source = FailingSource()
        with patch.object(Path, "open", return_value=source), \
                patch.object(native_hash._bcrypt, "BCryptDestroyHash", wraps=native_hash._bcrypt.BCryptDestroyHash) as destroy, \
                patch.object(native_hash._bcrypt, "BCryptCloseAlgorithmProvider", wraps=native_hash._bcrypt.BCryptCloseAlgorithmProvider) as close:
            with self.assertRaisesRegex(OSError, "input read failed"):
                native_hash.file_sha256("unopened-test-path")
            destroy.assert_called_once()
            close.assert_called_once()
        self.assertTrue(source.closed)

    @unittest.skipIf(native_hash._bcrypt is None, "Requires the real Windows CNG provider")
    def test_native_failure_is_explicit_and_releases_acquired_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "content.bin"
            path.write_bytes(b"abc")
            for operation, creates_hash in (("BCryptCreateHash", False), ("BCryptHashData", True)):
                with self.subTest(operation=operation), \
                        patch.object(native_hash._bcrypt, operation, return_value=-1073741811), \
                        patch.object(native_hash._bcrypt, "BCryptDestroyHash", wraps=native_hash._bcrypt.BCryptDestroyHash) as destroy, \
                        patch.object(native_hash._bcrypt, "BCryptCloseAlgorithmProvider", wraps=native_hash._bcrypt.BCryptCloseAlgorithmProvider) as close, \
                        patch.object(native_hash.hashlib, "file_digest") as fallback:
                    with self.assertRaisesRegex(OSError, operation + " failed with NTSTATUS 0xc000000d"):
                        native_hash.file_sha256(path)
                    self.assertEqual(destroy.call_count, int(creates_hash))
                    close.assert_called_once()
                    fallback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
