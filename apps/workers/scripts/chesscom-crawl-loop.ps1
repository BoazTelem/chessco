# Run the chess.com crawler in a restart-on-crash loop.
#
# Designed for the local Windows machine (see docs/CHESSCOM-CRAWL-RUNBOOK.md).
# The crawler itself sleeps when the queue is idle and exits cleanly when empty
# (with --exit-when-empty). Crashes log to logs/chesscom-crawl.log with a
# 10-second backoff before retry.
#
# Usage:
#   .\scripts\chesscom-crawl-loop.ps1
#   .\scripts\chesscom-crawl-loop.ps1 -ExitWhenEmpty
#   .\scripts\chesscom-crawl-loop.ps1 -RateMs 2000 -MonthsBack 12
#
# Stop with Ctrl+C — the inner crawler handles SIGINT and marks the in-flight
# item back to pending before exiting; this loop sees exit code 130-ish and
# stops too.

[CmdletBinding()]
param(
    [int]$RateMs = 2000,
    [int]$MonthsBack = 12,
    [int]$IdleSleepSec = 60,
    [switch]$ExitWhenEmpty,
    [string]$WorkerId = "$env:COMPUTERNAME-$PID",
    [int]$BackoffSec = 10
)

$ErrorActionPreference = 'Stop'

# Resolve repo root from this script's location (.../apps/workers/scripts/...).
$RepoRoot = Resolve-Path "$PSScriptRoot\..\..\.."
$LogDir = Join-Path $RepoRoot 'apps\workers\logs'
$LogPath = Join-Path $LogDir 'chesscom-crawl.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
    param([string]$Line)
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $msg = "[$ts] $Line"
    Write-Host $msg
    Add-Content -Path $LogPath -Value $msg -Encoding utf8
}

$stopFlag = $false
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    $script:stopFlag = $true
}

Write-Log "loop start — worker=$WorkerId rate=${RateMs}ms months_back=$MonthsBack idle=${IdleSleepSec}s exit_when_empty=$ExitWhenEmpty"

Push-Location $RepoRoot
try {
    $iteration = 0
    while (-not $stopFlag) {
        $iteration++
        Write-Log "iteration $iteration: spawning crawler (output also streams to console)"

        # Build the pnpm args. The `--` separator is what tells pnpm to stop
        # parsing flags and pass the rest through to the underlying script.
        $crawlerArgs = @(
            '--filter', '@chessco/workers', 'chesscom:crawl',
            '--',
            '--rate-ms', "$RateMs",
            '--months-back', "$MonthsBack",
            '--idle-sleep-sec', "$IdleSleepSec",
            '--worker-id', "$WorkerId"
        )
        if ($ExitWhenEmpty) { $crawlerArgs += '--exit-when-empty' }

        # Use the call operator so stdout streams to the console immediately;
        # the loop record (start/exit) is what goes to chesscom-crawl.log.
        & pnpm @crawlerArgs

        $exit = $LASTEXITCODE
        Write-Log "iteration $iteration: crawler exited code=$exit"

        # Clean exit codes:
        #   0    — normal exit (queue empty + --exit-when-empty, or SIGINT)
        #   130  — SIGINT (Ctrl+C); some shells/Node versions surface as 0
        if ($exit -eq 0) {
            if ($ExitWhenEmpty) {
                Write-Log "queue drained — loop terminating."
                break
            }
            # Without --exit-when-empty the crawler shouldn't exit 0 unless killed;
            # restart anyway after a short pause.
            Start-Sleep -Seconds 5
            continue
        }

        Write-Log "non-zero exit — backing off $BackoffSec s before restart."
        Start-Sleep -Seconds $BackoffSec
    }
} finally {
    Pop-Location
    Write-Log "loop end"
}
