param(
    [string]$Vsix,
    [string]$HostExtension = (Join-Path $env:USERPROFILE '.vscode\extensions\openai.chatgpt-26.1021.22027-win32-x64'),
    [string]$HostRollback,
    [string]$NodeExecutable
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $Vsix) {
    $version = (Get-Content -LiteralPath (Join-Path $repository 'vscode-control\package.json') -Raw | ConvertFrom-Json).version
    $Vsix = Join-Path $repository ('.local\submission\codex-decision-' + $version + '.vsix')
}
$Vsix = [IO.Path]::GetFullPath($Vsix)
$HostExtension = [IO.Path]::GetFullPath($HostExtension)
$report = Join-Path $repository '.local\quality\windows-background-smoke.json'
$runId = [Guid]::NewGuid().ToString('N')
$taskRoot = $null
$process = $null
$stopped = $true
$originalTemp = $env:TEMP
$originalTmp = $env:TMP
$utf8 = [Text.UTF8Encoding]::new($false)
function Assert-PlainPath([string]$Filename) {
    $current = [IO.Path]::GetFullPath($Filename)
    while ($current) {
        if (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked smoke input or temporary path.' }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}
try {
    if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    # Rust cannot canonicalize this workstation's R: RAM drive. Change only this
    # process's temporary environment, then resolve the Windows temporary API.
    $nativeTemp = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
    if (-not (Test-Path -LiteralPath $nativeTemp -PathType Container)) { throw 'Native user-local temporary directory is missing.' }
    Assert-PlainPath $nativeTemp
    $env:TEMP = $nativeTemp
    $env:TMP = $nativeTemp
    $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetPathRoot($temporary) -ieq 'D:\') { throw 'Background smoke temporary root must remain off D:.' }
    foreach ($filename in @($Vsix, $NodeExecutable, (Join-Path $HostExtension 'package.json'))) {
        Assert-PlainPath $filename
        if (-not (Test-Path -LiteralPath $filename -PathType Leaf)) { throw 'Background smoke input is missing.' }
    }
    $hostVersion = (Get-Content -LiteralPath (Join-Path $HostExtension 'package.json') -Raw | ConvertFrom-Json).version
    if ($hostVersion -ne '26.1021.22027') { throw 'Background smoke requires the reviewed Codex 26.1021.22027 host.' }
    if (-not $HostRollback) { $HostRollback = Join-Path $env:LOCALAPPDATA ('Codex\codex-decision\rollback\' + $hostVersion) }
    $taskRoot = Join-Path $temporary ('decision-background-' + $runId)
    New-Item -ItemType Directory -Path $taskRoot -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $taskRoot 'owner.json'), (@{ runId = $runId; purpose = 'Codex Decision background package smoke' } | ConvertTo-Json), $utf8)
    $fixtureHome = Join-Path $taskRoot 'home'
    $codexHome = Join-Path $taskRoot 'codex'
    $localState = Join-Path $taskRoot 'local-state'
    $hostCopy = Join-Path $taskRoot 'host'
    New-Item -ItemType Directory -Path $fixtureHome, $codexHome, $localState, $hostCopy -Force | Out-Null
    $originalHashes = @{
        'out\extension.js' = 'a9cc6736cd2c2d22f6cf43fc5763d5f8a873e4f741f522b44a600b1926f4e627';
        'webview\index.html' = 'd542fed64423f56c08a20554c842f7bc247642a718d7a8d797ee66de6959e9b1';
        'webview\assets\use-plugins-74ac3ed173d4.js' = '117ca73a5317c5707f4038f535312f98a2a65a30668cff886f5a740167b6796c';
        'webview\assets\chunk-KS7C4IRE-c36c021bd659.js' = '10eb7db01b2e65ba9f977a219dfee663fb9ac23fd3dde7c127d0269202ea10e9'
    }
    foreach ($relative in $originalHashes.Keys) {
        $source = Join-Path $HostExtension $relative
        Assert-PlainPath $source
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $originalHashes[$relative]) {
            $source = Join-Path $HostRollback $relative
            Assert-PlainPath $source
            if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $originalHashes[$relative]) { throw 'Pinned host and rollback original hashes do not match.' }
        }
        $target = Join-Path $hostCopy $relative
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }
    Copy-Item -LiteralPath (Join-Path $HostExtension 'package.json') -Destination (Join-Path $hostCopy 'package.json')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Vsix, (Join-Path $taskRoot 'package'))
    $control = Join-Path $taskRoot 'package\extension'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $NodeExecutable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @((Join-Path $PSScriptRoot 'windows_background_smoke.cjs'), $taskRoot, $control, $hostCopy,
        (Join-Path $HostExtension 'bin\windows-x86_64\codex.exe'), $report)) { $start.ArgumentList.Add($argument) }
    foreach ($name in @('ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'JEV_API_KEY', 'CODEX_DECISION_DATA_DIRECTORY', 'WSLENV')) { $start.Environment.Remove($name) | Out-Null }
    $start.Environment['USERPROFILE'] = $fixtureHome
    $start.Environment['LOCALAPPDATA'] = $localState
    $start.Environment['CODEX_HOME'] = $codexHome
    $start.Environment['DECISION_BACKGROUND_PACKAGE_SHA256'] = (Get-FileHash -LiteralPath $Vsix -Algorithm SHA256).Hash.ToLower()
    $start.Environment['DECISION_BACKGROUND_RUN_ID'] = $runId
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($report)) -Force | Out-Null
    $process = [Diagnostics.Process]::Start($start)
    $stopped = $false
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(180000)) { throw 'Background smoke timed out.' }
    $stopped = $true
    $stdout.GetAwaiter().GetResult() | Out-Null
    $stderr.GetAwaiter().GetResult() | Out-Null
    if (-not (Test-Path -LiteralPath $report -PathType Leaf)) { throw 'Background smoke produced no report.' }
    $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    if ($result.runId -ne $runId -or $process.ExitCode -ne 0 -or -not $result.ok) { throw ('Background smoke failed: ' + $result.error) }
    Get-Content -LiteralPath $report -Raw
} finally {
    try {
        if (-not $stopped -and $process -and -not $process.HasExited) {
            & taskkill.exe /PID $process.Id /T /F | Out-Null
            $stopped = $process.WaitForExit(10000)
        }
        if ($stopped -and $taskRoot -and (Test-Path -LiteralPath $taskRoot -PathType Container)) {
            if (-not [IO.Path]::GetFullPath($taskRoot).StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Background cleanup target is outside its temporary root.' }
            $owner = Get-Content -LiteralPath (Join-Path $taskRoot 'owner.json') -Raw | ConvertFrom-Json
            $allowed = @('owner.json', 'home', 'codex', 'local-state', 'host', 'package')
            if ($owner.runId -ne $runId -or (Get-ChildItem -LiteralPath $taskRoot -Force | Where-Object { $_.Name -notin $allowed })) { throw 'Background fixture ownership or contents changed.' }
            Assert-PlainPath $taskRoot
            if (Get-ChildItem -LiteralPath $taskRoot -Recurse -Force -Attributes ReparsePoint) { throw 'Linked background fixture must be preserved.' }
            Remove-Item -LiteralPath $taskRoot -Recurse -Force
        }
    } finally { $env:TEMP = $originalTemp; $env:TMP = $originalTmp }
}
