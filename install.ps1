param(
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $project

if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host 'Created private .env from .env.example.'
}

$python = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        $python = 'py'
    } else {
        throw 'Python was not found. Install Hermes Agent first, or install Python 3.12 and run this again.'
    }
}

$voicePython = Join-Path $project '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $voicePython)) {
    if ($python -eq 'py') { & py -3.12 -m venv .venv }
    else { & $python -m venv .venv }
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Zuzu Python environment.' }
}
& $voicePython migrate_voice_mode.py
if ($LASTEXITCODE -ne 0) { throw 'Could not migrate the Zuzu voice setting.' }
& $voicePython -m pip install --disable-pip-version-check -q faster-whisper psutil pillow
if ($LASTEXITCODE -ne 0) { throw 'Could not install local voice transcription.' }

if (-not $NoOpen) {
    $env:JARVIS_OPEN = '1'
}

Write-Host ''
Write-Host 'Zuzu is ready. Launching with the configured Hermes profile.'
Write-Host 'Dashboard: http://127.0.0.1:8730/?release=47'
Write-Host ''

& $voicePython server.py
