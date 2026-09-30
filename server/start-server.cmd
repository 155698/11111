@echo off
setlocal
set NODE=node
set DIR=C:\Users\dimas\OneDrive\Документы\MultiTool\HomeChats\Chat-18\multitool-voice\server
set PORT=3000

cd /d "%DIR%"

REM If port is already listening, do not start a second copy
netstat -an | findstr /R /C:":%PORT% .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  exit /b 0
)

start "" "%NODE%" dist/index.cjs --port %PORT%
exit /b 0