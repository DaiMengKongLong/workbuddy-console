@echo off
chcp 65001 >nul
title 一键整理并清理
cd /d "%~dp0"
echo ============================================
echo  第一步：合并内容重复的对话
echo  第二步：把要删的备份到 D 盘并核对
echo  第三步：删除本地文件、旧日志、缓存
echo ============================================
echo.

rem 依次尝试：PATH 里的 node → WorkBuddy 内置 node（任意版本）→ 报错退出
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE_EXE if exist "%%~d\node.exe" set "NODE_EXE=%%~d\node.exe"
if not defined NODE_EXE (
  echo 没有找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

"%NODE_EXE%" "汇总后自动整理.mjs"
echo.
echo 做完。详细记录在同目录的 cleanup.log 里。
pause
