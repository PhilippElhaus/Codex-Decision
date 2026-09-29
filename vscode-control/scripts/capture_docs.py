"""Capture the real Jev webviews with synthetic, key-free example state."""

from pathlib import Path
from html import unescape
import json
import re
import subprocess
import tempfile
from urllib.parse import quote

from PIL import Image

from windows_browser import browser_environment, remove_profile, windows_path

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT.parent / 'docs' / 'images'


def main() -> None:
    edge, temporary = browser_environment()
    IMAGES.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix='jev-docs-', dir=temporary))
    try:
        target = windows_path(ROOT.parent / 'tests/browser/visual_harness.html').replace('\\', '/')
        address = 'file:///' + quote(target, safe='/:')
        captures = [
            ('menu', 'jev-menu.png', 620, 340),
            ('tooltip', 'jev-tooltip.png', 620, 280),
            ('unavailable', 'jev-unavailable.png', 620, 280),
            ('onboarding', 'jev-connect.png', 950, 610),
            ('settings', 'jev-settings.png', 1040, 1650),
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
                                        '87,320' not in result.stdout or
                                        'Can omit, minimum' not in result.stdout or
                                        'Exact text needed, maximum' not in result.stdout or
                                        '>Filter</option>' not in result.stdout):
                raise RuntimeError('Jev settings were not rendered in Codex settings')
            print(f'{name}: {output.stat().st_size} bytes; layout={layout}')
        settings = Image.open(IMAGES / 'jev-settings.png')
        if settings.size != (2080, 3300):
            raise RuntimeError(f'Unexpected settings capture size: {settings.size}')
        for name, box in (
            ('jev-settings-overview.png', (0, 0, 2080, 1250)),
            ('jev-settings-filters.png', (0, 1240, 2080, 2550)),
        ):
            settings.crop(box).save(IMAGES / name, optimize=True)
            print(f'{name}: {box}')
        panel = IMAGES / 'jev-panel.png'
        light_panel = IMAGES / 'jev-panel-light.png'
        panel_address = 'file:///' + quote(windows_path(ROOT.parent / 'tests/browser/jev_panel_harness.html').replace('\\', '/'), safe='/:')
        for state, output, suffix in (('dark', panel, ''), ('light', light_panel, '?light')):
            result = subprocess.run([
                str(edge), '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
                '--force-device-scale-factor=2', '--virtual-time-budget=2500',
                '--window-size=800,460', f'--user-data-dir={windows_path(profile / ("panel-" + state))}',
                '--dump-dom', f'--screenshot={windows_path(output)}', panel_address + suffix,
            ], capture_output=True, text=True, timeout=30, check=False)
            if result.returncode != 0 or not output.is_file() or 'JEV_LINE_PANEL_READY' not in result.stdout:
                raise RuntimeError(f'Could not capture the current {state} line-level Jev panel')
            with Image.open(output) as captured:
                captured.crop((0, 0, captured.width, min(captured.height, 520))).save(output, optimize=True)
            output.chmod(0o644)
            print(f'{output.name}: {output.stat().st_size} bytes')
        with Image.open(panel) as dark, Image.open(light_panel) as light:
            comparison = Image.new('RGB', (dark.width, dark.height + light.height + 20), 'white')
            comparison.paste(dark.convert('RGB'), (0, 0))
            comparison.paste(light.convert('RGB'), (0, dark.height + 20))
            comparison.save(IMAGES / 'jev-panel-themes.png', optimize=True)
    finally:
        remove_profile(profile, 'jev-docs-')


if __name__ == '__main__':
    main()
