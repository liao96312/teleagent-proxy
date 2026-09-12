@echo off
rem build.cmd — 编译 Go 版 shim（需要 go1.26.x，尽量与内核同版本）
rem 本机 Go 路径：%USERPROFILE%\.local\share\go-toolchain\go\bin
setlocal
cd /d "%~dp0"
set GO=%USERPROFILE%\.local\share\go-toolchain\go\bin\go.exe
if not exist "%GO%" set GO=go
if not exist go.mod (
  echo module teleagent-shim> go.mod
  echo.>> go.mod
  echo go 1.26>> go.mod
)
echo === 使用 Go: %GO% ===
"%GO%" version
"%GO%" build -o ..\teleagent-shim.exe .
if errorlevel 1 ( echo [!] 编译失败 & pause & exit /b 1 )
echo.
echo [+] 生成 ..\teleagent-shim.exe
