@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "CUDA_PORT=8000"
if not "%~1"=="" set "CUDA_PORT=%~1"
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: The optional CUDA bridge requires Node.js 22 or newer.
    pause
    exit /b 1
)
set "CUDA_WORKER=%~dp0build\cuda\Release\pnggpu_cuda_worker.exe"
if not exist "%CUDA_WORKER%" set "CUDA_WORKER=%~dp0build\cuda\pnggpu_cuda_worker.exe"
if not exist "%CUDA_WORKER%" (
    echo ERROR: CUDA worker not found. Run build-cuda.bat first; see overlay\docs\CUDA_BACKEND.md.
    pause
    exit /b 1
)
rem Refresh the overlay even when an earlier GPU-007 install already exists.
call "%~dp0setup.bat"
if errorlevel 1 exit /b 1
echo Optional CUDA workbench: http://127.0.0.1:%CUDA_PORT%/experiments/webgpu/photographic.html?backend=cuda
echo Local-only. Press Ctrl+C to stop. The worker selects the first compatible GPU unless a device index is supplied.
if "%~2"=="" (
    node "%~dp0scripts\serve.mjs" "%~dp0PNG2ANSI" "%CUDA_PORT%" --cuda "%CUDA_WORKER%"
) else (
    node "%~dp0scripts\serve.mjs" "%~dp0PNG2ANSI" "%CUDA_PORT%" --cuda "%CUDA_WORKER%" --device "%~2"
)
exit /b %ERRORLEVEL%
