@echo off
echo Starting OpenCodex...
:: Refresh path in case it was recently installed
for /f "tokens=2*" %%A in ('reg query "HKLM\System\CurrentControlSet\Control\Session Manager\Environment" /v Path') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path') do set "USR_PATH=%%B"
set "PATH=%SYS_PATH%;%USR_PATH%"

call npm start
pause
