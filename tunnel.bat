@echo off
rem Publishes the dashboard on the internet through a free Cloudflare quick tunnel (HTTPS).
rem Run start.bat first, then this. Look for the https://....trycloudflare.com address below.
rem The address changes each time this runs.
cd /d "%~dp0"
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared is not installed. Install it with:
  echo     winget install --id Cloudflare.cloudflared
  echo then open a new terminal and run tunnel.bat again.
  pause
  exit /b 1
)
cloudflared tunnel --url http://localhost:8765
