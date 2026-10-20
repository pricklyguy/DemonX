@echo off
rem Starts DemonX and opens it in your browser. Close this window to stop DemonX.
rem   Start DemonX.bat            start and open the browser
rem   Start DemonX.bat nobrowser  start without opening the browser (used by "Start at login")
setlocal
cd /d "%~dp0"
title DemonX CNC Controller

if not defined PORT set PORT=8080
set "DEMONX_DATA=%~dp0data"

if /i not "%~1"=="nobrowser" start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 4; Start-Process 'http://localhost:%PORT%'"

echo DemonX is starting on http://localhost:%PORT%
echo Your settings and saved files are in: %DEMONX_DATA%
echo Leave this window open while you use DemonX. Close it to stop DemonX.
echo.
rem launcher.mjs starts the version named in current.txt, and again after an update (Settings > Updates > Update now)
"%~dp0node\node.exe" "%~dp0launcher.mjs" cnc
echo.
echo DemonX has stopped. If that was not expected, the message above says why.
pause
