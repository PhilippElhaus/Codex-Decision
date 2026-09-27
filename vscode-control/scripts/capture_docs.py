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
        ]
        for state, name, width, height in captures:
            output = IMAGES / name
            result = subprocess.run([
                str(edge), '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions',
                '--hide-scrollbars', '--force-device-scale-factor=1',
                '--virtual-time-budget=950', f'--window-size={width},{height}',
                f'--user-data-dir={windows_path(profile / state)}',
                '--dump-dom', f'--screenshot={windows_path(output)}', address + '?demo=' + state,
            ], capture_output=True, text=True, timeout=30, check=False)
            if result.returncode != 0 or not output.is_file() or output.stat().st_size < 1000:
                raise RuntimeError(f'Could not capture {name}: exit={result.returncode}')
            found = re.search(r'data-layout="([^"]+)"', result.stdout)
            if not found:
                raise RuntimeError(f'Could not inspect {name} layout')
            layout = json.loads(unescape(found.group(1)))
            if abs((layout['buttonTop'] - layout['anchorTop']) - layout['screenshotOffset']) > 10:
                raise RuntimeError(f'{name} is vertically misaligned: {layout}')
            print(f'{name}: {output.stat().st_size} bytes; layout={layout}')

        source = (ROOT / 'extension.js').read_text(encoding='utf-8')
        marker = 'const html = `'
        start = source.index(marker, source.index('async function openSettings()')) + len(marker)
        end = source.index('`;\n    panel.webview.onDidReceiveMessage', start)
        settings = source[start:end]
        settings = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]+>', '', settings, count=1)
        settings = settings.replace('${script}',
            'file:///' + quote(windows_path(ROOT / 'webview/settings.js').replace('\\', '/'), safe='/:'))
        config = json.loads((ROOT.parent / 'config.example.json').read_text(encoding='utf-8'))
        fixture = {'mode': config['mode'], 'thresholds': config['thresholds']}
        bridge = ('<script>window.acquireVsCodeApi = () => ({postMessage(message) {'
                  'if (message.action === "ready") setTimeout(() => window.dispatchEvent('
                  'new MessageEvent("message", {data: {action: "ready", config: '
                  + json.dumps(fixture) + ', hasKey: true}})), 0);'
                  '}});</script>')
        theme = ('<style>:root{--vscode-font-family:"Segoe UI",sans-serif;'
                 '--vscode-foreground:#c8c8c8;--vscode-editor-background:#111111;'
                 '--vscode-descriptionForeground:#939393;--vscode-panel-border:#333;'
                 '--vscode-input-background:#181818;--vscode-input-foreground:#c8c8c8;'
                 '--vscode-input-border:#3b3b3b;--vscode-button-background:#0e639c;'
                 '--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#252525;'
                 '--vscode-button-secondaryForeground:#ccc}body{zoom:1.25}</style>')
        settings = settings.replace('</head>', bridge + theme + '</head>')
        page = profile / 'settings.html'
        page.write_text(settings, encoding='utf-8')
        output = IMAGES / 'jev-settings.png'
        result = subprocess.run([
            str(edge), '--headless', '--disable-gpu', '--no-first-run',
            '--no-default-browser-check', '--disable-extensions',
            '--hide-scrollbars', '--force-device-scale-factor=1',
            '--virtual-time-budget=950', '--window-size=1040,800',
            f'--user-data-dir={windows_path(profile / "settings")}',
            '--dump-dom', f'--screenshot={windows_path(output)}',
            'file:///' + quote(windows_path(page).replace('\\', '/'), safe='/:'),
        ], capture_output=True, text=True, timeout=30, check=False)
        if (result.returncode != 0 or not output.is_file() or output.stat().st_size < 1000
                or 'An API key is saved.' not in result.stdout
                or 'Output filter' not in result.stdout):
            raise RuntimeError(f'Could not capture Jev settings: exit={result.returncode}')
        print(f'jev-settings.png: {output.stat().st_size} bytes; example values')
    finally:
        remove_profile(profile, 'jev-docs-')


if __name__ == '__main__':
    main()
