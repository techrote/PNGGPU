@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo.
echo ==== PNG2ANSI-GPU007 : complete installation ====
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
    echo.
    echo Installation failed. Read the error above; see README_FIRST.md.
    pause
)
exit /b %RESULT%
