"""Run the real composer script in headless Edge with a mock VS Code bridge."""

from pathlib import Path
import json
import re
import subprocess
import tempfile
from urllib.parse import quote

from windows_browser import browser_environment, remove_profile, windows_path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    edge, temporary = browser_environment()
    profile = Path(tempfile.mkdtemp(prefix='jev-edge-test-', dir=temporary))
    try:
        target = windows_path(ROOT.parent / 'tests/browser/browser_harness.html').replace('\\', '/')
        address = 'file:///' + quote(target, safe='/:')
        reports = []
        for width, motion in ((360, 'reduce'), (720, 'no-preference'), (1200, 'reduce'),
                              (2800, 'no-preference')):
            result = subprocess.run([
                str(edge), '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions',
                f'--force-prefers-reduced-motion={motion}',
                '--virtual-time-budget=10000', f'--window-size={width},600',
                f'--user-data-dir={windows_path(profile / f"viewport-{width}")}',
                '--dump-dom', address,
            ], capture_output=True, text=True, timeout=30, check=False)
            match = re.search(r'<pre class="results" id="results">([^<]+)</pre>', result.stdout)
            if result.returncode != 0 or not match:
                raise RuntimeError(f'Edge browser harness failed at {width}px: exit={result.returncode}, result missing')
            outcome = json.loads(match.group(1).replace('&quot;', '"'))
            if not outcome.get('ok'):
                raise AssertionError({'viewport': width, **outcome})
            reports.append({'viewport': width, 'motion': motion, **outcome})
        print(json.dumps(reports))
    finally:
        remove_profile(profile, 'jev-edge-test-')


if __name__ == '__main__':
    main()
