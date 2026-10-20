@echo off
rem Makes DemonX start by itself, minimised, when you sign in to Windows.
setlocal
cd /d "%~dp0"
echo DemonX will start by itself when you sign in to Windows.
echo.
echo Should it also open DemonX in the browser each time?
echo   Y = yes: for a computer you sit at, wired to the machine.
echo   N = no:  for a computer nobody sits at, used from other devices.
choice /c YN /n /m "Open the browser at login? [Y/N] "
set "ARGS="
if errorlevel 2 set "ARGS=nobrowser"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\DemonX.lnk'); $s.TargetPath='%~dp0Start DemonX.bat'; $s.Arguments='%ARGS%'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (echo Could not set it up. & pause & exit /b 1)
echo.
echo Done. DemonX will start by itself the next time you sign in to Windows.
echo To change your answer, run this file again. To undo it, run "Stop starting at login.bat".
pause
