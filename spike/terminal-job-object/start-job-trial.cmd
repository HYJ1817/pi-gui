@echo off
REM P3-C local trial: launch the built desktop artifact with Job mode ON.
REM Close the window / quit the app to stop. Unset the variable to return to P3-B.
setlocal
if not exist "%~dp0..\..\build\Pi GUI.exe" (
  echo Missing build artifact: build\Pi GUI.exe
  echo Run: npm run build:exe
  exit /b 1
)
set "PI_GUI_TERMINAL_JOB_OBJECT=1"
start "" "%~dp0..\..\build\Pi GUI.exe"
endlocal
