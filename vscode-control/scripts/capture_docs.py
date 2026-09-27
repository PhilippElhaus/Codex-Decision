"""Capture synthetic, key-free Jev UI screenshots with Windows Edge."""

from pathlib import Path
from html import unescape
import json
import re
import subprocess
import tempfile
from urllib.parse import quote

from windows_browser import browser_environment, remove_profile, windows_path

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT.parent / 'docs' / 'images'


def main() -> None:
    edge, temporary = browser_environment()
    IMAGES.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix='jev-docs-', dir=temporary))
    try:
        target = windows_path(ROOT / 'tests/visual_harness.html').replace('\\', '/')
        address = 'file:///' + quote(target, safe='/:')
        captures = [
            ('menu', 'jev-menu.png', 620, 340),
            ('tooltip', 'jev-tooltip.png', 620, 280),
            ('unavailable', 'jev-unavailable.png', 620, 280),
            ('missing-key', 'jev-missing-key.png', 340, 260),
            ('onboarding', 'jev-onboarding.png', 520, 720),
            ('settings', 'jev-settings.png', 1040, 800),
        ]
        for state, name, width, height in captures:
            output = IMAGES / name
            result = subprocess.run([
                str(edge), '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions',
                '--hide-scrollbars', '--force-device-scale-factor=2',
                '--virtual-time-budget=950', f'--window-size={width},{height}',
                f'--user-data-dir={windows_path(profile / state)}',
                '--dump-dom', f'--screenshot={windows_path(output)}', address + '?demo=' + state,
            ], capture_output=True, text=True, timeout=30, check=False)
            if result.returncode != 0 or not output.is_file() or output.stat().st_size < 1000:
                raise RuntimeError(f'Could not capture {name}: exit={result.returncode}')
            output.chmod(0o644)
            found = re.search(r'data-layout="([^"]+)"', result.stdout)
            if not found:
                raise RuntimeError(f'Could not inspect {name} layout')
            layout = json.loads(unescape(found.group(1)))
            if state not in ('onboarding', 'settings') and abs((layout['buttonTop'] - layout['anchorTop']) - layout['screenshotOffset']) > 10:
                raise RuntimeError(f'{name} is vertically misaligned: {layout}')
            if state == 'onboarding' and 'id="codex-jev-connect"' not in result.stdout:
                raise RuntimeError('Connect Jev overlay was not rendered')
            if state == 'settings' and ('id="codex-jev-settings-panel"' not in result.stdout or
                                        'id="codex-jev-settings-lifetime-tokens"' not in result.stdout or
                                        '~87,320' not in result.stdout or
                                        '>Filter</option>' not in result.stdout):
                raise RuntimeError('Jev settings were not rendered in Codex settings')
            print(f'{name}: {output.stat().st_size} bytes; layout={layout}')
    finally:
        remove_profile(profile, 'jev-docs-')


if __name__ == '__main__':
    main()
