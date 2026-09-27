"""Keep local documentation links valid as test files and images move."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
LINK = re.compile(r"\[[^\]]+\]\(([^)]+)\)|<img\s+[^>]*src=\"([^\"]+)\"", re.I)


class DocumentationLinkSmokeTests(unittest.TestCase):
    def test_local_links_resolve(self):
        documents = [ROOT / "README.md", ROOT / "tests/README.md", ROOT / "vscode-control/README.md",
                     *sorted((ROOT / "docs").rglob("*.md"))]
        missing = []
        for document in documents:
            for match in LINK.finditer(document.read_text(encoding="utf-8")):
                target = (match.group(1) or match.group(2)).split("#", 1)[0]
                if not target or re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                    continue
                if not (document.parent / target).exists():
                    missing.append(f"{document.relative_to(ROOT)}: {target}")
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
