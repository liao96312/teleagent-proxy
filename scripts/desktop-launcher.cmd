@echo off
rem ============================================================
rem  启动 TeleAgent 反代 shim（Go 版，推荐）
rem  双击即可。会自动：编译(首次) -> 解 AES key -> 取会话密钥 -> 启动 -> 自检
rem ============================================================
setlocal
set "REPO=%USERPROFILE%\Desktop\teleagent-proxy"
set "SCRIPT=%REPO%\scripts"
set "PY=%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe"
if not exist "%PY%" set "PY=python"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"

if not exist "%SCRIPT%\go\main.go" (
  echo [X] 找不到仓库目录: %SCRIPT%
  echo     请确认 teleagent-proxy 在桌面上。
  pause
  exit /b 1
)
cd /d "%SCRIPT%"

echo ============================================
echo   TeleAgent 反代 shim 启动
echo ============================================
echo.

%PS% "if (Get-Process TeleAgent -ErrorAction SilentlyContinue) { Write-Host '[ok] TeleAgent 正在运行' } else { Write-Host '[!] TeleAgent 没在运行。'; Write-Host '    仍能启动，但 X-Session-Id 会是合成 ID（不是内核真会话）。'; Write-Host '    建议先打开 TeleAgent 并登录。' }"
echo.

if not exist "teleagent-shim.exe" (
  echo [1/4] 首次运行，编译 Go 版...
  call "%SCRIPT%\go\build.cmd"
  if errorlevel 1 ( echo [X] 编译失败 & pause & exit /b 1 )
) else (
  echo [1/4] teleagent-shim.exe 已存在，跳过编译
)

if exist "token.key" (
  echo [2/4] token.key 已存在，跳过
) else (
  echo [2/4] 解出 safeStorage AES key...
  "%PY%" "setup.py"
)

echo [3/4] 获取内核本地会话密钥...
"%PY%" "get-session-key.py"
if errorlevel 1 echo [!] 取密钥失败 —— 会话 ID 会退化为合成 ID（功能不受影响）

echo [4/4] 启动 shim...
%PS% "Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" 2>nul
%PS% "Start-Process -FilePath '%SCRIPT%\teleagent-shim.exe' -WorkingDirectory '%SCRIPT%' -WindowStyle Hidden"
%PS% "Start-Sleep -Seconds 2"

echo.
echo --- 自检 ---
%PS% "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8788/v1/models' -TimeoutSec 15 -UseBasicParsing; Write-Host ('[ok] ' + $r.Content.Substring(0,90)) } catch { Write-Host ('[X] 自检失败: ' + $_.Exception.Message) }"

echo.
echo 完成 -^> http://127.0.0.1:8788/v1
echo pi 里选 teleagent / chat-pro 即可
echo.
pause
