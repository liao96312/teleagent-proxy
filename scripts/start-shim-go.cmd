@echo off
rem start-shim-go.cmd — 启动 Go 版方案A shim（传输层指纹与内核一致）
setlocal
cd /d "%~dp0"
if not exist "teleagent-shim.exe" (
  echo [!] 没找到 teleagent-shim.exe，正在编译...
  call "%~dp0go\build.cmd"
  if errorlevel 1 exit /b 1
)
echo 启动 Go 版 shim（后台隐藏）...
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0teleagent-shim.exe' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
echo.
echo 完成 -^> http://127.0.0.1:8788/v1   （模型: chat-pro / chat-lite / chat-flash）
echo 自检: curl http://127.0.0.1:8788/v1/models
echo.
