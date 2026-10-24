<#
.SYNOPSIS
    Install or update NunaBooks on the shop PC and start it, following
    DEPLOYMENT.md step by step.

.DESCRIPTION
    Run from anywhere; it works in the project folder. In order it:

    1. Checks Node is 22 or newer.
    2. npm ci
    3. npm run env:init (never overwrites an existing .env)
    4. Sets NODE_ENV=production and SEED_DEMO_DATA=false in .env.
       COOKIE_SECURE and everything else are left as they are.
    5. npm run db:migrate
    6. npm run build
    7. npm run preflight. On a first install "No active owner" is expected
       until the owner is created on the setup screen; any other failure
       must be fixed before trading. It reports, it does not stop the script.
    8. Optional, with -Firewall and -AutoStart (both need Administrator):
       opens the port in the Windows firewall, and registers a Task Scheduler
       task that starts the app in the background when the PC starts.
    9. Starts the app, unless -NoStart: in the background through the task
       with -AutoStart, otherwise in this window.

    Safe to re-run. To update: git pull, then run it again.

    Do not run this on a development machine: step 4 turns its .env into a
    production one.

.PARAMETER Port
    Port to serve on. Defaults to 5177.

.PARAMETER Firewall
    Add the inbound firewall rule so other devices on the shop network can reach it.

.PARAMETER AutoStart
    Register a Task Scheduler task "NunaBooks" that starts the app in the background
    when the PC starts, with no window. Its output goes to data\server.log.

.PARAMETER NoStart
    Stop after the build and preflight instead of starting the server here.

.EXAMPLE
    .\scripts\deploy.ps1 -Firewall -AutoStart
#>

param(
    [int]$Port = 5177,
    [switch]$Firewall,
    [switch]$AutoStart,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Native commands do not throw on failure, so check each exit code.
function Invoke-Step([string]$Title, [string[]]$NpmArgs) {
    Write-Host ""
    Write-Host "==> $Title" -ForegroundColor Cyan
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Title failed (exit code $LASTEXITCODE). Nothing after it was run. See 'If something goes wrong' in DEPLOYMENT.md."
        exit 1
    }
}

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $text = Get-Content -Path $Path -Raw
    $pattern = "(?m)^$([regex]::Escape($Key))=.*$"
    if ($text -match $pattern) {
        $text = [regex]::Replace($text, $pattern, "$Key=$Value")
    }
    else {
        $text = $text.TrimEnd() + "`n$Key=$Value`n"
    }
    # Not Set-Content: Windows PowerShell 5 would add a byte-order mark.
    [IO.File]::WriteAllText($Path, $text)
}

# --- 1. Node version ---------------------------------------------------------

$nodeVersion = (& node -v) 2>$null
if (-not $nodeVersion -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
    Write-Error "Node 22 or newer is needed (found: $(if ($nodeVersion) { $nodeVersion } else { 'none' })). Install it from nodejs.org and run this again."
    exit 1
}
Write-Host "Node $nodeVersion"

if ($env:NODE_ENV -eq "production") {
    # npm would skip devDependencies and the build would fail on tailwind/typescript.
    Write-Error "NODE_ENV=production is set in this terminal. Close it and open a fresh one; .env carries the production setting."
    exit 1
}

# npm ci cannot replace the database driver while a running app holds it open.
function Test-Listening { [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) }

if ((Test-Listening) -and (Get-ScheduledTask -TaskName "NunaBooks" -ErrorAction SilentlyContinue)) {
    Write-Host "Stopping the app running in the background (the 'NunaBooks' task) so it can be updated."
    Stop-ScheduledTask -TaskName "NunaBooks" -ErrorAction SilentlyContinue
    # Ending the task leaves the node process it started still running, so stop that too.
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 30 -and (Test-Listening); $i++) { Start-Sleep -Seconds 1 }
}
if (Test-Listening) {
    Write-Error "Something is already serving on port $Port - most likely the app itself. Stop it first (close its window, or end the 'NunaBooks' task in Task Scheduler), then run this again."
    exit 1
}

# --- 2-4. Dependencies and .env ----------------------------------------------

Write-Host ""
Write-Host "The next steps take several minutes. If they seem to stop, look at this window's title bar:" -ForegroundColor Yellow
Write-Host "if it starts with 'Select', a click paused it. Press Esc and it carries on." -ForegroundColor Yellow

# http logging prints a line per package; plain npm ci goes silent for minutes and looks hung.
Invoke-Step "Installing dependencies" @("ci", "--loglevel=http")
Invoke-Step "Creating .env" @("run", "env:init")

$envPath = Join-Path $root ".env"
Set-EnvValue $envPath "NODE_ENV" "production"
Set-EnvValue $envPath "SEED_DEMO_DATA" "false"
Write-Host ".env: NODE_ENV=production, SEED_DEMO_DATA=false"

# --- 5-6. Database and build ---------------------------------------------------

Invoke-Step "Applying database migrations" @("run", "db:migrate")
Invoke-Step "Building" @("run", "build")

# --- 7. Preflight --------------------------------------------------------------

Write-Host ""
Write-Host "==> Preflight" -ForegroundColor Cyan
& npm run preflight
$preflightPassed = $LASTEXITCODE -eq 0
if (-not $preflightPassed) {
    Write-Warning "Preflight has failures. On a first install, 'No active owner' clears once you create the owner on the setup screen. Fix anything else before trading, then run 'npm run preflight' again."
}

# --- 8. Firewall and auto-start (optional, Administrator) ------------------------

if ($Firewall -or $AutoStart) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Error "-Firewall and -AutoStart need Administrator rights. Open PowerShell with 'Run as Administrator' and run this again."
        exit 1
    }
}

if ($Firewall) {
    if (Get-NetFirewallRule -DisplayName "NunaBooks" -ErrorAction SilentlyContinue) {
        Write-Host "Firewall rule 'NunaBooks' already exists - leaving it as is."
    }
    else {
        New-NetFirewallRule -DisplayName "NunaBooks" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
        Write-Host "Firewall: allowed TCP $Port inbound."
    }
}

if ($AutoStart) {
    $npm = (Get-Command npm.cmd).Source
    New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null
    # cmd /c only to send the output somewhere: with no window, data\server.log is where it can be read.
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$npm`" start -- -p $Port > data\server.log 2>&1`"" -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    # S4U: runs as this user with no window, before anyone logs on, and stores no password.
    $taskUser = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
    # The default limit would stop the app after three days; a laptop on battery would never start it.
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName "NunaBooks" -Action $action -Trigger $trigger -Principal $taskUser -Settings $settings -Force | Out-Null
    Write-Host "Task Scheduler: 'NunaBooks' starts the app in the background whenever the PC starts. No window stays open."
}

# --- 9. Start ----------------------------------------------------------------------

Write-Host ""
if ($NoStart) {
    Write-Host "Ready. Start it with: npm start -- -p $Port"
    exit $(if ($preflightPassed) { 0 } else { 1 })
}

if ($AutoStart) {
    Start-ScheduledTask -TaskName "NunaBooks"
    for ($i = 0; $i -lt 90 -and -not (Test-Listening); $i++) { Start-Sleep -Seconds 1 }
    if (-not (Test-Listening)) {
        Write-Error "The app did not start. What it printed is in $(Join-Path $root 'data\server.log')."
        exit 1
    }
    Write-Host "Running in the background on http://localhost:$Port. You can close this window." -ForegroundColor Green
    exit $(if ($preflightPassed) { 0 } else { 1 })
}

Write-Host "Starting on http://localhost:$Port - leave this window open. Ctrl+C stops it." -ForegroundColor Green
& npm start -- -p $Port
