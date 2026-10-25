@echo off
rem Portable service runner: every path derives from this file's own folder,
rem so the whole directory can be copied to another PC / another drive.
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "WORKDIR=%ROOT%\workbuddy-console-main"
if not exist "%WORKDIR%\server\index.mjs" set "WORKDIR=%ROOT%"
if not exist "%WORKDIR%\server\index.mjs" set "WORKDIR=%ROOT%\.."
set "LOG=%ROOT%\server-detached.log"

if not exist "%WORKDIR%\server\index.mjs" (
  echo [ERROR] server entry not found: %WORKDIR%\server\index.mjs>> "%LOG%"
  exit /b 1
)
cd /d "%WORKDIR%"

rem ---- locate node.exe: portable copy -> PATH -> WorkBuddy managed runtime ----
set "NODE="
if exist "%ROOT%\node\node.exe" set "NODE=%ROOT%\node\node.exe"
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE (
  echo [ERROR] node.exe not found. Put node.exe into %ROOT%\node\ or install Node.js>> "%LOG%"
  exit /b 1
)

echo. >> "%LOG%"
echo ===== start %DATE% %TIME% =====>> "%LOG%"
echo [svc] root=%ROOT%>> "%LOG%"
whoami /groups 2>nul | findstr /C:"S-1-16-12288" >nul && (echo [svc] elevated=yes>> "%LOG%") || (echo [svc] elevated=no>> "%LOG%")

"%NODE%" --max-old-space-size=6144 server\index.mjs >> "%LOG%" 2>&1
