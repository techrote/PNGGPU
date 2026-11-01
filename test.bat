@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "%~dp0PNG2ANSI\GPU007_BASE.json" (
    call "%~dp0setup.bat"
    if errorlevel 1 exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js/npm is required for tests. It is not required to run the WebGPU workbench.
    pause
    exit /b 1
)
cd /d "%~dp0PNG2ANSI"
call npm test
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (echo All host tests passed.) else (echo Test suite failed with exit code %RESULT%.)
pause
exit /b %RESULT%
