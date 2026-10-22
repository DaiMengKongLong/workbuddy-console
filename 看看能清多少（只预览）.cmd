@echo off
chcp 65001 >nul
title 看看能清多少（只预览，不删东西）
cd /d "%~dp0"

rem 依次尝试：PATH 里的 node → WorkBuddy 内置 node（任意版本）→ 报错退出
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE_EXE if exist "%%~d\node.exe" set "NODE_EXE=%%~d\node.exe"
if not defined NODE_EXE (
  echo 没有找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

"%NODE_EXE%" "归档并清理.mjs" --plan
echo.
echo 上面就是清单。这一步没有删除任何东西。
pause
