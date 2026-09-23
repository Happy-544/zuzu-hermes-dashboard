param(
    [switch]$Once
)

$ErrorActionPreference = 'Continue'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe'
$localPython = Join-Path $project '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $localPython) { $python = $localPython }
$server = Join-Path $project 'server.py'
$log = Join-Path $project 'zuzu-service.log'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Hermes Python runtime was not found. Run Hermes setup first."
}

Set-Location -LiteralPath $project
do {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $log -Value "[$stamp] starting Zuzu dashboard"
    & $python $server *>> $log
    $exitCode = $LASTEXITCODE
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $log -Value "[$stamp] Zuzu exited with code $exitCode"
    if (-not $Once) { Start-Sleep -Seconds 3 }
} while (-not $Once)
