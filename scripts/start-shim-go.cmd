@echo off
rem start-shim-go.cmd - 启动 Go 版 shim（推荐：传输层指纹与内核一致）
rem
rem 默认模式：不依赖 TeleAgent 是否运行，会话 ID 用精确复刻的本地算法生成。
rem 如需向内核建"真会话"，设 TA_REAL_SESSION=1（那时才需要 App 运行 + session.key）。
setlocal
cd /d "%~dp0"

if not exist "teleagent-shim.exe" (
  echo [1/3] 没找到 teleagent-shim.exe，正在编译...
  call "%~dp0go\build.cmd"
  if errorlevel 1 exit /b 1
)

if "%TA_REAL_SESSION%"=="1" (
  set "PY=%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe"
  if not exist "%PY%" set "PY=python"
  echo [2/3] TA_REAL_SESSION=1 -^> 获取内核本地会话密钥...
  "%PY%" "%~dp0get-session-key.py"
) else (
  echo [2/3] 默认模式：本地生成精确会话 ID（不依赖 App）
)

echo [3/3] 启动 Go 版 shim（后台隐藏）...
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0teleagent-shim.exe' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
echo.
echo 完成 -^> http://127.0.0.1:8788/v1   （模型: chat-pro / chat-lite / chat-flash）
echo 自检: curl http://127.0.0.1:8788/v1/models
echo.
