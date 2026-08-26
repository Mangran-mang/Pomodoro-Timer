@echo off
rem ============================================
rem  Tomato Clock - Launcher
rem  NOTE: ASCII-only on purpose. Chinese text in
rem  this file would be misread by cmd.exe (GBK
rem  codepage) and break double-click launching.
rem ============================================
pushd "%~dp0" >nul

set "EXE=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%EXE%" (
    echo [ERROR] Electron runtime not found.
    echo Please run:  npm install
    echo Then double-click this file again.
    pause
    exit /b 1
)

rem launch app detached (app dir passed explicitly)
set "APP=%~dp0"
set "APP=%APP:~0,-1%"
start "" "%EXE%" "%APP%"
exit /b 0
