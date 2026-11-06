@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "%~dp0PNG2ANSI\src\gpu\cuda.js" (
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
if not "%RESULT%"=="0" goto finished
cd /d "%~dp0"
node --test tests/cuda_bridge.test.mjs tests/cuda_fixture_plan.test.mjs tests/cuda_image_fixture.test.mjs
set "RESULT=%ERRORLEVEL%"
:finished
echo.
if "%RESULT%"=="0" (echo All host tests passed.) else (echo Test suite failed with exit code %RESULT%.)
pause
exit /b %RESULT%
