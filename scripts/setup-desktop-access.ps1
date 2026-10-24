<#
.SYNOPSIS
    One-time setup: give the shop PC a friendly local name for NunaBooks and a
    desktop icon that opens it.

.DESCRIPTION
    Run once, as Administrator, on the PC that runs the app. It does two
    things, both scoped to this one machine only:

    1. Adds an entry to the Windows hosts file mapping a name (e.g.
       "awesomeshop") to 127.0.0.1, so this PC can reach the app at
       http://<name>:<port> instead of http://localhost:<port>.
    2. Creates a desktop shortcut that opens that address in the default
       browser (or Edge, when no default is set).

    The shortcut only opens a browser - it does not start the server. The
    server must already be running (see "Keeping it running" in
    DEPLOYMENT.md for the Task Scheduler auto-start setup, or start it by
    hand with `npm start -- -p <port>`).

    Safe to re-run: an existing hosts entry for the same name is left alone
    rather than duplicated, and re-running with a different -Name replaces
    the shortcut this script created.

.PARAMETER Name
    The friendly name to use, e.g. "awesomeshop". Defaults to "shop".
    Sanitized to lowercase letters, digits and hyphens only, since hosts
    file entries can't contain spaces or other characters.

.PARAMETER Port
    The port the app is started with. Defaults to 5177. Must match whatever
    port is actually passed to `npm start -- -p <port>`.

.EXAMPLE
    .\scripts\setup-desktop-access.ps1 -Name awesomeshop
#>

param(
    [string]$Name = "shop",
    [int]$Port = 5177
)

$ErrorActionPreference = "Stop"

# --- 1. Sanitize the name -----------------------------------------------

$sanitized = $Name.ToLowerInvariant() -replace '[^a-z0-9-]+', '-'
$sanitized = $sanitized.Trim('-')

if ([string]::IsNullOrWhiteSpace($sanitized)) {
    Write-Error "`"$Name`" doesn't leave anything usable after removing spaces and symbols. Pick a name made of letters, numbers and hyphens, e.g. `"awesomeshop`"."
    exit 1
}

if ($sanitized -ne $Name.ToLowerInvariant()) {
    Write-Host "Using `"$sanitized`" (hostnames can't contain spaces or most punctuation)."
}

$url = "http://${sanitized}:${Port}"

# --- 2. Elevation check ---------------------------------------------------

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Error "This needs to edit the hosts file, which needs Administrator rights. Right-click PowerShell (or this script) and choose 'Run as Administrator', then run it again."
    exit 1
}

# --- 3. Hosts file entry ---------------------------------------------------

$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$marker = "# NunaBooks (added by setup-desktop-access.ps1)"
$hostsLine = "127.0.0.1`t$sanitized`t$marker"

try {
    $existing = Get-Content -Path $hostsPath -ErrorAction Stop
    $alreadyPresent = $existing | Where-Object {
        $_ -match "^\s*127\.0\.0\.1\s+$([regex]::Escape($sanitized))\b"
    }

    if ($alreadyPresent) {
        Write-Host "Hosts file already maps `"$sanitized`" to this PC - leaving it as is."
    }
    else {
        Add-Content -Path $hostsPath -Value $hostsLine -ErrorAction Stop
        Write-Host "Added `"$sanitized`" to the hosts file."
    }
}
catch {
    Write-Warning "Could not update the hosts file automatically (some antivirus software locks it). Add this line yourself, as Administrator, in Notepad:"
    Write-Host ""
    Write-Host "    $hostsLine"
    Write-Host ""
    Write-Host "File location: $hostsPath"
}

# --- 4. Desktop shortcut ----------------------------------------------------

# A shortcut straight to the browser, not a .url file: a .url opens through Windows'
# "http" link setting, and on a PC where that is unset it fails with "Application not found".
function Get-BrowserPath {
    $choice = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" -ErrorAction SilentlyContinue
    if ($choice -and $choice.ProgId) {
        $command = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$($choice.ProgId)\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
        if ($command -and ($command -match '^"([^"]+)"' -or $command -match '^(\S+)') -and (Test-Path $Matches[1])) {
            return $Matches[1]
        }
    }
    # No usable default: Edge comes with Windows, Chrome is the next most likely.
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    )
    return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutName = (Get-Culture).TextInfo.ToTitleCase($sanitized) -replace '-', ' '
$browser = Get-BrowserPath

# An earlier version of this script made a .url icon; replace it rather than leave two.
Remove-Item -Path (Join-Path $desktop "$shortcutName.url") -ErrorAction SilentlyContinue

if ($browser) {
    $shortcutPath = Join-Path $desktop "$shortcutName.lnk"
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $browser
    $shortcut.Arguments = $url
    $shortcut.IconLocation = "$browser,0"
    $shortcut.Description = "Open NunaBooks"
    $shortcut.Save()
    Write-Host "Created desktop icon: $shortcutPath (opens $url in $(Split-Path -Leaf $browser))"
}
else {
    $shortcutPath = Join-Path $desktop "$shortcutName.url"
    Set-Content -Path $shortcutPath -Value "[InternetShortcut]`r`nURL=$url" -Encoding ASCII
    Write-Warning "No browser was found, so the icon is a plain web link. If it says 'Application not found', set a default browser in Windows Settings > Apps > Default apps."
}

# --- 5. Summary --------------------------------------------------------------

Write-Host ""
Write-Host "Done. Once the app is running, double-click `"$shortcutName`" on the desktop to open $url."
Write-Host "This icon only opens a browser - it does not start the app. Make sure the server is running first (see 'Keeping it running' in DEPLOYMENT.md)."
