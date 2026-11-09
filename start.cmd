@echo off
setlocal
cd /d "%~dp0"
title AlgoView - Local Service

echo.
echo   Algorithm Visualizer - starting...
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

if not exist "node_modules" (
  echo   [1/2] Installing dependencies, first run only...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto FAIL
)

if not exist "dist\index.html" (
  echo   [2/2] Building the web app...
  call npm run build
  if errorlevel 1 goto FAIL
)

node "server\bridge.cjs"
echo.
echo   Server stopped. Press any key to close.
pause >nul
exit /b 0

:NONODE
echo   [x] Node.js not found. Please install Node.js 18+ from https://nodejs.org
echo.
pause
exit /b 1

:FAIL
echo.
echo   [x] Setup failed. Please check the error above.
echo.
pause
exit /b 1
