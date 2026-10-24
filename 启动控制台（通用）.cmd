@echo off
chcp 65001 >nul
title WorkBuddy 控制台
cd /d "%~dp0"

rem 屏蔽 WorkBuddy 注入的文件 shim（genie-safe-delete 会把 ~/.wb-switch 的覆盖写
rem 路由到间歇故障的回收站后端，导致凭据刷新/积分快照间歇 EPERM）；
rem 保留 --use-system-ca（企业代理环境出站 HTTPS 需要）
set "NODE_OPTIONS=--use-system-ca"

set "WB_PORT=57911"

rem 已有实例在跑：直接打开页面，不再起第二个进程
rem （此前没有这道检查，第二次双击必然 EADDRINUSE 崩溃 + 窗口立刻关闭，表现为"启动不了"）
netstat -ano | findstr ":%WB_PORT% " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo 控制台已在运行（端口 %WB_PORT%），正在打开页面……
  start "" "http://127.0.0.1:%WB_PORT%"
  exit /b 0
)

rem 依次尝试：PATH 里的 node → WorkBuddy 内置 node（版本目录倒序取最新）→ 报错退出
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE for /f "delims=" %%d in ('dir /b /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%d\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%d\node.exe"
if not defined NODE_EXE (
  echo 没有找到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

rem 版本闸门：服务端用到 node:sqlite 等 Node 22+ 能力，低版本会直接崩
"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>nul
if errorlevel 1 (
  echo 当前 Node 版本过低：%NODE_EXE%
  "%NODE_EXE%" -v
  echo 需要 Node.js 22 或更高版本，请安装后再运行。
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

rem 服务启动后会自己打开浏览器（server/index.mjs 的 onListening），这里不再重复 start。
rem 末尾的 || pause 是关键：面板开局失败时窗口停住，能看到真实报错而不是一闪而过。
start "WorkBuddy 控制台服务" /d "%~dp0" cmd /c ""%NODE_EXE%" server\index.mjs || (echo. & echo 启动失败：请复制上方报错发出来 & pause)
