# Run the Lichess per-handle crawler in a restart-on-crash loop.
#
# Same shape as chesscom-crawl-loop.ps1; see docs/LICHESS-CRAWL-RUNBOOK.md
# for the operational story. Crashes log to logs/lichess-crawl.log with a
# 10-second backoff before retry.
#
# Usage:
#   .\scripts\lichess-crawl-loop.ps1
#   .\scripts\lichess-crawl-loop.ps1 -ExitWhenEmpty
#   .\scripts\lichess-crawl-loop.ps1 -RateMs 2000 -MonthsBack 12
#
# Ctrl+C signals the inner crawler which releases its in-flight item to
# pending and exits cleanly; the wrapper sees the exit and stops too.

[CmdletBinding()]
param(
    [int]$RateMs = 2000,
    [int]$MonthsBack = 12,
    [int]$IdleSleepSec = 60,
    [switch]$ExitWhenEmpty,
    [string]$WorkerId = "$env:COMPUTERNAME-lichess-$PID",
    [int]$BackoffSec = 10
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path "$PSScriptRoot\..\..\.."
$LogDir = Join-Path $RepoRoot 'apps\workers\logs'
$LogPath = Join-Path $LogDir 'lichess-crawl.log'
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
        Write-Log "iteration $iteration: spawning crawler"

        $crawlerArgs = @(
            '--filter', '@chessco/workers', 'lichess:crawl',
            '--',
            '--rate-ms', "$RateMs",
            '--months-back', "$MonthsBack",
            '--idle-sleep-sec', "$IdleSleepSec",
            '--worker-id', "$WorkerId"
        )
        if ($ExitWhenEmpty) { $crawlerArgs += '--exit-when-empty' }

        & pnpm @crawlerArgs

        $exit = $LASTEXITCODE
        Write-Log "iteration $iteration: crawler exited code=$exit"

        if ($exit -eq 0) {
            if ($ExitWhenEmpty) {
                Write-Log "queue drained — loop terminating."
                break
            }
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
