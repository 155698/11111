@echo off
REM Starter for MultiVoice web server (autostart)
set NODE="C:\Program Files\nodejs\node.exe"
set DIR=C:\Users\dimas\OneDrive\Документы\MultiTool\HomeChats\Chat-18\multitool-voice\server
set LOG=%DIR%\server.log

cd /d "%DIR%"
echo [%date% %time%] starting server >> "%LOG%"
%NODE% dist/index.cjs >> "%LOG%" 2>&1