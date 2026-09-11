param(
    [switch]$Once
)

$ErrorActionPreference = 'Continue'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe'
$server = Join-Path $project 'server.py'
$log = Join-Path $project 'jarvis-service.log'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Hermes Python runtime was not found. Run Hermes setup first."
}

Set-Location -LiteralPath $project
do {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $log -Value "[$stamp] starting JARVIS dashboard"
    & $python $server *>> $log
    $exitCode = $LASTEXITCODE
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $log -Value "[$stamp] JARVIS exited with code $exitCode"
    if (-not $Once) { Start-Sleep -Seconds 3 }
} while (-not $Once)
