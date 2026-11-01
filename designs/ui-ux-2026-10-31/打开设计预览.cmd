@echo off
node "%~dp0tools\start-preview.cjs" --open
if errorlevel 1 (
  pause
  exit /b 1
)
