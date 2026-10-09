@echo off
rem Set or change the access PIN without opening DemonX.
rem   Set PIN.bat           asks for a PIN
rem   Set PIN.bat --open    run without a PIN (browsers on your home network can control the machine)
rem   Set PIN.bat --show    say what is set
rem A running DemonX notices the change within a second.
setlocal
cd /d "%~dp0"
set "DEMONX_DATA=%~dp0data"
"%~dp0node\node.exe" "%~dp0app\set-pin.mjs" %*
echo.
pause
