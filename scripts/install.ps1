<#
.SYNOPSIS
    First install on a bare shop PC: Node and Git, the app itself, then
    everything deploy.ps1 does.

.DESCRIPTION
    deploy.ps1 lives inside the app, so it cannot fetch the app. This one is
    downloaded on its own and:

    1. Installs Node.js LTS and Git for Windows, unless a good enough version
       is already there. It uses winget when the PC has it. Without winget it
       downloads the official installers from nodejs.org and GitHub, checks
       each one against its published SHA-256, and runs it.
    2. Clones the app into -Path (default C:\NunaBooks). An existing clone is
       left as it is.
    3. Runs scripts\deploy.ps1 from there, passing -Firewall, -AutoStart,
       -NoStart and -Port through.

    Run it in PowerShell opened with "Run as Administrator". Nothing to save
    first, it runs straight from GitHub:

        & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kuokoad/bookkeeper/main/scripts/install.ps1))) -Firewall -AutoStart

    winget, or the installers themselves, will ask you to accept their terms and
    licences. Those are your answers to give, so this script does not answer
    them for you. Clicking Next through the installers with the defaults is fine.

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

# Windows PowerShell 5 may still offer TLS 1.0, which nodejs.org and GitHub refuse.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# Windows PowerShell 5 draws a progress bar per chunk, which makes a 60 MB download crawl.
$ProgressPreference = "SilentlyContinue"

$arm = $env:PROCESSOR_ARCHITECTURE -eq "ARM64"

function Get-NodeInstaller {
    $lts = (Invoke-RestMethod "https://nodejs.org/dist/index.json") | Where-Object { $_.lts } | Select-Object -First 1
    $file = "node-$($lts.version)-$(if ($arm) { 'arm64' } else { 'x64' }).msi"
    $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$($lts.version)/SHASUMS256.txt").Content
    $line = $sums -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match "\s$([regex]::Escape($file))$" } | Select-Object -First 1
    if (-not $line) { throw "nodejs.org lists no checksum for $file, so it was not downloaded. Install Node.js LTS by hand from nodejs.org, then run this again." }
    return @{ Url = "https://nodejs.org/dist/$($lts.version)/$file"; Sha256 = ($line -split '\s+')[0]; Name = $file }
}

function Get-GitInstaller {
    $release = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "nunabooks-installer" }
    $pattern = if ($arm) { '^Git-[\d.]+-arm64\.exe$' } else { '^Git-[\d.]+-64-bit\.exe$' }
    $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if (-not $asset -or $asset.digest -notmatch '^sha256:') {
        throw "GitHub did not give a checksummed Git installer, so none was downloaded. Install Git by hand from git-scm.com, then run this again."
    }
    return @{ Url = $asset.browser_download_url; Sha256 = $asset.digest.Substring(7); Name = $asset.name }
}

function Save-VerifiedInstaller([hashtable]$Installer) {
    $folder = Join-Path $env:TEMP "nunabooks-install"
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $file = Join-Path $folder $Installer.Name
    Invoke-WebRequest -UseBasicParsing -Uri $Installer.Url -OutFile $file
    # Never run a download that is not byte-for-byte what was published.
    if ((Get-FileHash -Algorithm SHA256 -Path $file).Hash -ne $Installer.Sha256) {
        Remove-Item -Force $file
        throw "$($Installer.Name) did not match its published checksum, so it was deleted and not run. Try again; if it happens again, install it by hand."
    }
    return $file
}

function Install-Directly([string]$Name, [scriptblock]$Resolve) {
    Write-Host "winget is not on this PC, so downloading the $Name installer directly."
    $file = Save-VerifiedInstaller (& $Resolve)
    Write-Host "Checksum OK. The $Name installer is opening; click through it with the default options."
    $process = if ($file.EndsWith(".msi")) {
        Start-Process msiexec.exe -ArgumentList "/i `"$file`"" -Wait -PassThru
    } else {
        Start-Process $file -Wait -PassThru
    }
    # 3010 is "installed, restart needed later", which is still installed.
    if ($process.ExitCode -notin 0, 3010) {
        throw "The $Name installer did not finish (exit code $($process.ExitCode)). Run this again, or install $Name by hand."
    }
}

function Install-Tool([string]$WingetId, [string]$Name, [scriptblock]$Resolve) {
    Write-Host ""
    Write-Host "==> Installing $Name" -ForegroundColor Cyan
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        & winget install --id $WingetId --exact --source winget
        if ($LASTEXITCODE -ne 0) {
            throw "Installing $Name failed (winget exit code $LASTEXITCODE). Install it by hand, then run this again."
        }
    }
    else {
        Install-Directly $Name $Resolve
    }
    Update-SessionPath
}

# --- 1. Node and Git ----------------------------------------------------------------

if ((Get-NodeMajor) -lt 22) { Install-Tool "OpenJS.NodeJS.LTS" "Node.js" ${function:Get-NodeInstaller} }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-Tool "Git.Git" "Git" ${function:Get-GitInstaller} }

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
