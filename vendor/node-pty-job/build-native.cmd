@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
if "%P3C_VSDEVCMD%"=="" set "P3C_VSDEVCMD=%ProgramFiles(x86)%\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat"
if "%P3C_NODE_GYP_HOOK%"=="" set "P3C_NODE_GYP_HOOK=%ProgramFiles%\nodejs\node_modules\npm\node_modules\node-gyp\src\win_delay_load_hook.cc"
set "CACHE=%LOCALAPPDATA%\node-gyp\Cache\24.22.1"
if "%~1"=="" (
  echo Usage: build-native.cmd ^<existing output directory^>
  exit /b 1
)
pushd "%~1" || exit /b 1
call "%P3C_VSDEVCMD%" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b 1
cl /nologo /EHsc /std:c++17 /O2 /MD /LD /DNAPI_CPP_EXCEPTIONS /DHOST_BINARY=\"node.exe\" /DNODE_GYP_MODULE_NAME=conpty /I "%CACHE%\include\node" /I "%ROOT%\node_modules\node-addon-api" /I "%ROOT%\node_modules\node-pty\src\win" "%~dp0src\win\conpty.cc" "%ROOT%\node_modules\node-pty\src\win\path_util.cc" "%P3C_NODE_GYP_HOOK%" /link /DELAYLOAD:node.exe delayimp.lib shlwapi.lib kernel32.lib /LIBPATH:"%CACHE%\x64" node.lib /OUT:conpty.node
set "BUILD_RESULT=%ERRORLEVEL%"
popd
exit /b %BUILD_RESULT%
