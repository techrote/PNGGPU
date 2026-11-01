# Reconstruct a COMPLETE GPU-007 checkout without any earlier GPU-001 files.
# The original upstream includes a licensed font and built offline webapp,
# and is downloaded directly by the user's PC from GitHub on first setup.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$baseCommit = '67ae97295ab9a9ab32fdee5410c2371e4b21ce87'
$root = Split-Path -Parent $PSScriptRoot
$overlay = Join-Path $root 'overlay'
$target = Join-Path $root 'PNG2ANSI'

function Test-Installed {
    param([string] $Path)
    foreach ($relative in @(
        'src/core.js', 'assets/DejaVuSansMono.ttf', 'PNG2ANSI-web.html',
        'src/gpu/streamed_samples.js', 'src/gpu/photographic.js', 'src/gpu/photographic.wgsl', 'src/gpu/memory.js', 'src/gpu/benchmark_zip.js',
        'src/gpu/workload.js', 'src/gpu/reference_photo.js',
        'src/gpu/metrics.js', 'src/gpu/cpu_worker_host.js',
        'src/gpu/reference_photo.worker.js', 'src/gpu/progress.js', 'tests/gpu_memory.test.mjs',
        'docs/WEBGPU_BENCHMARKS.md', 'tests/gpu_pipeline.test.mjs', 'tests/gpu007_extended.test.mjs', 'tests/benchmark_zip.test.mjs',
        'experiments/webgpu/photographic.html',
        'fixtures/hardmode/manifest.json'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $relative) -PathType Leaf)) {
            return $false
        }
    }
    return $true
}

function Assert-HardmodeIntegrity {
    param([string] $Path)
    $manifestFile = Join-Path $Path 'fixtures/hardmode/manifest.json'
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 'png2ansi-hardmode-v1' -or $manifest.images.Count -ne 5) {
        throw 'Hardmode manifest is incomplete or incompatible.'
    }
    foreach ($item in $manifest.images) {
        if ($item.file -notmatch '^[a-z0-9-]+\.png$') { throw 'Unexpected hardmode filename.' }
        $file = Join-Path $Path ('fixtures/hardmode/' + $item.file)
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing benchmark image: $($item.file)" }
        $info = Get-Item -LiteralPath $file
        if ($info.Length -ne $item.size_bytes) { throw "Size mismatch: $($item.file)" }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $item.sha256) { throw "SHA256 mismatch: $($item.file)" }
    }
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $overlay 'src/gpu/photographic.js') -PathType Leaf)) {
        throw 'GPU-007 overlay is missing. Extract the entire ZIP before running setup.bat.'
    }
    if (Test-Path -LiteralPath $target) {
        # A previous GPU-001/GPU-002 installation may already be present.
        # Upgrade the full source in place without deleting user data.
        if (-not (Test-Path -LiteralPath (Join-Path $target 'src/core.js') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $target 'assets/DejaVuSansMono.ttf') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $target 'PNG2ANSI-web.html') -PathType Leaf)) {
            throw "Incomplete upstream PNG2ANSI source at $target. Rename it and rerun setup.bat; no files were overwritten."
        }
        Write-Host 'Installing/updating the cumulative GPU-007 overlay...' -ForegroundColor Cyan
        Copy-Item -Path (Join-Path $overlay '*') -Destination $target -Recurse -Force
        if (-not (Test-Installed $target)) { throw 'Updated installation failed the required-file check.' }
        Assert-HardmodeIntegrity $target
        @{upstream='techrote/PNG2ANSI'; commit=$baseCommit; gpu_overlay='GPU-007'; source='pinned GitHub archive'} |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'GPU007_BASE.json') -Encoding UTF8
        Write-Host 'Complete PNG2ANSI GPU-007 installation is present.' -ForegroundColor Green
        Write-Host 'Run start.bat to open the workbench.'
        exit 0
    }
    # TLS1.2 is required by some older Windows PowerShell 5.1 configurations.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $staging = Join-Path $root ('.gpu007-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -Path $staging -ItemType Directory -Force | Out-Null
    try {
        $archive = Join-Path $staging 'png2ansi-base.zip'
        $url = 'https://codeload.github.com/techrote/PNG2ANSI/zip/' + $baseCommit
        Write-Host 'Downloading the pinned original PNG2ANSI source from GitHub...' -ForegroundColor Cyan
        Write-Host "Commit: $baseCommit"
        Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -TimeoutSec 180
        $expanded = Join-Path $staging 'upstream'
        Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
        $candidate = @(Get-ChildItem -LiteralPath $expanded -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'src/core.js') -PathType Leaf })
        if ($candidate.Count -ne 1) {
            throw 'Downloaded archive does not contain the expected PNG2ANSI source checkout.'
        }
        $app = Join-Path $staging 'app'
        Move-Item -LiteralPath ($candidate[0].FullName) -Destination $app
        Write-Host 'Applying complete GPU-007 implementation and all benchmark images...' -ForegroundColor Cyan
        Copy-Item -Path (Join-Path $overlay '*') -Destination $app -Recurse -Force
        if (-not (Test-Installed $app)) { throw 'Installation failed the required-file checks.' }
        Write-Host 'Verifying original SHA-256 checksums for all five hardmode images...'
        Assert-HardmodeIntegrity $app
        # Include the pinned upstream provenance in the installed tree.
        @{upstream='techrote/PNG2ANSI'; commit=$baseCommit; gpu_overlay='GPU-007'; source='pinned GitHub archive'} |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app 'GPU007_BASE.json') -Encoding UTF8
        Move-Item -LiteralPath $app -Destination $target
        Write-Host 'Installation complete. No GPU-001 files were required.' -ForegroundColor Green
        Write-Host "Run start.bat (or test.bat if Node.js is installed)."
        exit 0
    } finally {
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Force -Recurse
        }
    }
} catch {
    Write-Host ''
    Write-Host ('INSTALL ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Original GPU-001 is NOT required. A one-time connection to GitHub IS required for the upstream source.' -ForegroundColor Yellow
    exit 1
}
