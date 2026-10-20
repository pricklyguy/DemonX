@echo off
rem Undoes "Start at login.bat".
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -ErrorAction SilentlyContinue ([Environment]::GetFolderPath('Startup')+'\DemonX.lnk')"
echo Done. DemonX will no longer start by itself.
pause
