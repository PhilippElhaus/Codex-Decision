param(
    [string]$Vsix,
    [string]$HostExtension,
    [string]$HostRollback,
    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$')][string]$Distro = 'Ubuntu',
    [string]$CodeExecutable = (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe')
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $Vsix) {
    $version = (Get-Content -LiteralPath (Join-Path $repository 'vscode-control\package.json') -Raw | ConvertFrom-Json).version
    $Vsix = Join-Path $repository ('.local\submission\codex-decision-' + $version + '.vsix')
}
if (-not $HostExtension) { $HostExtension = Join-Path $env:USERPROFILE '.vscode\extensions\openai.chatgpt-26.1007.21434-win32-x64' }
$Vsix = [IO.Path]::GetFullPath($Vsix)
$HostExtension = [IO.Path]::GetFullPath($HostExtension)
$hostVersion = (Get-Content -LiteralPath (Join-Path $HostExtension 'package.json') -Raw | ConvertFrom-Json).version
$supportedHosts = @('26.928.31416', '26.930.21537', '26.930.31730', '26.930.41038',
    '26.930.51102', '26.930.61225', '26.1002.51308', '26.1007.21434')
if ($hostVersion -notin $supportedHosts) { throw 'Native smoke requires a version-pinned supported Codex host.' }
if (-not $HostRollback) { $HostRollback = Join-Path $env:LOCALAPPDATA ('Codex\codex-decision\rollback\' + $hostVersion) }
$HostRollback = [IO.Path]::GetFullPath($HostRollback)
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetPathRoot($temporary) -ieq 'D:\') { throw 'Native test temporary root must be off D:.' }
foreach ($filename in @($Vsix, $CodeExecutable)) {
    if (-not (Test-Path -LiteralPath $filename -PathType Leaf)) { throw 'Native test package or VS Code executable is missing.' }
    if (((Get-Item -LiteralPath $filename).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked native test input.' }
}
if (-not (Test-Path -LiteralPath $HostExtension -PathType Container)) { throw 'Native test Codex host is missing.' }
if (((Get-Item -LiteralPath $HostExtension -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked Codex test host input.' }
if (Get-ChildItem -LiteralPath $HostExtension -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue) { throw 'Linked Codex test host input.' }
$runId = [Guid]::NewGuid().ToString('N')
$taskRoot = Join-Path $temporary ('decision-vscode-integrated-' + $runId)
$profile = Join-Path $taskRoot 'profile'
$extensions = Join-Path $taskRoot 'extensions'
$localState = Join-Path $taskRoot 'local-state'
$report = Join-Path $repository '.local\quality\windows-integrated-smoke.json'
$utf8 = [Text.UTF8Encoding]::new($false)
$linuxRoot = $null
$codeProcess = $null
$ownedProcessStopped = $true

function Replace-One([string]$Filename, [string]$Needle, [string]$Replacement) {
    $text = [IO.File]::ReadAllText($Filename)
    if (-not $text.Contains($Needle) -or $text.IndexOf($Needle) -ne $text.LastIndexOf($Needle)) {
        throw ('Native test instrumentation anchor changed: ' + [IO.Path]::GetFileName($Filename))
    }
    [IO.File]::WriteAllText($Filename, $text.Replace($Needle, $Replacement), $utf8)
}

function Assert-PlainPath([string]$Filename) {
    $current = [IO.Path]::GetFullPath($Filename)
    while ($current) {
        if (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Native fixture input contains a link or reparse point.'
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Linux-Path([string]$Filename) {
    $converted = (& wsl.exe -d $Distro -e wslpath -u $Filename).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $converted.StartsWith('/') -or $converted -match '[\r\n\x00]') {
        throw 'Native fixture path could not be converted for WSL.'
    }
    return $converted
}

try {
    New-Item -ItemType Directory -Path $taskRoot, (Join-Path $profile 'User'), $extensions, $localState -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $taskRoot 'owner.json'), (@{ runId = $runId; purpose = 'Codex Decision isolated integrated VSIX smoke' } | ConvertTo-Json), $utf8)
    New-Item -ItemType Directory -Path (Split-Path $report) -Force | Out-Null
    $linuxRoot = (& wsl.exe -d $Distro -e mktemp -d -p /tmp decision-vscode-integrated-XXXXXXXX).Trim()
    if ($LASTEXITCODE -ne 0 -or $linuxRoot -notmatch '^/tmp/decision-vscode-integrated-[A-Za-z0-9]{8}$') { throw 'Unexpected Linux native fixture root.' }
    & wsl.exe -d $Distro -e mkdir -m 700 -- ($linuxRoot + '/home') ($linuxRoot + '/codex')
    if ($LASTEXITCODE -ne 0) { throw 'Linux native fixture initialization failed.' }
    & wsl.exe -d $Distro -e python3 -c 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.argv[2])' ($linuxRoot + '/owner') $runId
    if ($LASTEXITCODE -ne 0) { throw 'Linux native fixture ownership record failed.' }
    $unpacked = Join-Path $taskRoot 'package'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Vsix, $unpacked)
    $control = Join-Path $unpacked 'extension'
    foreach ($filename in @('package.json', 'plugin\.codex-plugin\plugin.json', 'plugin\hooks\bin\linux-x86_64\decisionctl', 'patch-assets\host-bridge.jsfrag')) {
        if (-not (Test-Path -LiteralPath (Join-Path $control $filename) -PathType Leaf)) { throw 'VSIX does not contain the integrated package.' }
    }
    $hostCopy = Join-Path $extensions ([IO.Path]::GetFileName($HostExtension))
    # The Codex host has thousands of small assets. Bounded parallel copies avoid a long setup delay.
    & robocopy.exe $HostExtension $hostCopy /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /MT:16 /NP /NJH /NJS /NFL /NDL | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Native Codex host fixture copy failed.' }
    if ([IO.File]::ReadAllText((Join-Path $hostCopy 'out\extension.js')).Contains('codexDecision.bridge')) {
        # A deployed host can seed this test. Restore only its owned copy with an exact copied rollback.
        Assert-PlainPath $HostRollback
        if (Get-ChildItem -LiteralPath $HostRollback -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue) {
            throw 'Native host rollback contains a link or reparse point.'
        }
        $copiedRollback = Join-Path $localState ('Codex\codex-decision\rollback\' + $hostVersion)
        $sourceManifest = Join-Path $HostRollback 'manifest.json'
        $metadata = Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json
        if ($metadata.version -ne $hostVersion -or -not $metadata.original -or -not $metadata.patched) {
            throw 'Native host rollback metadata does not match the copied supported host.'
        }
        $liveHostHash = (Get-FileHash -LiteralPath (Join-Path $HostExtension 'out\extension.js') -Algorithm SHA256).Hash
        & robocopy.exe $HostRollback $copiedRollback /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /MT:4 /NP /NJH /NJS /NFL /NDL | Out-Null
        if ($LASTEXITCODE -ge 8) { throw 'Native host rollback fixture copy failed.' }
        foreach ($owned in @($hostCopy, $copiedRollback)) {
            if (-not [IO.Path]::GetFullPath($owned).StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Native restore targets must remain within this owned fixture.'
            }
            Assert-PlainPath $owned
        }
        $binary = Linux-Path (Join-Path $control 'plugin\hooks\bin\linux-x86_64\decisionctl')
        $source = Linux-Path $control
        $target = Linux-Path $hostCopy
        $rollback = Linux-Path $copiedRollback
        & wsl.exe -d $Distro -e $binary patch-webview restore --root $source --extension $target --backup $rollback | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Version-pinned restore of the copied native host failed.' }
        $originalFiles = @(Get-ChildItem -LiteralPath $copiedRollback -Recurse -File | Where-Object { $_.Name -ne 'manifest.json' })
        if ($originalFiles.Count -ne 4) { throw 'Native smoke requires all four exact original Codex rollback files.' }
        foreach ($file in $originalFiles) {
            $relative = [IO.Path]::GetRelativePath($copiedRollback, $file.FullName)
            if ((Get-FileHash -LiteralPath (Join-Path $hostCopy $relative) -Algorithm SHA256).Hash -ne
                (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) {
                throw 'Restored native fixture differs from its verified original rollback.'
            }
        }
        if ((Get-FileHash -LiteralPath (Join-Path $HostExtension 'out\extension.js') -Algorithm SHA256).Hash -ne $liveHostHash) {
            throw 'Live Codex host changed while preparing the isolated fixture.'
        }
    }
    if ([IO.File]::ReadAllText((Join-Path $hostCopy 'out\extension.js')).Contains('codexDecision.bridge')) { throw 'Native Codex host fixture was not restored to pristine bytes.' }
    foreach ($file in @('windows_integrated_smoke_runner.cjs', 'windows_integrated_smoke_wsl.cjs')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $taskRoot $file)
    }
    # Keep production files unchanged. These exact replacements affect only the disposable copy.
    foreach ($file in @('integrated-install.js', 'integration.js')) {
        Replace-One (Join-Path $control $file) 'const runFile = promisify(execFile);' 'const runFile = require(process.env.DECISION_INTEGRATED_TEST_WRAPPER).run;'
    }
    Replace-One (Join-Path $control 'install-plugin.py') 'root = safe_path(Path.home() / ".local/state/codex-decision")' 'root = safe_path(Path(os.environ["DECISION_TEST_HOME"]) / ".local/state/codex-decision")'
    Replace-One (Join-Path $control 'install-plugin.py') 'install(args.payload, args.codex, data_directory=args.data_directory)' 'install(args.payload, args.codex, home=Path(os.environ["DECISION_TEST_HOME"]), codex_home=Path(os.environ["CODEX_HOME"]), data_directory=args.data_directory)'
    Replace-One (Join-Path $control 'extension.js') '    ready: () => ensureIntegratedInstall(vscode, context, {' '    ready: () => globalThis.__decisionIntegratedInstallation = ensureIntegratedInstall(vscode, context, {'
    Replace-One (Join-Path $control 'extension.js') '  activateIntegration(vscode, context, {' '  globalThis.__decisionIntegratedIntegration = activateIntegration(vscode, context, {'
    Replace-One (Join-Path $control 'panel.js') 'this.extensionUri = extensionUri;' 'this.extensionUri = extensionUri; globalThis.__decisionIntegratedPanel = this;'
    $renderer = Join-Path $control 'webview\decision-panel.js'
    $text = [IO.File]::ReadAllText($renderer)
    $needle = '    showSelectedView();'
    if (-not $text.Contains($needle)) { throw 'Native panel acknowledgement anchor changed.' }
    $ack = ' vscode.postMessage({type:"decision-integrated-rendered", id:event.data.decision?.id || null, rows:document.querySelectorAll(".batch-row").length, title:document.querySelector(".batch-title")?.textContent, activity:(document.querySelector(".activity-counts")?.textContent || "") + " " + (document.querySelector(".empty")?.textContent || ""), layout:document.querySelector(".batch-list") ? getComputedStyle(document.querySelector(".batch-list")).display : null});'
    $text = $text.Insert($text.LastIndexOf($needle) + $needle.Length, $ack)
    $text = $text.Replace('if (emptyStatus && event.data.activity?.message) emptyStatus.textContent = event.data.activity.message;', 'if (emptyStatus && event.data.activity?.message) emptyStatus.textContent = event.data.activity.message;' + $ack)
    [IO.File]::WriteAllText($renderer, $text, $utf8)
    [IO.File]::WriteAllText((Join-Path $profile 'User\settings.json'), (@{
        'telemetry.telemetryLevel' = 'off'; 'update.mode' = 'none'; 'extensions.autoUpdate' = $false;
        'workbench.startupEditor' = 'none'; 'workbench.enableExperiments' = $false;
        'chatgpt.openOnStartup' = $false; 'chatgpt.runCodexInWindowsSubsystemForLinux' = $true
    } | ConvertTo-Json), $utf8)
    $results = @()
    foreach ($phase in @('first', 'second')) {
        $phaseReport = Join-Path $taskRoot ($phase + '.json')
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $CodeExecutable
        $start.UseShellExecute = $false
        $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Minimized
        foreach ($argument in @('--new-window', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
            '--user-data-dir', $profile, '--extensions-dir', $extensions,
            '--extensionDevelopmentPath', $control, '--extensionTestsPath', (Join-Path $taskRoot 'windows_integrated_smoke_runner.cjs'))) {
            $start.ArgumentList.Add($argument)
        }
        foreach ($name in @('ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'JEV_API_KEY', 'CODEX_DECISION_DATA_DIRECTORY')) {
            $start.Environment.Remove($name) | Out-Null
        }
        $start.Environment['LOCALAPPDATA'] = $localState
        $start.Environment['CODEX_HOME'] = $linuxRoot + '/codex'
        $start.Environment['WSLENV'] = (($env:WSLENV -split ':' | Where-Object { $_ -and $_ -notmatch '^CODEX_HOME(?:/|$)' }) + @('CODEX_HOME')) -join ':'
        $start.Environment['DECISION_INTEGRATED_TEST_CONTROL'] = $control
        $start.Environment['DECISION_INTEGRATED_TEST_LINUX'] = $linuxRoot
        $start.Environment['DECISION_INTEGRATED_TEST_DISTRO'] = $Distro
        $start.Environment['DECISION_INTEGRATED_TEST_WRAPPER'] = Join-Path $taskRoot 'windows_integrated_smoke_wsl.cjs'
        $start.Environment['DECISION_INTEGRATED_TEST_REPORT'] = $phaseReport
        $start.Environment['DECISION_INTEGRATED_TEST_RUN'] = $runId
        $start.Environment['DECISION_INTEGRATED_TEST_PHASE'] = $phase
        $codeProcess = [Diagnostics.Process]::Start($start)
        $ownedProcessStopped = $false
        if (-not $codeProcess.WaitForExit(240000)) { throw 'Native integrated smoke timed out; keep fixtures until owned VS Code process is stopped.' }
        $ownedProcessStopped = $true
        if (-not (Test-Path -LiteralPath $phaseReport -PathType Leaf)) { throw 'Native integrated smoke produced no phase report.' }
        $result = Get-Content -LiteralPath $phaseReport -Raw | ConvertFrom-Json
        $results += $result
        [IO.File]::WriteAllText($report, (@{ ok = ($codeProcess.ExitCode -eq 0 -and $result.ok); runId = $runId;
            packageSha256 = (Get-FileHash -LiteralPath $Vsix -Algorithm SHA256).Hash.ToLower(); phases = @($results) } | ConvertTo-Json -Depth 8), $utf8)
        if ($result.runId -ne $runId -or $codeProcess.ExitCode -ne 0 -or -not $result.ok) { throw ('Native integrated smoke failed: ' + $result.error) }
    }
    Get-Content -LiteralPath $report -Raw
} finally {
    if (-not $ownedProcessStopped -and $codeProcess) {
        # taskkill targets only the exact process started above and its descendant tree.
        if (-not $codeProcess.HasExited) {
            & taskkill.exe /PID $codeProcess.Id /T /F | Out-Null
            $ownedProcessStopped = $codeProcess.WaitForExit(10000)
        } else { $ownedProcessStopped = $true }
    }
    if ($ownedProcessStopped) {
        if ($linuxRoot -match '^/tmp/decision-vscode-integrated-[A-Za-z0-9]{8}$') {
            $cleanup = 'import os,pathlib,shutil,stat,sys; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path("/tmp") and p.resolve()==p and p.stat().st_uid==os.geteuid(); assert (p/"owner").read_text()==sys.argv[2]; assert all(not stat.S_ISLNK(os.lstat(x).st_mode) for x in p.rglob("*")); shutil.rmtree(p)'
            & wsl.exe -d $Distro -e python3 -c $cleanup $linuxRoot $runId
            if ($LASTEXITCODE -ne 0) { throw 'Linux native fixture cleanup failed; preserve its exact path.' }
        }
        if ((Test-Path -LiteralPath $taskRoot -PathType Container) -and
            [IO.Path]::GetFullPath($taskRoot).StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase)) {
            $allowed = @('owner.json', 'profile', 'extensions', 'local-state', 'package', 'windows_integrated_smoke_runner.cjs', 'windows_integrated_smoke_wsl.cjs', 'first.json', 'second.json')
            $owner = Get-Content -LiteralPath (Join-Path $taskRoot 'owner.json') -Raw | ConvertFrom-Json
            if ($owner.runId -ne $runId -or (Get-ChildItem -LiteralPath $taskRoot -Force | Where-Object { $_.Name -notin $allowed })) { throw 'Native fixture has unknown ownership or content.' }
            if (((Get-Item -LiteralPath $taskRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                (Get-ChildItem -LiteralPath $taskRoot -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)) { throw 'Native fixture contains a link; preserve it.' }
            Remove-Item -LiteralPath $taskRoot -Recurse -Force
        }
    }
}
