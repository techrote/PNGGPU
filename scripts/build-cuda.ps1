# Optional CUDA build. Normal setup.bat/start.bat never invoke this script.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build/cuda'
try {
    if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
        throw 'Install CMake 3.21+ and add it to PATH, then rerun build-cuda.bat.'
    }
    Write-Host 'Building the optional Turing CUDA worker (sm_75 + compute_75 PTX)...' -ForegroundColor Cyan
    Write-Host 'Requires Visual Studio 2022 C++ build tools and NVIDIA CUDA Toolkit. CI uses CUDA 12.8.1.'
    & cmake -S (Join-Path $root 'native/cuda') -B $build -G 'Visual Studio 17 2022' -A x64 '-DPNGGPU_ENABLE_CUDA=ON' '-DBUILD_TESTING=ON'
    if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed. Check CUDA Toolkit / Visual Studio C++ installation.' }
    & cmake --build $build --config Release --parallel 4
    if ($LASTEXITCODE -ne 0) { throw 'CUDA build failed; read the compiler output above.' }
    & ctest --test-dir $build -C Release --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw 'Native host tests failed.' }
    $worker = Join-Path $build 'Release/pnggpu_cuda_worker.exe'
    if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'Expected worker executable was not produced.' }
    Write-Host "Built: $worker" -ForegroundColor Green
    Write-Host 'Run start-cuda.bat. For device checks: build\cuda\Release\pnggpu_cuda_worker.exe --self-test'
    exit 0
} catch {
    Write-Host ('CUDA BUILD ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
