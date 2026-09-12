@echo off
rem start-shim.cmd — 启动 TeleAgent 反代 shim（本地 OpenAI 兼容接口, 127.0.0.1:8788）
setlocal
set NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe
if not exist "%NODE%" set NODE=%LOCALAPPDATA%\pi-node\current\node.exe
if not exist "%NODE%" set NODE=node
echo === 使用 Node: %NODE% ===
powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'teleagent-shim.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
echo teleagent-shim 已启动 -> http://127.0.0.1:8788/v1
echo.
echo 提示: 若想确认是否成功，可访问 http://127.0.0.1:8788/v1/models
