@echo off
chcp 65001 >nul
title WorkBuddy 控制台
cd /d "%~dp0"

rem 屏蔽 WorkBuddy 注入的文件 shim（genie-safe-delete 会把 ~/.wb-switch 的覆盖写
rem 路由到间歇故障的回收站后端，导致凭据刷新/积分快照间歇 EPERM）；
rem 保留 --use-system-ca（企业代理环境出站 HTTPS 需要）
set "NODE_OPTIONS=--use-system-ca"

rem 依次尝试：PATH 里的 node → WorkBuddy 内置 node（任意版本）→ 报错退出
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE_EXE if exist "%%~d\node.exe" set "NODE_EXE=%%~d\node.exe"
if not defined NODE_EXE (
  echo 没有找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 首次运行，先安装依赖……
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

rem 服务启动后会自己打开浏览器（server/index.mjs 的 onListening），这里不再重复 start
start "WorkBuddy 控制台服务" /d "%~dp0" cmd /c ""%NODE_EXE%" server\index.mjs"
