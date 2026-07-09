@echo off
echo ====================================================
echo  OpenCodex Windows One-Click Setup
echo ====================================================
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js not found. Installing via winget...
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install Node.js. Please install it manually.
        pause
        exit /b %errorlevel%
    )
) else (
    echo Node.js is already installed.
)

:: Check for .NET 8 SDK
where dotnet >nul 2>&1
if %errorlevel% neq 0 (
    echo .NET 8 SDK not found. Installing via winget...
    winget install --id Microsoft.DotNet.SDK.8 -e --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install .NET 8 SDK. Please install it manually.
        pause
        exit /b %errorlevel%
    )
) else (
    echo .NET 8 SDK is already installed.
)

echo.
echo Refreshing environment variables...
:: Refresh Path for the current session
for /f "tokens=2*" %%A in ('reg query "HKLM\System\CurrentControlSet\Control\Session Manager\Environment" /v Path') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path') do set "USR_PATH=%%B"
set "PATH=%SYS_PATH%;%USR_PATH%"

echo.
echo Installing npm packages and compiling native dependencies...
call npm install

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed. Please verify your Node.js and .NET SDK installations.
    pause
    exit /b %errorlevel%
)

echo.
echo ====================================================
echo  Setup Completed Successfully!
echo  You can now start OpenCodex by running start.bat
echo ====================================================
pause
