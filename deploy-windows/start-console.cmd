@echo off
rem =====================================================================
rem  Portable console launcher.
rem  Every path derives from this file's own folder, so the directory can
rem  be copied to another PC / another drive without editing anything.
rem  Usage: double-click this file (or the desktop shortcut pointing to it).
rem =====================================================================
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "PORT=57911"
set "URL=http://127.0.0.1:%PORT%"
set "TASK=WorkBuddyConsole"
set "VBS=%ROOT%\hidden-run.vbs"
set "LOG=%TEMP%\wbc-launch.log"
set "XML=%TEMP%\wbc-task.xml"
set "ROOTFILE=%USERPROFILE%\.wbc-console-root"

rem remember where this copy lives (desktop wrapper reads it)
> "%ROOTFILE%" echo %ROOT%

echo ==== %DATE% %TIME% root=%ROOT% ====>> "%LOG%"

rem 1) already running -> just open the page
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [1] service already running>> "%LOG%"
  goto OPEN
)
echo [1] service not running>> "%LOG%"

if not exist "%VBS%" (
  echo [X] missing %VBS%>> "%LOG%"
  echo [ERROR] hidden-run.vbs not found next to this file.
  pause
  exit /b 1
)

rem 2) registered task? run it (highest privileges, no UAC)
schtasks /query /tn "%TASK%" /xml > "%XML%" 2>nul
if errorlevel 1 (
  echo [2] task missing>> "%LOG%"
  goto NEED_ADMIN
)
findstr /C:"hidden-run.vbs" "%XML%" >nul 2>&1
if errorlevel 1 (
  echo [2] task points to an old path, re-registering>> "%LOG%"
  goto NEED_ADMIN
)
echo [2] task ok, running it>> "%LOG%"
schtasks /run /tn "%TASK%" >nul 2>&1
goto WAIT

rem 3) one-time admin step (also used when the folder was moved)
:NEED_ADMIN
net session >nul 2>&1
if errorlevel 1 (
  echo [3] not admin, elevating>> "%LOG%"
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)
echo [3] admin: registering task for %ROOT%>> "%LOG%"
schtasks /create /tn "%TASK%" /tr "wscript.exe %VBS%" /sc ONLOGON /rl HIGHEST /f >> "%LOG%" 2>&1
echo [3] starting service directly (hidden)>> "%LOG%"
wscript.exe "%VBS%"

:WAIT
set /a N=0
:WAITLOOP
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto OPEN
set /a N+=1
if %N% GEQ 30 goto FAIL
timeout /t 1 /nobreak >nul
goto WAITLOOP

:OPEN
echo [4] opening page>> "%LOG%"
explorer.exe "%URL%"
exit /b 0

:FAIL
echo [4] timeout waiting for port>> "%LOG%"
echo.
echo [ERROR] service did not start in 30 seconds
echo launch log  : %LOG%
echo server log  : %ROOT%\server-detached.log
echo.
pause
exit /b 1
