@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Pi GUI

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js
  echo   请先安装：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\pdfjs-dist" (
  echo.
  echo   首次运行，正在安装依赖，请稍候…
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败，请检查网络
    pause
    exit /b 1
  )
)

set PI_GUI_OPEN=1
node server.js

echo.
echo   服务已停止。
pause
