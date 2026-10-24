<#
.SYNOPSIS
    Update NunaBooks in place. Started by the "Update now" button on
    Settings -> Health & backup; it can also be run by hand.

.DESCRIPTION
    The running app cannot update itself: npm ci has to replace the database
    driver the server holds open, and the build replaces the files it serves.
    So the button starts this script on its own and the script:

    1. Takes a verified backup while the shop is still up. If that fails,
       it stops here and nothing has changed.
    2. Stops the server listening on -Port.
    3. git pull --ff-only, npm ci, npm run build.
    4. If any of those fail, puts the code back to the commit it started
       from and rebuilds that, so the shop comes back on the old version.
    5. Starts the app again: through the "NunaBooks" Task Scheduler task when
       there is one, otherwise in the background with no window. Either way
       its output goes to data\server.log.

    Migrations are not run here; they apply when the app starts.

    The outcome is written to -StatusPath as JSON, which the Health page reads
    back once the app is up again.

.PARAMETER Port
    The port the app serves on.

.PARAMETER StatusPath
    Where to write the outcome. The app passes data/update-status.json.

.EXAMPLE
    .\scripts\update.ps1 -Port 5177 -StatusPath .\data\update-status.json
#>

param(
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][string]$StatusPath
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Inherited from the server. Left set, npm ci skips devDependencies and the build fails.
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
# A git that wants a password must fail, not wait for a keyboard nobody is at.
$env:GIT_TERMINAL_PROMPT = "0"
# Run by hand, git may refuse a folder an Administrator cloned ("dubious ownership"). The app sets this too.
$env:GIT_CONFIG_COUNT = "1"
$env:GIT_CONFIG_KEY_0 = "safe.directory"
$env:GIT_CONFIG_VALUE_0 = $root -replace '\\', '/'

$startedAt = (Get-Date).ToUniversalTime().ToString("o")
$from = (& git rev-parse HEAD).Trim()

function Write-Status([string]$State, [string]$Message, [string]$To = $from) {
    $status = [ordered]@{
        state      = $State
        startedAt  = $startedAt
        finishedAt = (Get-Date).ToUniversalTime().ToString("o")
        from       = $from
        to         = $To
        message    = $Message
    }
    [IO.File]::WriteAllText($StatusPath, ($status | ConvertTo-Json))
}

function Invoke-Native([string]$Title, [string]$Exe, [string[]]$Arguments) {
    Write-Host "==> $Title"
    # Out-Host, or the command's output would become this function's return value.
    & $Exe @Arguments | Out-Host
    return $LASTEXITCODE -eq 0
}

function Start-App {
    if (Get-ScheduledTask -TaskName "NunaBooks" -ErrorAction SilentlyContinue) {
        try {
            Start-ScheduledTask -TaskName "NunaBooks"
            return
        }
        catch {
            Write-Host "Could not start the 'NunaBooks' task ($($_.Exception.Message)); starting the app directly."
        }
    }
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"npm.cmd start -- -p $Port > data\server.log 2>&1`"" -WorkingDirectory $root -WindowStyle Hidden
}

# Give the button's response time to reach the browser before the server goes.
Start-Sleep -Seconds 3

# --- 1. Backup, while the shop is still up ----------------------------------------

if (-not (Invoke-Native "Taking a backup" "npm.cmd" @("run", "backup"))) {
    Write-Status "failed" "The backup before updating could not be taken, so nothing was changed. The app is still on the version it was."
    exit 1
}

# --- 2. Stop the server ---------------------------------------------------------------

Write-Host "==> Stopping the app on port $Port"
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
# The server only, not its process tree: this script was started by the server and is part of that tree.
foreach ($owner in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
}
for ($i = 0; $i -lt 30 -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Seconds 1
}

# --- 3. Pull, install, build ---------------------------------------------------------

$ok = (Invoke-Native "Downloading the new version" "git" @("pull", "--ff-only")) -and
      (Invoke-Native "Installing dependencies" "npm.cmd" @("ci")) -and
      (Invoke-Native "Building" "npm.cmd" @("run", "build"))

$to = (& git rev-parse HEAD).Trim()

if ($ok) {
    Write-Status "done" "Updated." $to
    Start-App
    exit 0
}

# --- 4. Roll back to the version that was running ----------------------------------

Write-Host "==> Update failed; restoring $from"
# --hard is safe here: the shop's data and .env are git-ignored, so only code moves.
$restored = (Invoke-Native "Restoring the previous code" "git" @("reset", "--hard", $from)) -and
            (Invoke-Native "Reinstalling dependencies" "npm.cmd" @("ci")) -and
            (Invoke-Native "Rebuilding" "npm.cmd" @("run", "build"))

if ($restored) {
    Write-Status "failed" "The update could not be installed, so the app was put back on the version it was. Details are in data/update.log."
}
else {
    Write-Status "failed" "The update failed and the previous version could not be rebuilt either. Run scripts\deploy.ps1 on this computer. Details are in data/update.log."
}
Start-App
exit 1
