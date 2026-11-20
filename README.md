# WattCycle Battery Monitor

A live dashboard for **WattCycle LiFePO₄ batteries** (and other packs with the TDT Bluetooth BMS). It reads the battery directly over Bluetooth from a Windows PC, keeps a 30-minute history in a small database, and can be shared over the internet as a password-protected, read-only page.

No cloud account, no phone app, and no `npm install`. It is one HTML page and one Node.js script.

## Screenshots

**On the PC next to the battery** (full controls, here in demo mode with the History panel on *Week*):

![Dashboard on the local PC](docs/screenshots/local.png)

**Remote view through a tunnel** (after entering the password; read-only, so the connection controls and Bluetooth log are hidden, and History is on *Day*):

![Read-only remote view](docs/screenshots/remote.png)

<sub>Screenshots use the built-in demo data and sample history, not a real battery. The page follows your system's light or dark theme.</sub>

## Features

- **Live readings:** state of charge, pack voltage, cell voltages, temperatures, cycles, health, and MOSFET/protection status.
- **Charge and discharge side by side:** amps and watts going into and out of the battery, with running Ah/Wh totals for both directions.
- **Trend chart** of current, voltage, power or SOC for the last hour or so.
- **History by day, week or month**, saved as one summary row every 30 minutes (about 3 MB a year). It shows energy in and out per period, SOC, voltage, current and temperature, and exports to CSV.
- **Auto-connect:** reconnects to the last battery when started and retries if it goes out of range.
- **Remote viewing** through a Cloudflare or ngrok tunnel, behind a password.
- **Demo mode** to try the dashboard without a battery.

## How it works

```
 Battery ──Bluetooth LE──▶ Edge/Chrome window on the PC ──▶ serve.js ──▶ history.db
                           (http://localhost:8765)          │
                                                            └──▶ tunnel (optional) ──▶ phones / other PCs
                                                                                       (read-only, password)
```

- The **browser window on the PC** talks to the battery using Web Bluetooth. It is the only part that touches the battery, so it must stay open.
- **`serve.js`** serves the page, saves settings to `config.json`, stores the 30-minute history in `history.db`, and relays live readings to remote viewers.
- **Remote viewers** connect through a tunnel. Their browser can't reach a battery next to your PC, so they get a live, read-only copy of what the PC window sees.

> **This can't be hosted on a cloud server, GitHub Pages or Vercel.** Bluetooth range is about 10 m, so the program must run on a computer near the battery. "Deploying" here means setting up that PC and, if you want, a tunnel so you can watch from anywhere.

## Requirements

| What | Notes |
| --- | --- |
| Windows 10 or 11 PC with Bluetooth LE | Within about 10 m of the battery. A small always-on mini PC or laptop works well. |
| [Node.js](https://nodejs.org) **22.5 or newer** | The history database uses SQLite built into Node 22.5+. On older versions the dashboard still works, but history is turned off. |
| Microsoft Edge or Google Chrome | Needed for Web Bluetooth. Firefox and Safari don't support it. |
| A WattCycle battery with Bluetooth | Names usually start with `WT`, `HS`, `XDZN` or `WattCycle`. |

> **Close the WattCycle phone app.** The battery accepts only one Bluetooth connection at a time. If the phone is connected, the dashboard gets no answer.

macOS and Linux should work by running `node serve.js --open` directly, but only Windows has been tested and only Windows has the `.bat` helpers.

---

## Deployment guide

### 1. Install Node.js

Open **PowerShell** and run:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell, then check the version is 22.5 or newer:

```powershell
node --version
```

### 2. Download the dashboard

With Git:

```powershell
git clone https://github.com/<your-user>/WattCycle-Dashboard.git
cd WattCycle-Dashboard
```

Or click **Code → Download ZIP** on GitHub and extract it to a folder such as `C:\WattCycle-Dashboard`.

### 3. Create your settings file

Copy the example file:

```powershell
copy config.example.json config.json
```

Open `config.json` in Notepad and change `remotePassword` to a long password of your own. You only need this for remote viewing. If you'll only use the dashboard on this PC, you can delete that line.

> `config.json` is listed in `.gitignore`, so your password is never uploaded to GitHub.

### 4. Start it and connect the battery

Double-click **`start.bat`**.

This starts the server and opens the dashboard in its own Edge or Chrome window, with a separate browser profile that allows silent reconnecting.

1. Click **Connect battery**.
2. Choose your battery from the list. If it isn't listed, tick **Show all devices** and try again.
3. Readings appear within a few seconds.

From now on the dashboard reconnects to that battery on its own each time `start.bat` runs. Leave the black server window and the dashboard window open.

Want to look around first? Click **Demo data**. Demo readings are never saved to the history.

### 5. Keep it running (recommended)

History is only recorded while the dashboard window is open and connected. For around-the-clock monitoring:

- **Start automatically when you sign in:** press `Win + R`, type `shell:startup`, press Enter, and put a **shortcut** to `start.bat` in the folder that opens.
- **Stop the PC from sleeping:** Settings → System → Power → set *Sleep* to **Never** (at least when plugged in).
- **Sign in automatically after a power cut (optional):** turn on automatic sign-in for this PC, or use a PC that is always signed in. The browser window needs a signed-in desktop session.
- Minimising the dashboard window is fine. `start.bat` launches the browser with background throttling turned off, so readings keep flowing.

### 6. View it from anywhere (optional)

Remote access goes through a **tunnel**: a small program on the PC that gives the dashboard a public `https://` address without opening ports on your router. Remote visitors must enter the `remotePassword` from `config.json`. Any user name works. After 10 wrong attempts, the visitor's IP address is locked out for 15 minutes.

Pick one of the two options below.

#### Option A: Cloudflare quick tunnel (free, no account)

```powershell
winget install --id Cloudflare.cloudflared
```

Then run **`tunnel.bat`** (with `start.bat` already running). Look for a line like:

```
https://random-words-here.trycloudflare.com
```

Open that address on your phone. **The address changes every time** you run `tunnel.bat`.

#### Option B: ngrok with a fixed address (free account)

1. Sign up at [ngrok.com](https://ngrok.com), then install ngrok:
   ```powershell
   winget install --id Ngrok.Ngrok
   ```
2. Add your auth token (from the ngrok dashboard → *Your Authtoken*):
   ```powershell
   ngrok.exe config add-authtoken YOUR_TOKEN
   ```
3. Claim your free static domain in the ngrok dashboard (*Domains*) and save it once:
   ```powershell
   setx NGROK_URL https://your-name.ngrok-free.app
   ```
   Open a new terminal afterwards so the setting takes effect.
4. Run **`ngrok.bat`**. It checks the setup, starts the dashboard if it isn't running, and opens the tunnel. The address stays the same every time, so you can bookmark it on your phone.

If you skip step 3, ngrok uses a random address each run.

> To have the tunnel start at sign-in too, put a shortcut to `tunnel.bat` or `ngrok.bat` in the `shell:startup` folder as well.

### 7. Updating

```powershell
git pull
```

Then close the server window and run `start.bat` again. Your `config.json` and `history.db` are kept.

---

## Configuration

Settings are saved in `config.json` next to `serve.js`. Most are written by the dashboard itself when you change them on the page.

| Key | Set by | Meaning |
| --- | --- | --- |
| `remotePassword` | you, by hand | Password for remote viewers. If missing, remote access is turned off. The page never reads or changes it. |
| `deviceId`, `deviceName` | dashboard | The battery to auto-connect to. |
| `autoConnect` | dashboard | Reconnect automatically on start (default on). |
| `interval` | dashboard | Polling interval in ms: 1000, 2000, 5000 or 10000. |
| `allDevices` | dashboard | Show every Bluetooth device in the chooser. |
| `trendMetric` | dashboard | Which trend chart tab is selected. |

Environment variables:

| Variable | Meaning |
| --- | --- |
| `WATTCYCLE_PASSWORD` | Remote password. Overrides `remotePassword` in `config.json`. |
| `PORT` | Server port (default `8765`). Keep it fixed: the browser remembers Bluetooth permission per port. |
| `NGROK_URL` | Static ngrok domain used by `ngrok.bat`. |

## History database

- **File:** `history.db` (SQLite) next to `serve.js`. Whenever the server starts and the file is missing, it is created automatically, empty. Existing data is never overwritten.
- **What's stored:** one row per 30 minutes. Each row has the average, min and max for voltage, current and SOC; average power; SOC at the end of the half hour; highest temperature; worst cell imbalance (mV); and Ah/Wh charged in and discharged out.
- **Size:** 48 rows a day, roughly 3 MB a year.
- **Gaps:** time when the dashboard window wasn't connected is shown as a gap, not guessed.
- **Safety:** the half hour in progress is saved every 5 minutes and when the server window closes normally. If the PC loses power, up to 5 minutes can be lost.
- **Backup:** copy `history.db` while the server is stopped.
- **Start over:** stop the server and delete `history.db`.
- **Use the data elsewhere:** click **Export CSV** in the History panel, or open `history.db` in any SQLite tool (for example [DB Browser for SQLite](https://sqlitebrowser.org)). The table is called `history`; the `t` column is the start of each half hour in milliseconds since 1970 (UTC).

Charge and discharge are worked out from the battery's single current sensor, which measures the **net** flow. If a charger and a load run at the same time, you see the difference between them, not both separately.

## API

| Method and path | Who | Description |
| --- | --- | --- |
| `GET /` | all | The dashboard page. |
| `GET /api/session` | all | `{ "role": "local" }` or `{ "role": "remote" }`. |
| `GET /api/stream` | all | Server-Sent Events: a snapshot, then live readings. |
| `GET /api/history?from=<ms>&to=<ms>` | all | 30-minute history rows between two timestamps. |
| `GET /api/config`, `POST /api/config` | this PC only | Read or update settings (the password is never returned). |
| `POST /api/data` | this PC only | Readings pushed by the dashboard window. |

The server listens on `127.0.0.1` only. Requests arriving through a tunnel are treated as remote and must give the password.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "This browser has no Web Bluetooth" | Use Edge or Chrome, and open the page as `http://localhost:8765` (not the PC's IP address). |
| Battery not in the device list | Close the WattCycle phone app, move closer, and tick **Show all devices**. Check that Bluetooth is on in Windows. |
| "The battery is not answering" | The phone app is probably still connected. Close it fully (swipe it away) or turn off the phone's Bluetooth. |
| Doesn't auto-connect after a restart | Start with `start.bat`, not by opening the page in your normal browser. The dashboard needs its own browser profile. If it says permission was lost, click **Connect battery** once. |
| History says "needs Node.js 22.5 or newer" | Update Node.js (`winget upgrade OpenJS.NodeJS.LTS`) and restart. |
| Remote page says "Remote access is turned off" | Add `remotePassword` to `config.json` and restart `start.bat`. |
| Remote page shows "PC window silent" | The dashboard window on the PC was closed, or the PC went to sleep. |
| Port 8765 already in use | Another copy is already running. Close it, or set a different `PORT`. Changing the port means picking the battery once more. |

Open **Bluetooth log (raw frames)** at the bottom of the dashboard to see every message to and from the battery.

## Project files

| File | Purpose |
| --- | --- |
| `index.html` | The whole dashboard: Bluetooth protocol, charts and history views. |
| `serve.js` | Local web server, settings, history database, and live relay for remote viewers. |
| `start.bat` | Starts the server and opens the dashboard window. |
| `tunnel.bat` | Opens a Cloudflare quick tunnel. |
| `ngrok.bat` | Opens an ngrok tunnel (optionally with a fixed domain). |
| `config.example.json` | Template for `config.json`. |
| `docs/screenshots/` | Images used in this README. |

## Security notes

- Never commit `config.json`. It holds your remote password and is listed in `.gitignore`.
- Use a long, unique remote password. The tunnel uses HTTPS, so the password is encrypted in transit.
- Remote viewers can only **look**. They can't connect, disconnect, change settings or send commands to the battery.
- To stop sharing, close the tunnel window. The dashboard keeps working locally.

## Credits

The Bluetooth protocol (TDT BMS: service `FFF0`, commands `0x8C`, `0x8D`, `0x92`) follows the `tdt_bms` plugin of [aiobmsble](https://github.com/patman15/aiobmsble) (Apache-2.0), which the Home Assistant *BMS_BLE* integration uses for WattCycle packs.

Not affiliated with or endorsed by WattCycle.
