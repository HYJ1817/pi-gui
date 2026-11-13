@echo off
REM P3-C local trial from source (Electron window). Not the verified artifact entry.
setlocal
set "PI_GUI_TERMINAL_JOB_OBJECT=1"
cd /d "%~dp0..\.."
call npm run app
endlocal
