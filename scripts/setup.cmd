@echo off
rem setup.cmd — 一键初始化（解 AES key）
setlocal
set PY=%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe
if not exist "%PY%" set PY=python
echo === 使用 Python: %PY% ===
"%PY%" "%~dp0setup.py"
echo.
pause
