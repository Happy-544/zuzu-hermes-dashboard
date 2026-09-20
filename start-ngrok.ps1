param(
    [switch]$Once
)

$ErrorActionPreference = 'Continue'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$ngrok = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\ngrok.exe'
$config = Join-Path $env:LOCALAPPDATA 'ngrok\jarvis.yml'
$publicUrl = 'https://polyester-garden-twiddle.ngrok-free.dev'
$log = Join-Path $project 'ngrok-service.log'

if (-not (Test-Path -LiteralPath $ngrok)) {
    throw "ngrok was not found. Install ngrok for this Windows user first."
}

if (-not (Test-Path -LiteralPath $config)) {
    throw "JARVIS ngrok config was not found. Save the ngrok authtoken first."
}

Set-Location -LiteralPath $project
do {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $log -Value "[$stamp] starting JARVIS public tunnel"
    & $ngrok http --config $config --inspect=false --url $publicUrl 8731 *>> $log
    $exitCode = $LASTEXITCODE
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $log -Value "[$stamp] ngrok exited with code $exitCode"
    if (-not $Once) { Start-Sleep -Seconds 5 }
} while (-not $Once)
