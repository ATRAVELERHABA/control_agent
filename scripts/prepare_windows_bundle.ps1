param(
    [string]$OutputRoot = "src-tauri\bundled-resources"
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingPath {
    param(
        [string]$Candidate
    )

    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return $null
    }

    if (Test-Path $Candidate) {
        return (Resolve-Path $Candidate).Path
    }

    return $null
}

function Sync-Directory {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (-not (Test-Path $Source)) {
        Write-Warning "Skip missing directory: $Source"
        return
    }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $resolvedSource = (Resolve-Path $Source).Path
    $resolvedDestination = [System.IO.Path]::GetFullPath($Destination)

    & robocopy $resolvedSource $resolvedDestination /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "Failed to sync directory: $resolvedSource -> $resolvedDestination"
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bundleRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot))

New-Item -ItemType Directory -Force -Path $bundleRoot | Out-Null

$skillsSource = Join-Path $repoRoot ".skills"
$scriptsSource = Join-Path $repoRoot "control_agent\scripts"
$sitePackagesSource = Join-Path $repoRoot "control_agent\.venv\Lib\site-packages"
$envExampleSource = Join-Path $repoRoot ".env.example"

Sync-Directory -Source $skillsSource -Destination (Join-Path $bundleRoot ".skills")
Sync-Directory -Source $scriptsSource -Destination (Join-Path $bundleRoot "control_agent\scripts")

if (Test-Path $envExampleSource) {
    Copy-Item -Force $envExampleSource (Join-Path $bundleRoot ".env.example")
}

$pythonHomeCandidates = New-Object System.Collections.Generic.List[string]
if ($env:EMBEDDED_PYTHON_HOME) {
    $pythonHomeCandidates.Add($env:EMBEDDED_PYTHON_HOME)
}

$venvConfigPath = Join-Path $repoRoot "control_agent\.venv\pyvenv.cfg"
if (Test-Path $venvConfigPath) {
    $venvHomeLine = Get-Content $venvConfigPath |
        Where-Object { $_ -like "home = *" } |
        Select-Object -First 1

    if ($venvHomeLine) {
        $pythonHomeCandidates.Add(($venvHomeLine -replace "^home = ", "").Trim())
    }
}

$pythonHomeCandidates.Add("C:\Python313")

$resolvedPythonHome = $pythonHomeCandidates |
    ForEach-Object { Resolve-ExistingPath $_ } |
    Where-Object { $_ } |
    Select-Object -First 1

if ($resolvedPythonHome) {
    Sync-Directory -Source $resolvedPythonHome -Destination (Join-Path $bundleRoot "python-runtime")

    if (Test-Path $sitePackagesSource) {
        Sync-Directory -Source $sitePackagesSource -Destination (Join-Path $bundleRoot "control_agent\site-packages")
    } else {
        Write-Warning "Skip missing site-packages directory: $sitePackagesSource"
    }
} else {
    Write-Warning "Embedded Python home was not found. The installer will still build, but Python-based helper tools will require a system Python installation on the target machine."
}

Write-Host "Bundled resources prepared at $bundleRoot"
