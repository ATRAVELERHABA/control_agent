$ErrorActionPreference = "Stop"

$chromeCandidates = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)

$browser = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browser) {
  throw "Chrome or Edge was not found."
}

$baseDir = Join-Path $PSScriptRoot "..\.tmp\thesis_screenshots"
$baseDir = [System.IO.Path]::GetFullPath($baseDir)

$targets = @(
  @{ Html = "login-page.html"; Png = "login-page.png"; Width = 1600; Height = 980 },
  @{ Html = "activation-page.html"; Png = "activation-page.png"; Width = 1400; Height = 980 },
  @{ Html = "memory-terminal-idle.html"; Png = "memory-terminal-idle.png"; Width = 1680; Height = 1050 },
  @{ Html = "memory-terminal-summary.html"; Png = "memory-terminal-summary.png"; Width = 1680; Height = 1050 }
)

foreach ($target in $targets) {
  $htmlPath = Join-Path $baseDir $target.Html
  $pngPath = Join-Path $baseDir $target.Png
  $uri = [System.Uri]::new($htmlPath).AbsoluteUri

  & $browser `
    --headless=new `
    --disable-gpu `
    --hide-scrollbars `
    --force-device-scale-factor=1 `
    --window-size="$($target.Width),$($target.Height)" `
    "--screenshot=$pngPath" `
    $uri | Out-Null
}

Get-ChildItem $baseDir -Filter *.png | Select-Object FullName, Length, LastWriteTime
