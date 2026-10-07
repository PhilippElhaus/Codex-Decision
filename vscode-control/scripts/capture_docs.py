"""Capture the real Decision webviews with synthetic, key-free example state."""

from pathlib import Path
from html import unescape
import argparse
import json
import re
import subprocess
import tempfile
from urllib.parse import quote

from PIL import Image

from windows_browser import browser_environment, remove_profile, windows_path

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT.parent / 'docs' / 'images'


def chromium_capture() -> None:
    from playwright.sync_api import sync_playwright

    IMAGES.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for state, name, width, height in (
                ('composer', 'decision-toggle.png', 620, 240),
                ('classification', 'decision-classification.png', 620, 240),
                ('onboarding', 'decision-connect.png', 950, 610),
                ('settings', 'decision-settings.png', 1040, 1080),
            ):
                page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=2)
                page.goto((ROOT.parent / 'tests/browser/visual_harness.html').as_uri() + '?demo=' + state)
                page.wait_for_function('document.title === "DECISION_VISUAL_READY"')
                if state in ('composer', 'classification'):
                    assert page.locator('#codex-decision-menu').count() == 0
                    assert page.locator('#codex-decision-button').get_attribute('role') == 'switch'
                    assert page.locator('#codex-decision-button').get_attribute('aria-checked') == 'true'
                    layout = json.loads(page.locator('body').get_attribute('data-layout'))
                    assert abs(layout['buttonTop'] - layout['anchorTop'] - layout['screenshotOffset']) <= 10
                    if state == 'classification':
                        page.evaluate('window.dispatchEvent(new Event("focus"))')
                        page.wait_for_function('document.getElementById("codex-decision").dataset.classifying === "true"')
                        assert page.locator('#codex-decision-button').evaluate('node => node.style.color') == 'rgb(105, 174, 240)'
                elif state == 'onboarding':
                    assert page.locator('#codex-decision-connect').is_visible()
                    assert page.locator('#codex-decision-key').input_value() == ''
                else:
                    assert page.locator('#codex-decision-settings-panel').is_visible()
                    assert page.locator('#codex-decision-settings-lifetime-tokens').inner_text() == '87,320'
                    assert page.locator('#codex-decision-settings-thresholds h2').count() == 1
                    assert page.locator('#codex-decision-settings-output-relevant_max').input_value() == '5%'
                    assert page.locator('#codex-decision-settings-relevance-guard').count() == 0
                page.screenshot(path=str(IMAGES / name))
                print(name)
                page.close()
            with Image.open(IMAGES / 'decision-settings.png') as settings:
                for name, box in (
                    ('decision-settings-overview.png', (0, 0, 2080, 1550)),
                    ('decision-settings-filters.png', (0, 1540, 2080, 2110)),
                ):
                    settings.crop(box).save(IMAGES / name, optimize=True)
            (IMAGES / 'decision-settings.png').unlink()
            for state, name, height, count, expected in (
                ('fifty', 'decision-panel.png', 900, 50, ('3 / 50 kept',)),
                ('reviewed', 'decision-demo-tests.png', 520, 20,
                 ('5 / 124 kept', 'actual: 6000')),
            ):
                page = browser.new_page(viewport={'width': 1200, 'height': height})
                page.goto((ROOT.parent / 'tests/browser/decision_panel_harness.html').as_uri() + f'?{state}&capture')
                page.wait_for_function('document.title === "DECISION_LINE_PANEL_READY"')
                assert page.locator('.card-kicker,.batch-summary,.batch-legend').count() == 0
                assert page.locator('.batch-row').count() == count
                assert all(text in page.locator('body').inner_text() for text in expected)
                capture_height = int(page.locator('body').get_attribute('data-capture-height'))
                assert 0 < capture_height <= height
                page.screenshot(path=str(IMAGES / name), clip={
                    'x': 0, 'y': 0, 'width': 1200, 'height': capture_height,
                })
                print(name)
                page.close()
        finally:
            browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', choices=['edge', 'chromium'], default='edge')
    if parser.parse_args().browser == 'chromium':
        chromium_capture()
        return
    edge, temporary = browser_environment()
    IMAGES.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix='jev-docs-', dir=temporary))
    try:
        target = windows_path(ROOT.parent / 'tests/browser/visual_harness.html').replace('\\', '/')
        address = 'file:///' + quote(target, safe='/:')
        captures = [
            ('composer', 'decision-toggle.png', 620, 240),
                ('classification', 'decision-classification.png', 620, 240),
            ('onboarding', 'decision-connect.png', 950, 610),
            ('settings', 'decision-settings.png', 1040, 1080),
        ]
        for state, name, width, height in captures:
            output = profile / name if state == 'settings' else IMAGES / name
            result = subprocess.run([
                str(edge), '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions',
                '--hide-scrollbars', '--force-device-scale-factor=2',
                f'--virtual-time-budget={400 if state == "classification" else 950}', f'--window-size={width},{height}',
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
            if state == 'classification' and 'data-classifying="true"' not in result.stdout:
                raise RuntimeError('Classification did not light up the composer')
            if state == 'onboarding' and 'id="codex-decision-connect"' not in result.stdout:
                raise RuntimeError('Connect Decision overlay was not rendered')
            if state == 'settings' and ('id="codex-decision-settings-panel"' not in result.stdout or
                                        'id="codex-decision-settings-lifetime-tokens"' not in result.stdout or
                                        '87,320' not in result.stdout or
                                        'All sessions' not in result.stdout or
                                        'Relevance, maximum for omission' not in result.stdout or
                                        '>Filter</option>' not in result.stdout):
                raise RuntimeError('Decision settings were not rendered in Codex settings')
            print(f'{name}: {output.stat().st_size} bytes; layout={layout}')
        settings = Image.open(profile / 'decision-settings.png')
        if settings.size != (2080, 2160):
            raise RuntimeError(f'Unexpected settings capture size: {settings.size}')
        for name, box in (
            ('decision-settings-overview.png', (0, 0, 2080, 1550)),
            ('decision-settings-filters.png', (0, 1540, 2080, 2110)),
        ):
            settings.crop(box).save(IMAGES / name, optimize=True)
            print(f'{name}: {box}')
        panel_address = 'file:///' + quote(windows_path(ROOT.parent / 'tests/browser/decision_panel_harness.html').replace('\\', '/'), safe='/:')
        for state, name, height, row_count, expected in (
            ('fifty', 'decision-panel.png', 900, 50, ('3 / 50 kept',)),
            ('reviewed', 'decision-demo-tests.png', 520, 20,
             ('5 / 124 kept', 'actual: 6000')),
        ):
            panel = IMAGES / name
            result = subprocess.run([
                str(edge), '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
                '--force-device-scale-factor=1', '--virtual-time-budget=1500',
                f'--window-size=1200,{height}', f'--user-data-dir={windows_path(profile / state)}',
                '--dump-dom', f'--screenshot={windows_path(panel)}', panel_address + f'?{state}&capture',
            ], capture_output=True, text=True, timeout=30, check=False)
            if (result.returncode != 0 or not panel.is_file() or 'DECISION_LINE_PANEL_READY' not in result.stdout or
                    result.stdout.count('class="batch-row ') != row_count or
                    any(text not in result.stdout for text in expected)):
                raise RuntimeError(f'Could not capture the current Decision panel: {name}')
            bounds = re.search(r'data-capture-height="(\d+)"', result.stdout)
            if not bounds:
                raise RuntimeError(f'Could not inspect {name} content height')
            capture_height = int(bounds.group(1))
            with Image.open(panel) as captured:
                if not 0 < capture_height <= captured.height:
                    raise RuntimeError(f'{name} content exceeds the capture height')
                captured.crop((0, 0, captured.width, capture_height)).save(panel, optimize=True)
            panel.chmod(0o644)
            print(f'{panel.name}: {panel.stat().st_size} bytes')
    finally:
        remove_profile(profile, 'jev-docs-')


if __name__ == '__main__':
    main()
