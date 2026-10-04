"""Run the real composer script in headless Edge with a mock VS Code bridge."""

from pathlib import Path
import argparse
import json
import re
import subprocess
import tempfile
from urllib.parse import quote

from windows_browser import browser_environment, remove_profile, windows_path

ROOT = Path(__file__).resolve().parents[1]


def chromium_smoke() -> None:
    from playwright.sync_api import sync_playwright

    reports = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, motion in ((360, 'reduce'), (720, 'no-preference'),
                                  (1200, 'reduce'), (2800, 'no-preference')):
                page = browser.new_page(viewport={'width': width, 'height': 600}, reduced_motion=motion)
                page.goto((ROOT.parent / 'tests/browser/browser_harness.html').as_uri())
                page.wait_for_function('document.getElementById("results").textContent.startsWith("{")', timeout=45000)
                outcome = json.loads(page.locator('#results').inner_text())
                if not outcome.get('ok'):
                    raise AssertionError({'viewport': width, **outcome})
                reports.append({'requested_width': width, 'motion': motion, **outcome})
                page.close()
            for width in (360, 1200):
                for sample in ('fifty', 'legacy'):
                    page = browser.new_page(viewport={'width': width, 'height': 600})
                    page.goto((ROOT.parent / 'tests/browser/jev_panel_harness.html').as_uri() + '?' + sample)
                    page.wait_for_function('document.title === "JEV_LINE_PANEL_READY"')
                    report = json.loads(page.locator('body').get_attribute('data-report'))
                    for field in ('newBatchShown', 'minimalHeader', 'sameDecisionDidNotRestart',
                                  'positionsStable', 'parallelGrowth', 'fadeAfterGrowth', 'noNestedScroll',
                                  'tenCharacterBars', 'fixedTrackWidths', 'compactRows', 'singleLineRows', 'keepReasonAvailable'):
                        assert report[field], {'viewport': width, 'sample': sample, **report}
                    assert not report['horizontalOverflow'], report
                    reports.append({'panel': sample, 'requested_width': width, **report})
                    page.close()
            page = browser.new_page()
            page.goto((ROOT.parent / 'tests/browser/jev_panel_empty_harness.html').as_uri())
            page.wait_for_function('document.title === "JEV_EMPTY_READY"')
            assert json.loads(page.locator('body').get_attribute('data-result'))['activity']
            page.close()
            for width in (360, 1200):
                page = browser.new_page(viewport={'width': width, 'height': 600})
                page.goto((ROOT.parent / 'tests/browser/jev_panel_protected_harness.html').as_uri())
                page.wait_for_function('document.title === "JEV_PROTECTED_READY"')
                report = json.loads(page.locator('body').get_attribute('data-result'))
                assert all(report.values()), report
                reports.append({'protected_panel': True, 'requested_width': width, **report})
                page.close()
        finally:
            browser.close()
    print(json.dumps(reports))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', choices=['edge', 'chromium'], default='edge')
    if parser.parse_args().browser == 'chromium':
        chromium_smoke()
        return
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
                '--virtual-time-budget=30000', f'--window-size={width},600',
                f'--user-data-dir={windows_path(profile / f"viewport-{width}")}',
                '--dump-dom', address,
            ], capture_output=True, text=True, timeout=30, check=False)
            match = re.search(r'<pre class="results" id="results">([^<]+)</pre>', result.stdout)
            if result.returncode != 0 or not match:
                raise RuntimeError(f'Edge browser harness failed at {width}px: exit={result.returncode}, result missing')
            outcome = json.loads(match.group(1).replace('&quot;', '"'))
            if not outcome.get('ok'):
                raise AssertionError({'viewport': width, **outcome})
            reports.append({'requested_width': width, 'motion': motion, **outcome})
        panel_target = windows_path(ROOT.parent / 'tests/browser/jev_panel_harness.html').replace('\\', '/')
        panel_address = 'file:///' + quote(panel_target, safe='/:')
        for width in (360, 1200):
            for sample in ('fifty', 'legacy'):
                result = subprocess.run([
                    str(edge), '--headless', '--disable-gpu', '--no-first-run',
                    '--no-default-browser-check', '--disable-extensions',
                    '--virtual-time-budget=2600', f'--window-size={width},600',
                    f'--user-data-dir={windows_path(profile / f"panel-{sample}-{width}")}',
                    '--dump-dom', panel_address + '?' + sample,
                ], capture_output=True, text=True, timeout=30, check=False)
                match = re.search(r'data-report="([^"]+)"', result.stdout)
                if result.returncode != 0 or not match:
                    raise RuntimeError(f'Panel harness failed: {sample} {width}px')
                report = json.loads(match.group(1).replace('&quot;', '"'))
                for field in ('newBatchShown', 'minimalHeader', 'sameDecisionDidNotRestart',
                              'positionsStable', 'parallelGrowth', 'fadeAfterGrowth', 'noNestedScroll',
                              'tenCharacterBars', 'fixedTrackWidths', 'compactRows', 'singleLineRows', 'keepReasonAvailable'):
                    assert report[field], {'viewport': width, 'sample': sample, **report}
                assert not report['horizontalOverflow'], report
                reports.append({'panel': sample, 'requested_width': width, **report})
        empty = windows_path(ROOT.parent / 'tests/browser/jev_panel_empty_harness.html').replace('\\', '/')
        empty_address = 'file:///' + quote(empty, safe='/:')
        result = subprocess.run([
            str(edge), '--headless', '--disable-gpu', '--no-first-run',
            '--no-default-browser-check', '--disable-extensions',
            f'--user-data-dir={windows_path(profile / "empty-panel")}',
            '--dump-dom', empty_address,
        ], capture_output=True, text=True, timeout=30, check=False)
        if result.returncode != 0 or '<title>JEV_EMPTY_READY</title>' not in result.stdout:
            raise RuntimeError('Jev empty panel activity check failed')
        protected = windows_path(ROOT.parent / 'tests/browser/jev_panel_protected_harness.html').replace('\\', '/')
        protected_address = 'file:///' + quote(protected, safe='/:')
        for width in (360, 1200):
            result = subprocess.run([
                str(edge), '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions', f'--window-size={width},600',
                f'--user-data-dir={windows_path(profile / f"protected-{width}")}',
                '--dump-dom', protected_address,
            ], capture_output=True, text=True, timeout=30, check=False)
            if result.returncode != 0 or '<title>JEV_PROTECTED_READY</title>' not in result.stdout:
                raise RuntimeError(f'Jev protected panel check failed at {width}px')
        print(json.dumps(reports))
    finally:
        remove_profile(profile, 'jev-edge-test-')


if __name__ == '__main__':
    main()
