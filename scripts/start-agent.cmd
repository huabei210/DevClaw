@echo off
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
if not exist "%ROOT%\dist\agent\index.js" (
  echo Missing "%ROOT%\dist\agent\index.js"
  echo Run: npm install ^&^& npm run build
  exit /b 1
)
if exist "%ROOT%\config\agent.json" set "FTB_AGENT_CONFIG=%ROOT%\config\agent.json"
node "%ROOT%\dist\agent\index.js"
