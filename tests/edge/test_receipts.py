"""Session receipt, retention, and filesystem edge cases."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import re
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
from jev import Config, Result  # noqa: E402
from receipts import append_event, write_receipts  # noqa: E402


def event(session="receipt-session", output="Original ☃\n"):
    return {"session_id": session, "tool_use_id": "call-1", "tool_name": "Bash",
            "tool_input": {"command": "echo demo", "unrelated": "do not persist"},
            "tool_response": output}


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="jev-receipt-test-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def files(self):
        return sorted((self.root / "logs").glob("*/*-output.json"))

    def test_one_private_timestamped_file_per_call(self):
        item = event()
        result = Result("replace", "jev_replace", len(item["tool_response"]),
                        hook_output={"reason": "Short ☃\n"})
        calls = [{"state": {"output_sample": text, "chunk_index": index, "chunk_count": 3},
                  "answer": {"filter_approved": True}}
                 for index, text in enumerate(("one", "two", "three"), 1)]
        write_receipts(self.root, item, result, calls, "output")
        files = self.files()
        self.assertEqual(len(files), 3)
        self.assertRegex(files[0].parent.name, r"^\d{4}-\d{2}-\d{2}-[0-9a-f]{10}$")
        self.assertTrue(all(re.fullmatch(r"\d{2}-\d{2}-\d{2}-\d{3}-output\.json",
                                         path.name) for path in files))
        self.assertEqual([path.name.split("-")[3] for path in files], ["001", "002", "003"])
        self.assertEqual([json.loads(path.read_text())["call_index"] for path in files], [1, 2, 3])
        self.assertTrue(all(json.loads(path.read_text())["initial_output"] == "Original ☃\n" and
                            json.loads(path.read_text())["visible_output"] == "Short ☃\n" and
                            json.loads(path.read_text())["call_count"] == 3 and
                            json.loads(path.read_text())["tool_input"] == {"command": "echo demo"}
                            for path in files))
        if sys.platform != "win32":
            self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in files))
            self.assertEqual(stat.S_IMODE(files[0].parent.stat().st_mode), 0o700)

    def test_same_second_sequence_is_shared_across_filters(self):
        fixed = datetime(2026, 9, 27, 15, 47, 9, tzinfo=timezone.utc)
        result = Result("keep", "jev_keep", 10)
        with patch("receipts.datetime") as clock:
            clock.now.return_value = fixed
            write_receipts(self.root, event(), result,
                           [{"state": {}}, {"state": {}}], "output")
            write_receipts(self.root, event(), result,
                           [{"state": {}}], "test_build")
        names = sorted(path.name for path in (self.root / "logs").glob("*/*.json"))
        self.assertEqual(names, ["15-47-09-001-output.json", "15-47-09-002-output.json",
                                 "15-47-09-003-test_build.json"])

    def test_parallel_receipts_get_unique_same_second_names(self):
        fixed = datetime(2026, 9, 27, 15, 47, 9, tzinfo=timezone.utc)
        result = Result("keep", "jev_keep", 10)
        with patch("receipts.datetime") as clock:
            clock.now.return_value = fixed
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _: write_receipts(self.root, event(), result,
                                                       [{"state": {}}], "output"), range(32)))
        names = sorted(path.name for path in self.files())
        self.assertEqual(names, [f"15-47-09-{index:03d}-output.json" for index in range(1, 33)])

    def test_old_receipt_name_remains_managed(self):
        logs = self.root / "logs"
        logs.mkdir(mode=0o700)
        session = logs / "2026-09-27-aaaaaaaaaa"
        session.mkdir(mode=0o700)
        old = session / "receipt-15-47-09.698045-001-c2841103.json"
        old.write_text("x" * 600_000)
        output = "y" * 300_000
        write_receipts(self.root, event(output=output), Result("keep", "jev_keep", len(output)),
                       [{"state": {}}], "output", 1)
        self.assertFalse(old.exists())
        self.assertEqual(len(self.files()), 1)

    def test_oldest_receipt_is_removed_at_one_mb(self):
        large = "x" * 340_000
        result = Result("keep", "jev_keep", len(large))
        write_receipts(self.root, event("old", large), result, [{"state": {"output_sample": "old"}}], "output", 1)
        old = self.files()[0]
        write_receipts(self.root, event("new", large), result, [{"state": {"output_sample": "new"}}], "output", 1)
        self.assertFalse(old.exists())
        self.assertEqual(len(self.files()), 1)
        self.assertEqual(json.loads(self.files()[0].read_text())["session_id"], "new")
        self.assertLessEqual(sum(path.stat().st_size for path in self.files()), 1_000_000)

    def test_never_delete_overrides_limit(self):
        large = "x" * 340_000
        result = Result("keep", "jev_keep", len(large))
        for session in ("old", "new"):
            write_receipts(self.root, event(session, large), result,
                           [{"state": {"output_sample": session}}], "output", 1, True)
        self.assertEqual(len(self.files()), 2)
        self.assertGreater(sum(path.stat().st_size for path in self.files()), 1_000_000)

    def test_unknown_file_and_link_are_preserved(self):
        logs = self.root / "logs"
        logs.mkdir(mode=0o700)
        session = logs / "2026-09-27-aaaaaaaaaa"
        session.mkdir()
        unknown = session / "user-note.txt"
        unknown.write_text("keep")
        target = self.root / "elsewhere"
        target.write_text("keep")
        link = session / "receipt-linked.json"
        link.symlink_to(target)
        large = "x" * 340_000
        result = Result("keep", "jev_keep", len(large))
        for name in ("one", "two"):
            write_receipts(self.root, event(name, large), result,
                           [{"state": {"output_sample": name}}], "output", 1)
        self.assertEqual(unknown.read_text(), "keep")
        self.assertTrue(link.is_symlink())
        self.assertEqual(target.read_text(), "keep")

    def test_linked_log_root_is_rejected(self):
        target = self.root / "target"
        target.mkdir()
        (self.root / "logs").symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError):
            write_receipts(self.root, event(), Result("keep", "jev_keep"),
                           [{"state": {"output_sample": "x"}}], "output")
        self.assertEqual(list(target.iterdir()), [])

    def test_linked_session_directory_is_rejected(self):
        logs = self.root / "logs"
        logs.mkdir(mode=0o700)
        target = self.root / "target"
        target.mkdir()
        from datetime import datetime, timezone
        folder = datetime.now(timezone.utc).strftime("%Y-%m-%d") + "-" + hashlib.sha256(b"linked").hexdigest()[:10]
        (logs / folder).symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError):
            write_receipts(self.root, event("linked"), Result("keep", "jev_keep"),
                           [{"state": {"output_sample": "x"}}], "output")
        self.assertEqual(list(target.iterdir()), [])

    def test_never_delete_keeps_large_activity_index(self):
        logs = self.root / "logs"
        logs.mkdir(mode=0o700)
        index = logs / "events.jsonl"
        index.write_text("x" * 1_050_000 + "\n")
        append_event(self.root, event(), {"status": "calling", "reason": "jev_request"}, 1, True)
        self.assertGreater(index.stat().st_size, 1_048_576)

    def test_parallel_event_writes_have_complete_lines_and_cumulative_stats(self):
        def record(number):
            append_event(self.root, event("same"), {"status": "calling", "reason": "jev_request", "tool": "Bash"})
            append_event(self.root, event("same"), {"status": "replace", "reason": "jev_replace", "tool": "Bash",
                                                   "original_chars": 1000, "capsule_chars": 100, "elapsed_ms": number})
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(record, range(1, 33)))
        rows = [json.loads(line) for line in (self.root / "logs/events.jsonl").read_text().splitlines()]
        self.assertEqual(len(rows), 64)
        stats = json.loads((self.root / "stats.json").read_text())
        self.assertEqual((stats["calls"], stats["completed"], stats["replaced"]), (32, 32, 32))
        self.assertEqual(stats["savedChars"], 28_800)
        self.assertEqual(stats["timed"], 32)

    def test_config_rejects_bad_retention_values(self):
        config = self.root / "config.json"
        for value in (0, -1, 10000, 1.5, "50", True):
            config.write_text(json.dumps({"log_limit_mb": value}))
            with self.subTest(value=value), self.assertRaises(ValueError):
                Config.from_file(config)
        config.write_text(json.dumps({"never_delete_logs": "yes"}))
        with self.assertRaises(ValueError):
            Config.from_file(config)
        config.write_text(json.dumps({"log_limit_mb": 9999, "never_delete_logs": True}))
        self.assertEqual(Config.from_file(config).log_limit_mb, 9999)


if __name__ == "__main__":
    unittest.main()
