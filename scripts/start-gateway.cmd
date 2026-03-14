@echo off
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
if not exist "%ROOT%\dist\gateway\index.js" (
  echo Missing "%ROOT%\dist\gateway\index.js"
  echo Run: npm install ^&^& npm run build
  exit /b 1
)
if exist "%ROOT%\config\gateway.json" set "FTB_GATEWAY_CONFIG=%ROOT%\config\gateway.json"
node "%ROOT%\dist\gateway\index.js"
