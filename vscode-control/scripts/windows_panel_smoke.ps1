param(
    [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Distro = 'Ubuntu',
    [string]$CodeExecutable = (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe')
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetPathRoot($temporary) -ieq 'D:\') { throw 'Test temporary root must be off D:.' }
if (-not (Test-Path -LiteralPath $CodeExecutable -PathType Leaf)) { throw 'VS Code executable was not found.' }
$runId = [Guid]::NewGuid().ToString('N')
$taskRoot = Join-Path $temporary ('decision-vscode-panel-' + $runId)
$control = Join-Path $taskRoot 'control'
$profile = Join-Path $taskRoot 'profile'
$report = Join-Path $repository '.local\quality\windows-panel-smoke.json'
$utf8 = [Text.UTF8Encoding]::new($false)
$linuxRoot = $null
$codeProcess = $null
$ownedProcessStopped = $true
$savedEnvironment = @{}
foreach ($name in @('ELECTRON_RUN_AS_NODE', 'DECISION_PANEL_TEST_CONTROL', 'DECISION_PANEL_TEST_DATA', 'DECISION_PANEL_TEST_REPORT', 'DECISION_PANEL_TEST_RUN')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    New-Item -ItemType Directory -Path $control, (Join-Path $profile 'User'), (Join-Path $taskRoot 'extensions') -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path $report) -Force | Out-Null
    $linuxRoot = (& wsl.exe -d $Distro -e mktemp -d -p /tmp decision-vscode-panel-XXXXXXXX).Trim()
    if ($LASTEXITCODE -ne 0 -or $linuxRoot -notmatch '^/tmp/decision-vscode-panel-[A-Za-z0-9]{8}$') { throw 'Unexpected Linux fixture root.' }
    $data = '\\wsl.localhost\' + $Distro + $linuxRoot.Replace('/', '\')
    $files = @('package.json', 'config-contract.json', 'core.js', 'extension.js', 'panel.js', 'panel-state.js',
        'private-paths.js', 'schema.js', 'providers.js', 'icon.png', 'LICENSE', 'README.md', 'media\decision-panel.svg',
        'webview\decision-control.js', 'webview\decision-settings.js', 'webview\decision-panel.js', 'webview\decision-panel.css')
    foreach ($file in $files) {
        $source = Join-Path $repository ('vscode-control\' + $file)
        if (((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked test source.' }
        $target = Join-Path $control $file
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }
    # Instrument only the disposable copy. Packaged application code is unchanged.
    $providerPath = Join-Path $control 'panel.js'
    $source = [IO.File]::ReadAllText($providerPath)
    $needle = 'this.extensionUri = extensionUri;'
    if ($source.IndexOf($needle) -ne $source.LastIndexOf($needle) -or -not $source.Contains($needle)) { throw 'Provider instrumentation anchor changed.' }
    [IO.File]::WriteAllText($providerPath, $source.Replace($needle, $needle + ' globalThis.__decisionPanelTestProvider = this;'), $utf8)
    $rendererPath = Join-Path $control 'webview\decision-panel.js'
    $source = [IO.File]::ReadAllText($rendererPath)
    $needle = 'updateActivity(event.data.activity ?? currentActivity);'
    if ($source.IndexOf($needle) -ne $source.LastIndexOf($needle) -or -not $source.Contains($needle)) { throw 'Renderer instrumentation anchor changed.' }
    $ack = ' vscode.postMessage({type:"decision-test-rendered", id:event.data.decision?.id || null, rows:document.querySelectorAll(".batch-row").length, kept:document.querySelectorAll(".batch-row.keep").length, unscored:[...document.querySelectorAll(".batch-row.unscored")].map(row => ({score:row.querySelector(".batch-value").textContent, title:row.title})), title:document.querySelector(".batch-title")?.textContent || "Decision", status:document.querySelector(".batch-status")?.textContent || null, activity:(document.querySelector(".activity-counts")?.textContent || "") + " " + (document.querySelector(".empty")?.textContent || ""), layout:document.querySelector(".batch-list") ? getComputedStyle(document.querySelector(".batch-list")).display : null, tenCharacterBars:[...document.querySelectorAll(".batch-bar-fill,.batch-bar-empty")].every(node => [...node.textContent].length === 10), compactRows:[...document.querySelectorAll(".batch-row")].every(node => node.getBoundingClientRect().height <= 28)});'
    [IO.File]::WriteAllText($rendererPath, $source.Replace($needle, $needle + $ack).Replace("updateActivity(event.data.activity);", "updateActivity(event.data.activity);" + $ack), $utf8)
    [IO.File]::WriteAllText((Join-Path $profile 'User\settings.json'), (@{
        'telemetry.telemetryLevel' = 'off'; 'update.mode' = 'none'; 'extensions.autoUpdate' = $false;
        'workbench.startupEditor' = 'none'; 'workbench.enableExperiments' = $false;
        'codexDecision.dataDirectory' = $data
    } | ConvertTo-Json), $utf8)
    $runner = @'
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const core = require(path.join(process.env.DECISION_PANEL_TEST_CONTROL, "core.js"));
async function until(predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Native panel did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
exports.run = async () => {
  const result = {ok:false, runId:process.env.DECISION_PANEL_TEST_RUN, checks:[]};
  let subscription;
  try {
    const make = (id) => ({version:4, id, receipt_id:"b".repeat(32), at:"2020-01-01T00:00:00Z",
      filter:"output", status:"keep", batch:{number:1,count:1,target_count:2}, batch_elapsed_ms:20,
      rows:[{line:1,excerpt:"Synthetic routine line",action:"omit",reason:"irrelevant",task_relevant:.01},
        {line:2,excerpt:"Synthetic required diagnostic",action:"keep",reason:"task_relevant",task_relevant:.99}],
      totals:{seen:2,judged:2,kept:1,omitted:1,protected:0,unjudged:0,requests:2}});
    const root = process.env.DECISION_PANEL_TEST_DATA;
    const one = core.sessionDirectory(root, "native-one");
    const two = core.sessionDirectory(root, "native-two");
    const firstId = "a".repeat(32), secondId = "c".repeat(32);
    for (const [directory, id] of [[one, firstId], [two, secondId]]) {
      await core.ensureSessionDefaults(directory);
      await fs.mkdir(path.join(directory,"logs"));
      await fs.writeFile(path.join(directory,"logs/latest-decision.json"), JSON.stringify(make(id)));
    }
    await vscode.extensions.getExtension("elhaus-labs.codex-decision-control").activate();
    await vscode.commands.executeCommand("codexDecision.bridge", {action:"status",viewId:"native-view",sessionId:"native-one",focused:false});
    await vscode.commands.executeCommand("codexDecision.showLatestDecision");
    await until(() => globalThis.__decisionPanelTestProvider?.view && !globalThis.__decisionPanelTestProvider.awaitingReady);
    const provider = globalThis.__decisionPanelTestProvider;
    await provider.pending;
    let acknowledged;
    subscription = provider.view.webview.onDidReceiveMessage(message => {
      if(message?.type === "decision-test-rendered") acknowledged = message;
    });
    const check = async (id, label) => {
      await provider.pending;
      acknowledged = null;
      provider.lastMessage = "";
      provider.nextDecisionAt = 0;
      await provider.refresh();
      await until(() => acknowledged?.id === id);
      assert.equal(acknowledged.rows, 2);
      assert.match(acknowledged.activity, /0 API requests · 0 skipped outputs/);
      assert.equal(acknowledged.title, "0 / 2 removed");
      assert.equal(acknowledged.layout, "grid", "the panel stylesheet must load under the CSP");
      assert.equal(acknowledged.tenCharacterBars, true);
      assert.equal(acknowledged.compactRows, true);
      result.checks.push(label);
    };
    await check(firstId, "actual renderer loads under the webview CSP and restores an old saved decision without composer focus");
    const countTime = Date.now();
    await fs.writeFile(path.join(one,"logs/hook-health.json"),JSON.stringify({version:1,
      hook_version:"0.11.2",last_seen_ms:countTime,api_requests:9,skipped:341}));
    acknowledged = null;
    await provider.refresh();
    await until(() => acknowledged?.activity?.includes("9 API requests"));
    assert.match(acknowledged.activity, /341 skipped outputs/);
    assert.equal(acknowledged.rows,2);
    result.checks.push("live counters update while saved result rows remain visible");
    await fs.rm(path.join(one,"logs/hook-health.json"));
    for (let index = 0; index < 3; index++) {
      const generation = provider.generation;
      provider.view.webview.html = provider.view.webview.html + `<!-- native reload ${index} -->`;
      await until(() => provider.generation > generation && !provider.awaitingReady);
      await check(firstId, `panel reload ${index + 1}`);
    }
    await vscode.commands.executeCommand("workbench.action.togglePanel");
    await until(() => !provider.view.visible);
    await vscode.commands.executeCommand("codexDecision.showLatestDecision");
    await until(() => provider.view.visible);
    await check(firstId, "hide and reopen restores the renderer");
    await vscode.commands.executeCommand("codexDecision.bridge", {action:"status",viewId:"native-view",sessionId:"native-two",focused:true});
    await check(secondId, "session switch renders the new saved decision");
    const protectedId = "d".repeat(32);
    await fs.writeFile(path.join(two,"logs/latest-decision.json"), JSON.stringify({
      ...make(protectedId), version:6, status:"candidate", batch:{number:1,count:1,target_count:69},
      rows:Array.from({length:72}, (_,index) => ({line:index+1,excerpt:`Synthetic line ${index+1}`,
        action:index < 69 ? "omit" : "keep",reason:index < 69 ? "irrelevant" : "protected",
        task_relevant:index < 69 ? .03 : null,protected_reason:index < 69 ? null : "diagnostic_context"})),
      totals:{seen:72,judged:69,kept:3,omitted:69,protected:3,unjudged:0,requests:1,classification_requests:0}}));
    acknowledged = null;
    provider.nextDecisionAt = 0;
    await provider.refresh();
    await until(() => acknowledged?.id === protectedId);
    assert.equal(acknowledged.rows, 72);
    assert.equal(acknowledged.kept, 3);
    assert.equal(acknowledged.title, "69 / 72 proposed removals");
    assert.equal(acknowledged.unscored.length, 3);
    assert(acknowledged.unscored.every(row => row.score === "—" && row.title.includes("no Decision relevance score")));
    assert.equal(acknowledged.status, "Preview · full output kept");
    result.checks.push("version-6 requests, all 72 rows, protected keeps, and preview status render under the real webview CSP");
    const empty = core.sessionDirectory(root, "native-empty");
    await core.ensureSessionDefaults(empty);
    await fs.mkdir(path.join(empty,"logs"));
    const seen = Date.now();
    await fs.writeFile(path.join(empty,"logs/hook-health.json"), JSON.stringify({
      version:1,hook_version:"0.10.6",last_seen_ms:seen,last_skip_ms:seen,
      last_skip:"choice_kept_full_output",skipped:341}));
    await fs.writeFile(path.join(empty,"stats.json"), JSON.stringify({calls:11,completed:0,replaced:0,timed:11,elapsedMs:4000}));
    await vscode.commands.executeCommand("codexDecision.bridge", {action:"status",viewId:"native-view",sessionId:"native-empty",focused:true});
    await provider.pending;
    acknowledged = null;
    provider.lastMessage = "";
    await provider.refresh();
    await until(() => acknowledged?.activity?.includes("11 API requests"));
    assert.equal(acknowledged.rows, 0);
    assert.match(acknowledged.activity, /341 skipped outputs/);
    assert.match(acknowledged.activity, /No line judgments were needed/);
    result.checks.push("empty panel explains classification requests and skipped outputs under the real webview CSP");
    result.ok = true;
  } catch(error) {
    result.error = error.message;
    throw error;
  } finally {
    subscription?.dispose();
    await fs.writeFile(process.env.DECISION_PANEL_TEST_REPORT, JSON.stringify(result,null,2)+"\n");
  }
};
'@
    [IO.File]::WriteAllText((Join-Path $taskRoot 'runner.cjs'), $runner, $utf8)
    $env:ELECTRON_RUN_AS_NODE = $null
    $env:DECISION_PANEL_TEST_CONTROL = $control
    $env:DECISION_PANEL_TEST_DATA = $data
    $env:DECISION_PANEL_TEST_REPORT = $report
    $env:DECISION_PANEL_TEST_RUN = $runId
    Write-Output "Native panel test root: $taskRoot"
    Write-Output "Linux panel test root: $linuxRoot"
    $arguments = @('--new-window', '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
        "--user-data-dir=`"$profile`"", "--extensions-dir=`"$(Join-Path $taskRoot 'extensions')`"",
        "--extensionDevelopmentPath=`"$control`"", "--extensionTestsPath=`"$(Join-Path $taskRoot 'runner.cjs')`"")
    $codeProcess = Start-Process -FilePath $CodeExecutable -ArgumentList $arguments -PassThru -WindowStyle Minimized
    $ownedProcessStopped = $false
    if (-not $codeProcess.WaitForExit(180000)) { throw 'Native VS Code test timed out; preserve its fixture until the owned process is stopped.' }
    $ownedProcessStopped = $true
    if (-not (Test-Path -LiteralPath $report -PathType Leaf)) { throw 'Native VS Code produced no panel report.' }
    $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    if ($result.runId -ne $runId) { throw 'Native VS Code produced no report for this run.' }
    if ($codeProcess.ExitCode -ne 0 -or -not $result.ok) { throw "Native panel check failed: $($result.error)" }
    Get-Content -LiteralPath $report -Raw
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    if ($ownedProcessStopped) {
        if ($linuxRoot -match '^/tmp/decision-vscode-panel-[A-Za-z0-9]{8}$') {
            $cleanup = "import os,pathlib,shutil,stat,sys; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path('/tmp') and p.name.startswith('decision-vscode-panel-'); assert p.resolve()==p and p.stat().st_uid==os.geteuid(); assert all(not stat.S_ISLNK(os.lstat(x).st_mode) for x in p.rglob('*')); shutil.rmtree(p)"
            & wsl.exe -d $Distro -e python3 -c $cleanup $linuxRoot
            if ($LASTEXITCODE -ne 0) { throw 'Linux fixture cleanup failed.' }
        }
        if ([IO.Path]::GetFullPath($taskRoot).StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath $taskRoot -PathType Container)) {
            $item = Get-Item -LiteralPath $taskRoot -Force
            $allowed = @('control', 'profile', 'extensions', 'runner.cjs')
            if (Get-ChildItem -LiteralPath $taskRoot -Force | Where-Object { $_.Name -notin $allowed }) {
                throw 'Native fixture contains unknown content; preserve it for inspection.'
            }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                (Get-ChildItem -LiteralPath $taskRoot -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)) {
                throw 'Native fixture contains a link; preserve it for inspection.'
            }
            Remove-Item -LiteralPath $taskRoot -Recurse -Force
        }
    }
}
