@echo off
rem Starts DemonX Design (design, and control of a laser) and opens it in your browser. Close this window to stop it.
rem   Start DemonX Design.bat            start and open the browser
rem   Start DemonX Design.bat nobrowser  start without opening the browser
rem Settings for this computer (the laser's address, the power limit, who may connect) go in design.env next to this file:
rem one NAME=value per line. See "design settings example.txt".
setlocal
cd /d "%~dp0"
title DemonX Design

set "DESIGN_DATA=%~dp0data\design"
rem the same PIN, and the same Home Assistant setup, as DemonX CNC on this computer
set "DESIGN_AUTH_DIR=%~dp0data"
set "DESIGN_CNC_DATA=%~dp0data"
if exist "%~dp0design.env" for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0design.env") do set "%%a=%%b"
if not defined DESIGN_PORT set DESIGN_PORT=8090

if /i not "%~1"=="nobrowser" start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 4; Start-Process 'http://localhost:%DESIGN_PORT%'"

echo DemonX Design is starting on http://localhost:%DESIGN_PORT%
echo Your lasers, library and settings are in: %DESIGN_DATA%
echo Leave this window open while you use DemonX Design. Close it to stop it.
echo.
rem the same version as DemonX (current.txt). After an update, close this window and start it again to use the new version.
"%~dp0node\node.exe" "%~dp0launcher.mjs" design
echo.
echo DemonX Design has stopped. If that was not expected, the message above says why.
pause
