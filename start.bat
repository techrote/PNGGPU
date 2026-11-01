@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "APP_DIR=%~dp0PNG2ANSI"
set "PORT=8000"
if not "%~1"=="" set "PORT=%~1"
if not exist "%APP_DIR%\GPU007_BASE.json" (
    echo [PNG2ANSI GPU-007] First run or version update: applying complete GPU-007 package...
    call "%~dp0setup.bat"
    if errorlevel 1 exit /b 1
)
echo.
echo ==== PNG2ANSI-GPU007 WebGPU hardmode workbench ====
echo Using local address: http://127.0.0.1:%PORT%/experiments/webgpu/photographic.html
echo The server is local-only. Press Ctrl+C to stop.
echo.
where py >nul 2>&1
if not errorlevel 1 (
    py -3 -c "import http.server" >nul 2>&1
    if not errorlevel 1 (
        py -3 "%~dp0scripts\serve.py" "%APP_DIR%" "%PORT%"
        exit /b %ERRORLEVEL%
    )
)
where python >nul 2>&1
if not errorlevel 1 (
    python -c "import http.server" >nul 2>&1
    if not errorlevel 1 (
        python "%~dp0scripts\serve.py" "%APP_DIR%" "%PORT%"
        exit /b %ERRORLEVEL%
    )
)
where node >nul 2>&1
if not errorlevel 1 (
    node "%~dp0scripts\serve.mjs" "%APP_DIR%" "%PORT%"
    exit /b %ERRORLEVEL%
)
echo ERROR: Python 3 or Node.js is required to run a localhost web server.
echo Install one of them and rerun start.bat.
pause
exit /b 1
