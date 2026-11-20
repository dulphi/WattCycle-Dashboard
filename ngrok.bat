@echo off
setlocal
rem Publishes the WattCycle dashboard on the internet through ngrok (HTTPS).
rem Remote visitors get the read-only live view and must enter the password from config.json.
rem
rem NOTE: this file is called ngrok.bat, so the real program is always called as "ngrok.exe".
rem       Plain "ngrok" would make this script run itself over and over.

rem Your free static ngrok domain (https://dashboard.ngrok.com/domains). Set it once with:
rem     setx NGROK_URL https://your-name.ngrok-free.app
rem If it is not set, ngrok picks a random address that changes every run.
set "PORT=8765"
cd /d "%~dp0"

rem --- 1. ngrok installed? -------------------------------------------------
where ngrok.exe >nul 2>nul
if errorlevel 1 (
  echo ngrok is not installed. Install it with:
  echo     winget install --id Ngrok.Ngrok
  echo then add your token once:  ngrok.exe config add-authtoken YOUR_TOKEN
  echo ^(token: https://dashboard.ngrok.com/get-started/your-authtoken^)
  pause
  exit /b 1
)

rem --- 2. ngrok signed in? -------------------------------------------------
ngrok.exe config check >nul 2>nul
if errorlevel 1 (
  echo ngrok has no valid config. Add your token once:
  echo     ngrok.exe config add-authtoken YOUR_TOKEN
  pause
  exit /b 1
)

rem --- 3. remote password set? ---------------------------------------------
if not defined WATTCYCLE_PASSWORD (
  findstr /c:"\"remotePassword\"" config.json >nul 2>nul
  if errorlevel 1 (
    echo No remote password is set, so the dashboard would refuse every visitor.
    echo Add  "remotePassword": "something-long"  to config.json, restart start.bat, then run this again.
    pause
    exit /b 1
  )
)

rem --- 4. dashboard server running? Start it if not. -----------------------
curl.exe -s -o nul http://localhost:%PORT%/api/session
if errorlevel 1 (
  echo Dashboard server is not running - starting it with start.bat ...
  start "WattCycle server" cmd /c start.bat
  for /l %%i in (1,1,20) do (
    curl.exe -s -o nul http://localhost:%PORT%/api/session && goto :server_ok
    timeout /t 1 /nobreak >nul
  )
  echo The dashboard server did not start. Run start.bat and check its window for errors.
  pause
  exit /b 1
)
:server_ok

rem --- 5. open the tunnel --------------------------------------------------
echo.
if defined NGROK_URL (echo   Dashboard is live at:  %NGROK_URL%) else (echo   Look for the "Forwarding https://..." address below.)
echo   Keep the dashboard window on this PC open; it is the Bluetooth link to the battery.
echo   Press Ctrl+C to stop sharing.
echo.
if defined NGROK_URL (
  ngrok.exe http %PORT% --url %NGROK_URL%
) else (
  ngrok.exe http %PORT%
)
