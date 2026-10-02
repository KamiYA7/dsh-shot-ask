@echo off
REM Launch the desktop capture ball.
REM
REM DSH_HOME decides WHICH DSH instance the ball submits to: the bridge plugin
REM publishes its port and token to %DSH_HOME%\dsh-shot-bridge.json. The Desktop
REM app owns %USERPROFILE%\.dsh; the web launcher (start-dsh.bat) owns
REM G:\ZM\DSH\.dsh. Set DSH_HOME before running this script to pick the other.
setlocal
REM DSH's own processes run Electron in Node mode, and a shell that inherited that
REM flag would start the ball as plain Node — where require('electron').app is
REM undefined and it crashes before drawing a window.
set "ELECTRON_RUN_AS_NODE="
if "%DSH_HOME%"=="" set "DSH_HOME=%USERPROFILE%\.dsh"
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
endlocal
