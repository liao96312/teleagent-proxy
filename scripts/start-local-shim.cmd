@echo off
rem start-local-shim.cmd — 方案 B：启动走 App 本地 server 的反代（127.0.0.1:8788）
rem 前置：TeleAgent 正在运行且已登录
setlocal
cd /d "%~dp0"
set PY=%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe
if not exist "%PY%" set PY=python
set NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe
if not exist "%NODE%" set NODE=%LOCALAPPDATA%\pi-node\current\node.exe
if not exist "%NODE%" set NODE=node

echo [1/2] 从 TeleAgent 进程中获取本地会话密钥...
"%PY%" "%~dp0get-session-key.py"
if errorlevel 1 (
  echo [!] 获取失败：请确认 TeleAgent 正在运行并已登录。
  pause
  exit /b 1
)

echo [2/2] 启动方案B shim（后台隐藏）...
powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'teleagent-local-shim.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
echo.
echo 完成 -^> http://127.0.0.1:8788/v1   （模型: chat-pro / chat-lite / chat-flash）
echo 自检: curl http://127.0.0.1:8788/v1/models
echo.
