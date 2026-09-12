@echo off
rem start-shim-go.cmd — 启动 Go 版 shim（推荐；传输层指纹与内核一致 + 真会话）
rem 前置：TeleAgent 正在运行且已登录（真会话与 session.key 都依赖它）
setlocal
cd /d "%~dp0"

if not exist "teleagent-shim.exe" (
  echo [1/3] 没找到 teleagent-shim.exe，正在编译...
  call "%~dp0go\build.cmd"
  if errorlevel 1 exit /b 1
)

set PY=%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe
if not exist "%PY%" set PY=python
echo [2/3] 获取内核本地会话密钥（用于创建真实会话，可选但推荐）...
"%PY%" "%~dp0get-session-key.py"
if errorlevel 1 echo [!] 取密钥失败 —— shim 会退化为合成会话 ID（仍可用）

echo [3/3] 启动 Go 版 shim（后台隐藏）...
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0teleagent-shim.exe' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
echo.
echo 完成 -^> http://127.0.0.1:8788/v1   （模型: chat-pro / chat-lite / chat-flash）
echo 自检: curl http://127.0.0.1:8788/v1/models
echo.
