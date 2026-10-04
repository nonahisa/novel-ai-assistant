@echo off
rem Build a VSIX for quick local testing (no release gates).
rem Messages are printed by scripts\quickVsix.mjs in Japanese.
rem Keep this file ASCII-only and CRLF: cmd.exe reads .bat in the system
rem code page, so UTF-8 Japanese here would be garbled.
setlocal
cd /d "%~dp0"
rem Started from a VS Code terminal, this variable makes child Electron
rem processes exit immediately.
set ELECTRON_RUN_AS_NODE=
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and try again.
  pause
  exit /b 1
)
node scripts\quickVsix.mjs
set RESULT=%ERRORLEVEL%
rem Keep the window open when started by double-click.
pause
exit /b %RESULT%
