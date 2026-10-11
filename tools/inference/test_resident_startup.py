"""Initial fingerprint/import overlap and owned lease cleanup; no ML or GPU."""
from threading import Event
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from resident_anima import PipelineCache


class StartupTests(unittest.TestCase):
    def test_imports_overlap_hash_and_failure_joins_before_releasing_lease(self):
        for failure in (False, True):
            with self.subTest(failure=failure):
                cache = PipelineCache()
                began, finish = Event(), Event()
                events = []
                cache.file_identity = SimpleNamespace(close=lambda: events.append("closed"))
                def fingerprint(*args):
                    began.set()
                    self.assertTrue(finish.wait(5))
                    events.append("hashed")
                    return {"modelSha256": "checked", "loras": []}
                def check():
                    self.assertTrue(began.wait(5), "hashing must start before imports finish")
                    finish.set()
                    if failure:
                        raise RuntimeError("dependency import failed")
                with patch.object(cache, "fingerprint", side_effect=fingerprint):
                    if failure:
                        with self.assertRaisesRegex(RuntimeError, "dependency import"):
                            cache.prepare_and_fingerprint(check, None, [], lambda _: None)
                        self.assertEqual(events, ["hashed", "closed"])
                    else:
                        identity, seconds = cache.prepare_and_fingerprint(check, None, [], lambda _: None)
                        self.assertEqual(identity["modelSha256"], "checked")
                        self.assertGreaterEqual(seconds, 0)
                        self.assertTrue(cache.runtime_ready)
                        self.assertEqual(events, ["hashed"])
                        cache.clear()


if __name__ == "__main__":
    unittest.main()
