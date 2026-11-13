@echo off
setlocal
rem P3-C0 test-only spike build. Offline: uses the local MSVC/SDK and the
rem node-gyp header cache, no package installation or network access.
cd /d "%~dp0"
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1

set "CACHE=%LOCALAPPDATA%\node-gyp\Cache\24.22.1"
rem node-gyp's delay-load hook: resolve the node.exe import to the actual host
rem (node.exe or electron.exe). Without it the addon cannot load in Electron.
set "GYP_HOOK=C:\Program Files\nodejs\node_modules\npm\node_modules\node-gyp\src\win_delay_load_hook.cc"

cl /nologo /W4 /EHsc /std:c++17 /O2 /MD /LD /D_WIN32_WINNT=0x0A00 /DHOST_BINARY=\"node.exe\" /I "%CACHE%\include\node" lifecycle-spike.cc "%GYP_HOOK%" /link /DELAYLOAD:node.exe delayimp.lib /LIBPATH:"%CACHE%\x64" node.lib /OUT:lifecycle-spike.node
if errorlevel 1 exit /b 1

cl /nologo /W4 /EHsc /std:c++17 /O2 /D_WIN32_WINNT=0x0A00 win32-spike.cpp /link /OUT:win32-spike.exe
if errorlevel 1 exit /b 1

echo build ok
