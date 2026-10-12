"""Real Windows sharing/file-ID checks on disposable tiny files; no models/GPU."""
from concurrent.futures import ThreadPoolExecutor
import ctypes
from ctypes import wintypes
import mmap
import os
from pathlib import Path
import struct
import tempfile
import unittest

from locked_identity import COMPONENTS, IdentityLease, _Unsupported, _Windows
from teacache_profile import adapter_identity, model_identity


@unittest.skipUnless(os.name == "nt", "Windows file sharing is an OS guarantee")
class IdentityLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="huiyu-identity-lease-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "model"
        self.root.mkdir()
        for component in COMPONENTS:
            folder = self.root / component
            folder.mkdir()
            (folder / "asset.bin").write_bytes(component.encode())
        (self.root / "model_index.json").write_text("{}")
        self.lora = self.base / "adapter.safetensors"
        self.lora.write_bytes(b"disposable adapter bytes")
        self.loras = [{"path": str(self.lora), "strength": .6}]
        self.lease = IdentityLease()
        self.addCleanup(self.lease.close)
        self.hashes = 0
        self.adapter_batches = []

    def fingerprint(self, root, loras):
        self.hashes += 1
        return model_identity(root, loras)

    def acquire(self, loras=None, callback=None):
        return self.lease.acquire(self.root, self.loras if loras is None else loras,
                                  callback or self.fingerprint, self.fingerprint_adapters)

    def fingerprint_adapters(self, loras):
        self.adapter_batches.append([row["path"] for row in loras])
        return adapter_identity(loras)

    def assert_writable(self):
        for path in [*self.root.rglob("*.bin"), self.root / "model_index.json", self.lora]:
            with path.open("r+b"):
                pass

    def test_rust_extended_local_paths_reuse_and_keep_file_protection(self):
        expected = model_identity(self.root, self.loras)
        root = Path("\\\\?\\" + str(self.root))
        loras = [{**self.loras[0], "path": "\\\\?\\" + str(self.lora)}]
        self.assertEqual(self.lease.acquire(root, loras, self.fingerprint, self.fingerprint_adapters), expected)
        self.assertTrue(self.lease.cached)
        with self.assertRaises(PermissionError):
            self.lora.write_bytes(b"replacement")
        self.assertEqual(self.lease.acquire(root, loras, self.fingerprint, self.fingerprint_adapters), expected)
        self.assertTrue(self.lease.reused)
        self.assertEqual(self.hashes, 1)
        self.lease.close()
        self.assert_writable()

    def test_network_and_device_namespaces_do_not_acquire_a_lease(self):
        windows = _Windows()
        for value in (r"\\server\share\model", r"\\?\UNC\server\share\model",
                      r"\\?\Volume{00000000-0000-0000-0000-000000000000}\model", r"\\.\C:\model"):
            with self.subTest(path=value), self.assertRaises(_Unsupported):
                windows.open(Path(value), directory=True)

    def test_reuse_locks_all_bytes_but_allows_parallel_readers_and_close_releases(self):
        expected = model_identity(self.root, self.loras)

        def parallel(root, loras):
            self.hashes += 1
            with ThreadPoolExecutor(max_workers=4) as readers:
                identities = list(readers.map(lambda _: model_identity(root, loras), range(4)))
            self.assertTrue(all(value == expected for value in identities))
            return identities[0]

        self.assertEqual(self.acquire(callback=parallel), expected)
        self.assertTrue(self.lease.cached)
        self.assertTrue(self.lease.base_is_valid())
        self.assertTrue(self.lease.base_is_valid(self.root, expected["modelSha256"]))
        self.assertFalse(self.lease.base_is_valid(self.root / "another", expected["modelSha256"]))
        self.assertFalse(self.lease.base_is_valid(self.root, "different-model-bytes"))
        self.assertFalse(self.lease.reused)
        for path in [*self.root.rglob("*.bin"), self.root / "model_index.json", self.lora]:
            with self.subTest(path=path):
                with self.assertRaises(PermissionError):
                    path.write_bytes(b"replacement")
                with self.assertRaises(PermissionError):
                    path.unlink()
                with self.assertRaises(PermissionError):
                    path.rename(path.with_suffix(".moved"))
        value = self.acquire()
        self.assertEqual(value, expected)
        self.assertTrue(self.lease.reused)
        self.assertEqual(self.hashes, 1)
        value["loras"][0]["sha256"] = "caller mutation"
        self.assertEqual(self.acquire(), expected)
        self.lease.close()
        self.lease.close()
        self.assertFalse(self.lease.cached)
        self.assertFalse(self.lease.base_is_valid())
        self.assert_writable()
        renamed = self.lora.rename(self.lora.with_suffix(".moved"))
        renamed.unlink()

    def test_membership_and_order_changes_rehash_strength_only_updates_scope(self):
        initial = self.acquire()
        stronger = [{**self.loras[0], "strength": .9}]
        self.assertEqual(self.acquire(stronger), {**initial, "loras": [{**initial["loras"][0], "strength": .9}]})
        self.assertTrue(self.lease.reused)
        self.assertEqual(self.hashes, 1)
        extra = self.root / "transformer" / "added.bin"
        extra.write_bytes(b"new component member")
        updated = self.acquire()
        self.assertNotEqual(updated["modelSha256"], initial["modelSha256"])
        self.assertEqual(updated, model_identity(self.root, self.loras))
        self.assertEqual(self.hashes, 2)
        second = self.base / "second.safetensors"
        second.write_bytes(b"second adapter")
        pair = [self.loras[0], {"path": str(second), "strength": .3}]
        forward = self.acquire(pair)
        backward = self.acquire(list(reversed(pair)))
        self.assertEqual(backward["loras"], list(reversed(forward["loras"])))
        self.assertFalse(self.lease.reused)
        # Model membership required the second full hash; adapter additions and
        # order changes retain that continuously protected base identity.
        self.assertEqual(self.hashes, 2)
        self.assertEqual(self.adapter_batches, [[str(self.lora), str(second)]])

    def test_directory_replacement_is_blocked_until_close_then_rehashed(self):
        initial = self.acquire()
        original = self.base / "original"
        with self.assertRaises(PermissionError):
            self.root.rename(original)
        with self.assertRaises(PermissionError):
            self.base.rename(self.base.with_name(self.base.name + "-renamed"))
        self.assertEqual(self.acquire(), initial)
        self.lease.close()
        self.root.rename(original)
        self.root.mkdir()
        for component in COMPONENTS:
            folder = self.root / component
            folder.mkdir()
            (folder / "asset.bin").write_bytes(b"replacement" + component.encode())
        (self.root / "model_index.json").write_text("{}")
        self.assertNotEqual(self.acquire()["modelSha256"], initial["modelSha256"])
        self.assertEqual(self.hashes, 2)

    def test_existing_writer_or_writable_mapping_never_becomes_cached(self):
        with self.lora.open("r+b") as writer:
            self.assertEqual(self.acquire(), model_identity(self.root, self.loras))
            self.assertFalse(self.lease.cached)
            self.assertFalse(self.lease.reused)
            self.assertFalse(self.lease.base_is_valid())
            self.acquire()
            self.assertEqual(self.hashes, 2)
            self.assert_writable()
            mapped = mmap.mmap(writer.fileno(), 0, access=mmap.ACCESS_WRITE)
        try:
            self.acquire()
            self.assertFalse(self.lease.cached)
            mapped[0:1] = b"M"
        finally:
            mapped.close()
        expected = model_identity(self.root, self.loras)
        self.assertEqual(self.acquire(), expected)
        self.assertTrue(self.lease.cached)

    def test_hash_failure_or_membership_race_releases_every_handle(self):
        def failure(root, loras):
            raise RuntimeError("fingerprint failed")

        with self.assertRaisesRegex(RuntimeError, "fingerprint failed"):
            self.acquire(callback=failure)
        self.assertFalse(self.lease.cached)
        self.assert_writable()

        def add_during_hash(root, loras):
            value = model_identity(root, loras)
            (root / "vae" / "new.bin").write_bytes(b"concurrent membership change")
            return value

        with self.assertRaisesRegex(OSError, "membership changed while fingerprinting"):
            self.acquire(callback=add_during_hash)
        self.assertFalse(self.lease.cached)
        self.assert_writable()

    def test_temporary_member_in_hash_is_rejected_even_when_inventory_returns(self):
        expected = model_identity(self.root, self.loras)

        def hash_transient_member(root, loras):
            transient = root / "vae" / "transient.bin"
            transient.write_bytes(b"present only while fingerprinting")
            try:
                value = model_identity(root, loras)
                self.assertNotEqual(value, expected)
                return value
            finally:
                transient.unlink()

        with self.assertRaisesRegex(OSError, "membership changed while fingerprinting"):
            self.acquire(callback=hash_transient_member)
        self.assertFalse(self.lease.cached)
        self.assertFalse(self.lease.reused)
        self.assert_writable()
        self.assertEqual(self.acquire(), expected)

    def test_transient_cached_membership_changes_invalidate_model_and_lora_watches(self):
        expected = self.acquire()
        for index, transient in enumerate((self.root / "transformer" / "transient.bin", self.lora.parent / "transient.bin")):
            with self.subTest(path=transient):
                previous_hashes = self.hashes
                transient.write_bytes(b"created and removed between jobs")
                transient.unlink()
                self.assertEqual(self.acquire(), expected)
                self.assertFalse(self.lease.reused)
                self.assertTrue(self.lease.cached)
                self.assertEqual(self.hashes, previous_hashes + (index == 0))
                if index == 1:
                    self.assertEqual(self.adapter_batches, [[str(self.lora)]])
        self.lease.close()
        self.assert_writable()
        self.root.rename(self.base / "released-model")

    def test_atomic_output_replacement_preserves_file_and_directory_protection(self):
        output = self.base / "output"
        output.mkdir()
        expected = self.acquire()
        for folder in (self.root, self.base, output):
            with self.subTest(folder=folder):
                temporary, target = folder / "temporary.png", folder / "result.png"
                target.write_bytes(b"old output")
                temporary.write_bytes(b"new output")
                os.replace(temporary, target)
                self.assertEqual(target.read_bytes(), b"new output")
                with self.assertRaises(PermissionError):
                    self.lora.write_bytes(b"cannot overwrite protected weights")
                with self.assertRaises(PermissionError):
                    self.root.rename(self.base / "renamed-model")
        self.assertEqual(self.acquire(), expected)
        self.lease.close()
        self.root.rename(self.base / "released-model")

    def test_transient_reparse_and_ancestor_attributes_invalidate_the_lease(self):
        empty = self.root / "transformer" / "empty"
        empty.mkdir()
        destination = self.base / "junction-target"
        destination.mkdir()
        expected = self.acquire()
        api = self.lease._windows.api
        control = api.DeviceIoControl
        control.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
                            wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID)
        control.restype = wintypes.BOOL
        mutator = api.CreateFileW(str(empty), 0x40000000, 3, None, 3, 0x02200000, None)
        if mutator == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        substitute = ("\\??\\" + str(destination)).encode("utf-16-le")
        printable = str(destination).encode("utf-16-le")
        paths = substitute + b"\0\0" + printable + b"\0\0"
        reparse = struct.pack("<IHHHHHH", 0xA0000003, len(paths) + 8, 0,
                              0, len(substitute), len(substitute) + 2, len(printable)) + paths
        delete = struct.pack("<IHH", 0xA0000003, 0, 0)

        def ioctl(code, payload):
            returned = wintypes.DWORD()
            if not control(mutator, code, payload, len(payload), None, 0, ctypes.byref(returned), None):
                raise ctypes.WinError(ctypes.get_last_error())

        try:
            ioctl(0x900A4, reparse)
            try:
                self.assertTrue(empty.lstat().st_file_attributes & 0x400)
            finally:
                ioctl(0x900AC, delete)
        finally:
            api.CloseHandle(mutator)
        self.assertEqual(self.acquire(), expected)
        self.assertFalse(self.lease.reused)
        self.assertEqual(self.hashes, 2)
        attributes = api.SetFileAttributesW
        attributes.argtypes, attributes.restype = (wintypes.LPCWSTR, wintypes.DWORD), wintypes.BOOL
        previous = self.base.stat().st_file_attributes
        self.assertTrue(attributes(str(self.base), previous | 1))
        self.assertTrue(attributes(str(self.base), previous))
        self.assertEqual(self.acquire(), expected)
        self.assertFalse(self.lease.reused)
        self.assertEqual(self.hashes, 3)

    def test_switch_hashes_only_new_adapters_and_keeps_base_protected(self):
        second = self.base / "second.safetensors"
        second.write_bytes(b"second adapter")
        pair = [self.loras[0], {"path": str(second), "strength": .3}]
        initial = self.acquire()

        def hash_new(rows):
            self.assertTrue(self.lease.base_is_valid())
            with self.assertRaises(PermissionError):
                (self.root / "transformer" / "asset.bin").write_bytes(b"changed")
            return self.fingerprint_adapters(rows)

        result = self.lease.acquire(self.root, pair, self.fingerprint, hash_new)
        self.assertEqual(result, model_identity(self.root, pair))
        self.assertEqual(result["modelSha256"], initial["modelSha256"])
        self.assertEqual(self.hashes, 1)
        self.assertEqual(self.adapter_batches, [[str(second)]])
        self.assertFalse(self.lease.reused)
        self.assertTrue(self.lease.base_is_valid())
        self.assertEqual(self.acquire(pair), result)
        self.assertTrue(self.lease.reused)
        self.assertEqual(self.adapter_batches, [[str(second)]])

        reversed_pair = list(reversed(pair))
        self.assertEqual(self.acquire(reversed_pair), model_identity(self.root, reversed_pair))
        self.assertFalse(self.lease.reused)
        self.assertEqual(self.adapter_batches, [[str(second)]])
        # Windows path aliases may name one locked file more than once. Preserve
        # each requested strength without mistaking spelling for a new file.
        aliases = [pair[0], {**pair[0], "path": str(self.lora).upper(), "strength": .7}, pair[1]]
        self.assertEqual(self.acquire(aliases), model_identity(self.root, aliases))
        self.assertEqual(self.adapter_batches, [[str(second)]])
        self.assertEqual(self.acquire([]), {"modelSha256": initial["modelSha256"], "loras": []})
        self.assertTrue(self.lease.base_is_valid())
        self.assertFalse(self.lease.reused)
        for path in (self.lora, second):
            with path.open("r+b"):
                pass
        self.assertEqual(self.hashes, 1)

    def test_base_events_latch_and_adapter_hash_races_release_both_sets(self):
        second = self.base / "second.safetensors"
        second.write_bytes(b"second adapter")
        expected = self.acquire()
        transient = self.root / "transformer" / "transient.bin"
        transient.write_bytes(b"created and removed")
        transient.unlink()
        self.assertFalse(self.lease.base_is_valid())
        self.assertEqual(self.acquire(), expected)
        self.assertFalse(self.lease.reused)
        self.assertTrue(self.lease.base_is_valid())
        self.assertEqual(self.hashes, 2)

        def hash_then_change(rows):
            result = adapter_identity(rows)
            transient.write_bytes(b"created during adapter hashing")
            transient.unlink()
            return result

        with self.assertRaisesRegex(OSError, "membership changed while fingerprinting"):
            self.lease.acquire(self.root, [{"path": str(second), "strength": .3}],
                               self.fingerprint, hash_then_change)
        self.assertFalse(self.lease.cached)
        self.assertFalse(self.lease.base_is_valid())
        self.assert_writable()
        with second.open("r+b"):
            pass


if __name__ == "__main__":
    unittest.main()
