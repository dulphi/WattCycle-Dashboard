// Server for the WattCycle dashboard.
//
// Two kinds of visitors:
//   * LOCAL  - the browser window on this PC (http://localhost:8765). It talks to the battery over Web
//              Bluetooth, saves settings, and pushes every reading to this server.
//   * REMOTE - anyone coming in through a tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel...). Web Bluetooth
//              in *their* browser can't reach a battery next to this PC, so they get a read-only live view of
//              the readings the local window relays. Remote access needs a password.
//
//   GET  /             -> index.html (both)
//   GET  /api/session  -> { role: "local" | "remote" } (both)
//   GET  /api/config   -> config.json minus secrets (local only)
//   POST /api/config   -> merge JSON body into config.json (local only)
//   POST /api/data     -> latest reading from the Bluetooth window (local only)
//   GET  /api/stream   -> Server-Sent Events: snapshot + live readings (both)
//   GET  /api/history?from=ms&to=ms -> 30-minute summaries from history.db (both)
//
// Remote password: set WATTCYCLE_PASSWORD, or add "remotePassword": "..." to config.json by hand.
// Run with --open to launch the dashboard in a browser once the server is listening.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 8765;   // keep this fixed: Bluetooth permissions are stored per origin (host + port)
const CONFIG_FILE = path.join(__dirname, "config.json");
const APP_URL = `http://localhost:${PORT}/`;
const MAX_HISTORY = 1800;
const SECRET_KEYS = ["remotePassword"];   // never sent to the page, never writable through the API

/* ---------- config file ---------- */
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") console.warn(`Could not read ${CONFIG_FILE}: ${e.message}. Starting with an empty config.`);
    return {};
  }
}
function writeConfig(cfg) {
  const tmp = CONFIG_FILE + ".tmp";               // write-then-rename so a crash never leaves a half-written file
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}
const publicConfig = (cfg) => Object.fromEntries(Object.entries(cfg).filter(([k]) => !SECRET_KEYS.includes(k)));

/* ---------- who is asking? ----------
 * The server only listens on 127.0.0.1, so remote visitors arrive through a tunnel process running on this PC.
 * Tunnels add forwarding headers and use their public hostname, which is how we tell them apart.
 */
const FORWARD_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "cf-connecting-ip", "true-client-ip", "tailscale-user-login"];
function isLocal(req) {
  const ra = req.socket.remoteAddress;
  const loopback = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
  const forwarded = FORWARD_HEADERS.some((h) => req.headers[h]);
  const host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  return loopback && !forwarded && (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
}
const clientIp = (req) => String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",")[0].trim();

/* ---------- remote password (HTTP Basic auth, any user name) ---------- */
const failures = new Map();   // ip -> { n, until }
function remotePassword() { return process.env.WATTCYCLE_PASSWORD || readConfig().remotePassword || ""; }
function checkRemoteAuth(req, res) {
  const pw = remotePassword();
  if (!pw) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Remote access is turned off. On the dashboard PC, set a password (WATTCYCLE_PASSWORD or \"remotePassword\" in config.json) and restart the server.");
    return false;
  }
  const ip = clientIp(req), f = failures.get(ip);
  if (f && f.n >= 10 && f.until > Date.now()) { res.writeHead(429, { "Retry-After": "900" }); res.end("Too many attempts, try again later."); return false; }
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  const given = m ? Buffer.from(m[1], "base64").toString("utf8").replace(/^[^:]*:/, "") : null;
  const a = crypto.createHash("sha256").update(String(given)).digest(), b = crypto.createHash("sha256").update(pw).digest();
  if (given !== null && crypto.timingSafeEqual(a, b)) { failures.delete(ip); return true; }
  if (given !== null) failures.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="WattCycle dashboard", charset="UTF-8"', "Content-Type": "text/plain" });
  res.end("Password required.");
  return false;
}

/* ---------- history database ----------
 * SQLite (built into Node 22.5+, no npm install). Readings are not stored one by one: they are summarised
 * into one row per 30 minutes (avg/min/max + energy in/out), about 48 rows a day, a few MB a year.
 * The bucket in progress is saved every 5 minutes and on shutdown so a restart loses at most a few minutes.
 */
const DB_FILE = path.join(__dirname, "history.db");
const BUCKET_MS = 30 * 60 * 1000;
let db = null;
try {
  // node:sqlite prints an "experimental feature" warning on load; hide only that one.
  const defaultWarn = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => { if (!(w.name === "ExperimentalWarning" && /SQLite/i.test(w.message))) defaultWarn.forEach((f) => f(w)); });
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(DB_FILE);
  db.exec(`CREATE TABLE IF NOT EXISTS history (
    t INTEGER PRIMARY KEY,           -- start of the 30-minute bucket (ms since epoch)
    samples INTEGER NOT NULL,
    v_avg REAL, v_min REAL, v_max REAL,
    i_avg REAL, i_min REAL, i_max REAL,
    p_avg REAL,
    soc_avg REAL, soc_min REAL, soc_max REAL, soc_end REAL,
    temp_max REAL, cell_delta REAL,  -- °C, mV
    in_ah REAL, in_wh REAL, out_ah REAL, out_wh REAL
  )`);
} catch (e) {
  db = null;
  console.warn(`History database disabled (${e.message}). It needs Node.js 22.5 or newer.`);
}
const COLS = ["t", "samples", "v_avg", "v_min", "v_max", "i_avg", "i_min", "i_max", "p_avg", "soc_avg", "soc_min", "soc_max", "soc_end", "temp_max", "cell_delta", "in_ah", "in_wh", "out_ah", "out_wh"];
const upsert = db && db.prepare(`INSERT OR REPLACE INTO history (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const stat = (avg = null, lo = null, hi = null, n = 0) => ({ s: avg == null ? 0 : avg * n, n: avg == null ? 0 : n, lo, hi });
function addStat(m, x) { if (!isNum(x)) return; m.s += x; m.n++; m.lo = m.lo == null ? x : Math.min(m.lo, x); m.hi = m.hi == null ? x : Math.max(m.hi, x); }
const avgOf = (m) => (m.n ? m.s / m.n : null);

let acc = null, lastPointT = 0, lastSave = 0;
function newAcc(t) {
  // Resume a bucket already in the database (server restarted mid-bucket) instead of overwriting it.
  const r = db.prepare("SELECT * FROM history WHERE t = ?").get(t);
  const n = r?.samples || 0;
  return {
    t, n, dirty: false,
    v: stat(r?.v_avg, r?.v_min, r?.v_max, n), i: stat(r?.i_avg, r?.i_min, r?.i_max, n),
    p: stat(r?.p_avg, null, null, n), soc: stat(r?.soc_avg, r?.soc_min, r?.soc_max, n), socEnd: r?.soc_end ?? null,
    tempMax: r?.temp_max ?? null, cellDelta: r?.cell_delta ?? null,
    inAh: r?.in_ah || 0, inWh: r?.in_wh || 0, outAh: r?.out_ah || 0, outWh: r?.out_wh || 0,
  };
}
function accRow(a) {
  return {
    t: a.t, samples: a.n,
    v_avg: avgOf(a.v), v_min: a.v.lo, v_max: a.v.hi,
    i_avg: avgOf(a.i), i_min: a.i.lo, i_max: a.i.hi, p_avg: avgOf(a.p),
    soc_avg: avgOf(a.soc), soc_min: a.soc.lo, soc_max: a.soc.hi, soc_end: a.socEnd,
    temp_max: a.tempMax, cell_delta: a.cellDelta,
    in_ah: a.inAh, in_wh: a.inWh, out_ah: a.outAh, out_wh: a.outWh,
  };
}
function saveAcc() {
  if (!acc || !acc.dirty || !acc.n) return;
  const r = accRow(acc);
  try { upsert.run(...COLS.map((c) => r[c])); acc.dirty = false; lastSave = Date.now(); }
  catch (e) { console.warn("Could not save history: " + e.message); }
}
function recordReading(pt, data) {
  if (!db || !pt || pt.demo || !isNum(pt.t)) return;   // simulated demo data is never stored
  const bucket = Math.floor(pt.t / BUCKET_MS) * BUCKET_MS;
  if (acc && acc.t !== bucket) { saveAcc(); acc = null; }
  if (!acc) acc = newAcc(bucket);
  // Energy: integrate the net current. Positive = charged in, negative = discharged out.
  // Gaps over 30 s (battery out of range, PC asleep) are not bridged.
  if (lastPointT && pt.t > lastPointT && isNum(pt.current)) {
    const h = Math.min(pt.t - lastPointT, 30000) / 3.6e6;
    const p = isNum(pt.power) ? pt.power : (pt.voltage || 0) * pt.current;
    if (pt.current > 0) { acc.inAh += pt.current * h; acc.inWh += p * h; }
    else if (pt.current < 0) { acc.outAh -= pt.current * h; acc.outWh -= p * h; }
  }
  lastPointT = pt.t;
  acc.n++; acc.dirty = true;
  addStat(acc.v, pt.voltage); addStat(acc.i, pt.current); addStat(acc.p, pt.power); addStat(acc.soc, pt.soc);
  if (isNum(pt.soc)) acc.socEnd = pt.soc;
  const temps = Array.isArray(data?.temps) ? data.temps.filter(isNum) : [];
  if (temps.length) acc.tempMax = Math.max(acc.tempMax ?? -Infinity, ...temps);
  const cells = Array.isArray(data?.cells) ? data.cells.filter(isNum) : [];
  if (cells.length > 1) acc.cellDelta = Math.max(acc.cellDelta ?? 0, (Math.max(...cells) - Math.min(...cells)) * 1000);
}
if (db) {
  setInterval(() => {
    if (!acc) return;
    if (Date.now() >= acc.t + BUCKET_MS) { saveAcc(); acc = null; }            // bucket finished (even if readings stopped)
    else if (Date.now() - lastSave >= 5 * 60 * 1000) saveAcc();                // checkpoint the bucket in progress
  }, 60 * 1000).unref();
  const shutdown = () => { saveAcc(); try { db.close(); } catch {} process.exit(0); };
  ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].forEach((s) => process.on(s, shutdown));
}

/* ---------- live data relay ---------- */
const live = { data: {}, history: [], device: null, conn: null, at: null, dataAt: null };   // at: last message (heartbeat), dataAt: last reading
const streams = new Set();
function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of streams) res.write(msg);
}
setInterval(() => { for (const res of streams) res.write(": keep-alive\n\n"); }, 20000).unref();

/* ---------- http helpers ---------- */
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function readJsonObject(req) {
  const v = JSON.parse(await readBody(req));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
  return v;
}
const forbidden = (res) => sendJson(res, 403, { error: "only available on the dashboard PC" });

http.createServer(async (req, res) => {
  const local = isLocal(req);
  if (!local && !checkRemoteAuth(req, res)) return;
  const pathname = new URL(req.url, APP_URL).pathname;

  if (pathname === "/api/session") return sendJson(res, 200, { role: local ? "local" : "remote" });

  if (pathname === "/api/config") {
    if (!local) return forbidden(res);
    if (req.method === "GET") return sendJson(res, 200, publicConfig(readConfig()));
    if (req.method === "POST") {
      try {
        const patch = await readJsonObject(req);
        for (const k of SECRET_KEYS) delete patch[k];
        const cfg = { ...readConfig(), ...patch, updatedAt: new Date().toISOString() };
        for (const k of Object.keys(cfg)) if (cfg[k] === null) delete cfg[k];   // null clears a key
        writeConfig(cfg);
        return sendJson(res, 200, publicConfig(cfg));
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    res.writeHead(405, { Allow: "GET, POST" }); return res.end();
  }

  if (pathname === "/api/data") {
    if (!local) return forbidden(res);
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
    try {
      const msg = await readJsonObject(req);
      live.at = Date.now();
      if (msg.data && typeof msg.data === "object") Object.assign(live.data, msg.data);
      if ("device" in msg) live.device = msg.device;
      if (msg.conn) live.conn = msg.conn;
      if (msg.point && typeof msg.point === "object") {
        live.dataAt = live.at;
        live.history.push(msg.point);
        if (live.history.length > MAX_HISTORY) live.history.shift();
        recordReading(msg.point, msg.data);
      }
      broadcast("update", { ...msg, at: live.at });
      return sendJson(res, 200, { ok: true, viewers: streams.size });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  if (pathname === "/api/history") {   // read-only, so remote viewers may use it too
    if (!db) return sendJson(res, 503, { error: "History database unavailable (needs Node.js 22.5 or newer)" });
    const q = new URL(req.url, APP_URL).searchParams;
    const from = Number(q.get("from")) || 0, to = Number(q.get("to")) || Date.now() + BUCKET_MS;
    try {
      const rows = db.prepare("SELECT * FROM history WHERE t >= ? AND t < ? ORDER BY t").all(from, to).map((r) => ({ ...r }));
      if (acc && acc.n && acc.t >= from && acc.t < to) {   // include the half hour in progress, live
        const live = accRow(acc), i = rows.findIndex((r) => r.t === acc.t);
        if (i >= 0) rows[i] = live; else rows.push(live);
      }
      return sendJson(res, 200, { bucketMs: BUCKET_MS, rows });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  if (pathname === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    res.write(`event: snapshot\ndata: ${JSON.stringify(live)}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }

  if (pathname !== "/" && pathname !== "/index.html") { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(path.join(__dirname, "index.html"), (err, buf) => {
    if (err) { res.writeHead(500); return res.end(String(err)); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`WattCycle dashboard: ${APP_URL}  (Ctrl+C to stop)`);
  console.log(`Config file: ${CONFIG_FILE}`);
  if (db) console.log(`History database: ${DB_FILE} (one row per 30 minutes)`);
  console.log(remotePassword() ? "Remote viewing: enabled (password set). Start a tunnel with tunnel.bat."
                               : 'Remote viewing: off. Set WATTCYCLE_PASSWORD or add "remotePassword" to config.json to enable it.');
  if (process.argv.includes("--open")) openBrowser();
});

/* ---------- browser launcher ----------
 * Silent auto-reconnect needs navigator.bluetooth.getDevices(), which Chrome/Edge only expose with the
 * "WebBluetoothNewPermissionsBackend" feature. Command-line features only apply to a fresh browser process,
 * so we use a dedicated profile folder: it starts its own process and keeps the Bluetooth permission
 * between restarts.
 */
function openBrowser() {
  const profile = path.join(process.env.LOCALAPPDATA || __dirname, "WattCycleDashboard", "browser-profile");
  // The extra flags stop Chrome/Edge from slowing down the Bluetooth window when it is minimised,
  // so readings keep flowing to remote viewers.
  const args = [`--user-data-dir=${profile}`, "--enable-features=WebBluetoothNewPermissionsBackend", "--no-first-run",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
    `--app=${APP_URL}`];
  const pf = process.env["ProgramFiles"] || "C:\\Program Files", pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = process.platform === "win32" ? [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];

  const exe = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (exe) {
    spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
    console.log(`Opened ${path.basename(exe)} with a dedicated profile (Bluetooth auto-reconnect enabled).`);
    return;
  }
  console.log("Chrome/Edge not found; opening the default browser. Auto-reconnect may need chrome://flags/#enable-web-bluetooth-new-permissions-backend.");
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", APP_URL]] : process.platform === "darwin" ? ["open", [APP_URL]] : ["xdg-open", [APP_URL]];
  spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
}
