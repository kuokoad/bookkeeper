<#
.SYNOPSIS
    First install on a bare shop PC: Node and Git, the app itself, then
    everything deploy.ps1 does.

.DESCRIPTION
    deploy.ps1 lives inside the app, so it cannot fetch the app. This one is
    downloaded on its own and:

    1. Installs Node.js LTS and Git for Windows with winget, unless a good
       enough version is already there.
    2. Clones the app into -Path (default C:\NunaBooks). An existing clone is
       left as it is.
    3. Runs scripts\deploy.ps1 from there, passing -Firewall, -AutoStart,
       -NoStart and -Port through.

    Run it in PowerShell opened with "Run as Administrator". Nothing to save
    first, it runs straight from GitHub:

        & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kuokoad/bookkeeper/main/scripts/install.ps1))) -Firewall -AutoStart

    winget may ask you to accept its terms and each installer's licence. Those
    are your answers to give, so this script does not answer them for you.

.PARAMETER Path
    Where to put the app. Defaults to C:\NunaBooks.
#>

param(
    [string]$Path = "C:\NunaBooks",
    [int]$Port = 5177,
    [switch]$Firewall,
    [switch]$AutoStart,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
# Errors throw rather than exit: run from irm, exit would close the window and the message with it.
$repository = "https://github.com/kuokoad/bookkeeper.git"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Open PowerShell with 'Run as Administrator' and run this again. Installing programs and opening the firewall both need it."
}

function Update-SessionPath {
    # A new install lands on the system PATH, which this window read before it existed.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Get-NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    $version = & node -v
    return [int]($version.TrimStart('v').Split('.')[0])
}

function Install-WithWinget([string]$Id, [string]$Name) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget is missing, so $Name cannot be installed automatically. Install 'App Installer' from the Microsoft Store, or install $Name by hand, then run this again."
    }
    Write-Host ""
    Write-Host "==> Installing $Name" -ForegroundColor Cyan
    & winget install --id $Id --exact --source winget
    if ($LASTEXITCODE -ne 0) {
        throw "Installing $Name failed (winget exit code $LASTEXITCODE). Install it by hand, then run this again."
    }
    Update-SessionPath
}

# --- 1. Node and Git ----------------------------------------------------------------

if ((Get-NodeMajor) -lt 22) { Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-WithWinget "Git.Git" "Git" }

if ((Get-NodeMajor) -lt 22 -or -not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Node or Git was installed but this window cannot see it yet. Close PowerShell, open a new one as Administrator, and run this again."
}
Write-Host "Node $(& node -v), $(& git --version)"

# --- 2. The app -------------------------------------------------------------------------

if (Test-Path (Join-Path $Path ".git")) {
    Write-Host "The app is already in $Path - using it as it is."
}
elseif (Test-Path $Path) {
    throw "$Path already exists but is not the app. Move it out of the way, or pass -Path with another folder."
}
else {
    Write-Host ""
    Write-Host "==> Downloading the app into $Path" -ForegroundColor Cyan
    & git clone $repository $Path
    if ($LASTEXITCODE -ne 0) {
        throw "Downloading the app failed. Check this PC is online, then run this again."
    }
}

# --- 3. Everything else ------------------------------------------------------------------

$deployArgs = @{ Port = $Port }
if ($Firewall) { $deployArgs.Firewall = $true }
if ($AutoStart) { $deployArgs.AutoStart = $true }
if ($NoStart) { $deployArgs.NoStart = $true }

& (Join-Path $Path "scripts\deploy.ps1") @deployArgs
