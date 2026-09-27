"""Exercise the default 50 MB receipt budget with real serialized files."""

import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
from jev import Result  # noqa: E402
from receipts import write_receipts  # noqa: E402


class ReceiptLoadTests(unittest.TestCase):
    def test_default_budget_prunes_oldest_and_keeps_recent_receipts(self):
        with tempfile.TemporaryDirectory(prefix="jev-receipt-load-", dir="/tmp") as directory:
            root = Path(directory)
            output = "repeated result\n" * 50_000
            result = Result("keep", "jev_keep", len(output))
            first = None
            for index in range(38):
                event = {"session_id": f"load-{index:03d}", "tool_use_id": "call",
                         "tool_name": "Bash", "tool_input": {"command": "echo demo"},
                         "tool_response": output}
                write_receipts(root, event, result, [{"state": {"output_sample": "sample"}}], "output")
                if index == 0:
                    first = next((root / "logs").glob("*/*-output.json"))
            receipts = list((root / "logs").glob("*/*-output.json"))
            total = sum(path.stat().st_size for path in receipts)
            self.assertLessEqual(total, 50_000_000)
            self.assertLess(len(receipts), 38)
            self.assertFalse(first.exists())
            self.assertEqual(max(json.loads(path.read_text())["session_id"] for path in receipts), "load-037")


if __name__ == "__main__":
    unittest.main()
