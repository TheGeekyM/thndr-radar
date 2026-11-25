#!/usr/bin/env node
// EGX Alerts desktop app: local server (127.0.0.1 only) + Chrome app window (see start.sh).
// Checks every 15 min during EGX hours, pops a desktop notification (and Telegram if configured) on new signals.
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { advise, analyze, history, RULE_TYPES, ruleHit, ruleText, telegram, thndr } from './alerts.mjs';

// ponytail: reuse the QR library thndr-mcp already ships instead of adding our own dependency.
// Defaults so a packaged app needs no env vars: bundled thndr CLI, and on Windows data in %APPDATA%\ThndrRadar.
process.env.THNDR_BIN ||= (() => { const p = new URL('./vendor/thndr-mcp/dist/thndr.js', import.meta.url).pathname; const f = process.platform === 'win32' ? decodeURIComponent(p.slice(1)) : decodeURIComponent(p); return existsSync(f) ? f : 'thndr'; })();
if (process.platform === 'win32' && !process.env.RADAR_DATA && process.env.APPDATA) process.env.RADAR_DATA = join(process.env.APPDATA, 'ThndrRadar');
if (process.env.RADAR_DATA) mkdirSync(process.env.RADAR_DATA, { recursive: true });

const QRCode = createRequire(new URL('./vendor/thndr-mcp/package.json', import.meta.url))('qrcode');

const PORT = 7777;
const file = (name) => new URL(`./${name}`, import.meta.url);
// Your data (config, alert log) lives in RADAR_DATA when set (installed app: ~/.config/thndr-radar), else next to the app.
const dataFile = (name) => (process.env.RADAR_DATA ? join(process.env.RADAR_DATA, name) : file(name));
const readJson = (name, fallback) => { try { return JSON.parse(readFileSync(dataFile(name), 'utf8')); } catch { return fallback; } };
const saveJson = (name, data) => writeFileSync(dataFile(name), JSON.stringify(data, null, 2));

const config = { symbols: ['COMI'], telegramToken: '', telegramChat: '', rules: {}, ...readJson('config.json', {}) };
saveJson('config.json', config);
let log = readJson('alerts-log.json', []);
const state = { rows: [], errors: {}, lastRun: null, held: [], avgCost: {}, positions: {} };
const cache = {}; // sym -> { closes, lastDay } from the last full run, used for live updates

function cairo(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const mins = +p.hour * 60 + +p.minute;
  return {
    day: now.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }),
    // EGX: Sun–Thu 10:00–14:30; keep checking until 15:00 to catch the closing price.
    open: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(p.weekday) && mins >= 600 && mins <= 900,
  };
}

// Windows toast: text goes in env vars (never into the script) so stock names can't inject PowerShell.
const WIN_TOAST = `$x=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
$t=$x.GetElementsByTagName('text');$t.Item(0).AppendChild($x.CreateTextNode($env:RADAR_T))>$null;$t.Item(1).AppendChild($x.CreateTextNode($env:RADAR_B))>$null;
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;

function notify(title, body) {
  if (process.platform === 'win32') {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_TOAST], { env: { ...process.env, RADAR_T: title, RADAR_B: body }, windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    execFile('osascript', ['-e', 'on run a\ndisplay notification (item 2 of a) with title (item 1 of a)\nend run', title, body], () => {});
  } else {
    execFile('notify-send', ['-a', 'Thndr Radar', '-u', 'critical', title, body], () => {});
  }
  if (config.telegramToken && config.telegramChat) {
    telegram(config.telegramToken, config.telegramChat, `${title}\n${body}`).catch((e) => console.error(e.message));
  }
}

/** Logs + notifies once per day per key. */
function fire(key, sym, side, price, why) {
  if (log.some((e) => e.key === key)) return;
  log.unshift({ key, time: new Date().toISOString(), sym, side, price, why });
  log = log.slice(0, 500);
  saveJson('alerts-log.json', log);
  notify(`${side === 'BUY' ? '🟢' : '🔴'} ${side} ${sym} @ ${price}`, why);
}

function checkRules(row) {
  const { day } = cairo();
  for (const r of config.rules[row.sym] ?? []) {
    if (ruleHit(r, row)) fire(`${day}:${row.sym}:rule:${r.id}`, row.sym, r.side, row.price, `${r.note || 'Your alert'}: ${ruleText(r)}`);
  }
}

let running = null;
function run() {
  // ponytail: one run at a time; a second click waits for the same run instead of hitting Thndr twice.
  running ??= (async () => {
    const { day } = cairo();
    const rows = [], errors = {};
    // Stocks you own on Thndr are always watched and can't be removed. If this fails (not logged in), keep the last list.
    try {
      const { positions } = await thndr(['get-account-positions']);
      state.held = positions.map((p) => p.ticker);
      state.avgCost = Object.fromEntries(positions.map((p) => [p.ticker, p.averageCost]));
      // Full Thndr positions (quantity, averageCost incl. fees, costValue, marketValue, unrealizedPnl[Percent as a fraction], weightPercent).
      // No average from Thndr? Compute it from the orders.
      // qty/cost/avg/src are the short names index.html's "My buys" view reads.
      state.positions = Object.fromEntries(positions.map((p) => [p.ticker, { ...p, qty: p.quantity, cost: p.costValue, avg: p.averageCost, src: 'thndr' }]));
      for (const p of positions.filter((x) => x.averageCost == null)) {
        try {
          const { computed } = await fills(p.ticker);
          // Only trust it when the orders explain the whole holding (bonus shares / splits / transfers don't show up as orders).
          if (computed.avg != null && computed.qty === p.quantity) {
            state.avgCost[p.ticker] = computed.avg;
            Object.assign(state.positions[p.ticker], { averageCost: computed.avg, costValue: computed.cost, avg: computed.avg, cost: computed.cost, src: 'orders' });
          }
        } catch {}
      }
      const missing = state.held.filter((t) => !config.symbols.includes(t));
      if (missing.length) { config.symbols.push(...missing); saveJson('config.json', config); }
    } catch {}
    for (const sym of config.symbols) {
      try {
        cache[sym] = await history(sym);
        const row = analyze(sym, cache[sym].closes);
        rows.push(row);
        for (const s of row.signals) fire(`${day}:${sym}:${s.rule}:${s.side}`, sym, s.side, row.price, s.why);
        checkRules(row);
      } catch (e) {
        errors[sym] = ['NOT_AUTHENTICATED', 'SESSION_EXPIRED'].includes(e.code) ? 'Not logged in to Thndr. Click "Log in to Thndr" at the top.' : e.message;
      }
    }
    Object.assign(state, { rows, errors, lastRun: new Date().toISOString() });
  })().finally(() => { running = null; });
  return running;
}

// Live prices: one snapshot call for all symbols. The page asks every 5 s, so nothing is fetched while the window is closed.
// RSI/signal-now are recomputed with the live price; alerts still come only from the full 15-min run (no flapping).
let living = null;
function live() {
  if (running || !cairo().open) return Promise.resolve();
  const syms = config.symbols.filter((s) => cache[s]);
  if (!syms.length) return Promise.resolve();
  living ??= thndr(['get-price-snapshot', ...syms]).then(({ quotes }) => {
    const { day } = cairo();
    for (const q of quotes) {
      const c = cache[q.ticker], price = q.last ?? q.lastTradePrice;
      if (!c || price == null) continue;
      const closes = c.lastDay === day ? [...c.closes.slice(0, -1), price] : [...c.closes, price];
      const i = state.rows.findIndex((r) => r.sym === q.ticker);
      if (i < 0) continue;
      state.rows[i] = { ...analyze(q.ticker, closes), change: q.changePercent ?? null, signals: state.rows[i].signals };
      checkRules(state.rows[i]);
    }
    state.liveAt = new Date().toISOString();
  }).catch((e) => console.error('live:', e.message)).finally(() => { living = null; });
  return living;
}

// Sidebar chart: range -> [candle size, bars]. Cached briefly so the 5-s refresh doesn't refetch history each time.
const CHART_RANGES = { '1D': ['1min', 400], '1W': ['10min', 160], '1M': ['1h', 140], '3M': ['1d', 66], '1Y': ['1d', 250], '5Y': ['1w', 260] };
const chartCache = new Map();
const cairoDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
async function chart(sym, range) {
  const key = `${sym}:${range}`, hit = chartCache.get(key), ttl = range === '1D' ? 10_000 : 300_000;
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const [res, bars] = CHART_RANGES[range];
  const j = await thndr(['get-price-history', sym, `--resolution=${res}`, `--bars=${bars}`]);
  let pts = (j.candles ?? j.points).map((c) => ({ t: c.time, c: c.close, v: c.volume ?? 0 }));
  let base = pts[0]?.c ?? null;
  if (range === '1D' && pts.length) {
    // Only the latest session; compare with the previous session's close (as Thndr does).
    const day = cairoDay(pts.at(-1).t), before = pts.filter((p) => cairoDay(p.t) !== day);
    pts = pts.filter((p) => cairoDay(p.t) === day);
    const c = cache[sym];
    base = c ? (c.lastDay === day ? c.closes.at(-2) : c.closes.at(-1)) : (before.at(-1)?.c ?? pts[0].c);
  }
  const data = { sym, range, points: pts, base };
  chartCache.set(key, { at: Date.now(), data });
  return data;
}

// `node app.mjs --open` (Windows shortcut, launchers) also opens the app window: Edge/Chrome in app mode, else the browser.
function openWindow() {
  if (!process.argv.includes('--open')) return;
  const url = `http://127.0.0.1:${PORT}`, args = [`--app=${url}`, '--window-size=1440,860'];
  const win = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
    .flatMap((d) => [join(d, 'Microsoft/Edge/Application/msedge.exe'), join(d, 'Google/Chrome/Application/chrome.exe')]);
  const nix = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const browser = (process.platform === 'win32' ? win : nix).find((p) => existsSync(p));
  const run = (cmd, a) => spawn(cmd, a, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
  if (browser) run(browser, args);
  else if (process.platform === 'win32') run('cmd', ['/c', 'start', '', url]);
  else run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

const SYMBOL = /^[A-Z0-9.]{1,12}$/; // passed to the thndr CLI, so keep it strict

// Your filled orders in one stock, from get-account-orders (read-only; this app never places orders). Cached 1 min.
// MARKET orders carry the fill price in `price` (averageFillPrice is empty), so that's the price used.
// computed = average cost from the orders: weighted by quantity; a sell removes shares at the running average (avg unchanged).
// Fills since the running quantity last hit 0 are the current position (`current: true`); earlier ones are closed round trips.
const fillsCache = new Map();
async function fills(sym) {
  const hit = fillsCache.get(sym);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const orders = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const j = await thndr(['get-account-orders', `--symbol=${sym}`, '--limit=100', ...(cursor ? [`--cursor=${cursor}`] : [])]);
    orders.push(...j.orders);
    if (!(cursor = j.nextCursor)) break;
  }
  const list = orders.filter((o) => o.ticker === sym && o.filledQuantity > 0)
    .map((o) => ({ time: o.updatedAt ?? o.createdAt, side: o.side, qty: o.filledQuantity, price: o.averageFillPrice ?? o.price, type: o.type }))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  let qty = 0, cost = 0, start = 0;
  list.forEach((f, i) => {
    if (f.side === 'BUY') { qty += f.qty; cost += f.qty * f.price; }
    else if (qty > 0) { const q = Math.min(f.qty, qty); cost -= q * (cost / qty); qty -= q; }
    if (qty === 0) { cost = 0; start = i + 1; }
  });
  list.forEach((f, i) => { f.current = i >= start; });
  const data = { sym, fills: list, computed: { qty, cost, avg: qty > 0 ? cost / qty : null } };
  fillsCache.set(sym, { at: Date.now(), data });
  return data;
}

// Login steps -> thndr CLI commands. `--flag=value` keeps user input from being read as another flag (no shell involved).
const LOGIN = {
  status: () => ['auth-status'],
  start: (v) => ['login-start', `--email=${v}`],
  code: (v) => ['login-verify-code', `--code=${v}`],
  approve: () => ['login-request-approval'], // new phone approval when the session expired (no email code)
  complete: () => ['login-complete', '--timeout-seconds=5'], // the page calls this repeatedly while waiting
  cookie: (v) => ['login-import-session', `--cookie-header=${v}`],
  logout: () => ['logout'],
};

async function login(step, value) {
  if (!LOGIN[step]) throw new Error('Unknown login step');
  const v = String(value ?? '').trim();
  if (['start', 'code', 'cookie'].includes(step) && !v) throw new Error('Please fill in the field');
  const result = await thndr(LOGIN[step](v));
  if (result.deepLink) result.qrSvg = await QRCode.toString(result.deepLink, { type: 'svg', margin: 1 });
  if (result.authenticated && step !== 'status') run(); // logged in: load the watchlist right away
  return result;
}

async function body(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 10_000) throw new Error('too big'); }
  return JSON.parse(s || '{}');
}

// Advice for each stock you hold, recomputed with the live price on every request.
const advice = () => Object.fromEntries(state.rows.filter((r) => state.positions[r.sym]).map((r) => [r.sym, advise(r, state.positions[r.sym])]));
const snapshot = () => ({
  ...state, advice: advice(), log, rules: config.rules, running: !!running, market: cairo().open, telegram: !!(config.telegramToken && config.telegramChat),
});

http.createServer(async (req, res) => {
  const json = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  try {
    // Block other websites from talking to this local server (DNS rebinding / CSRF):
    // Host must be ours, and POSTs must be JSON (cross-site JSON needs a CORS preflight we never allow).
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return json({ error: 'Bad host' }, 403);
    if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') return json({ error: 'JSON only' }, 415);
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(file('index.html')));
    }
    if (req.method === 'GET' && req.url === '/api/state') return json(snapshot());
    if (req.method === 'GET' && req.url.startsWith('/api/chart?')) {
      const q = new URL(req.url, 'http://x').searchParams, sym = q.get('sym') ?? '', range = q.get('range') ?? '';
      if (!SYMBOL.test(sym) || !CHART_RANGES[range]) return json({ error: 'Invalid chart request' }, 400);
      try { return json(await chart(sym, range)); } catch (e) { return json({ error: e.message }, 400); }
    }
    if (req.method === 'GET' && req.url.startsWith('/api/book?')) {
      // Order book + latest trades for the sidebar (one stock, only while the sidebar is open).
      const sym = new URL(req.url, 'http://x').searchParams.get('sym') ?? '';
      if (!SYMBOL.test(sym)) return json({ error: 'Invalid symbol' }, 400);
      try {
        const [depth, trades, snap] = await Promise.all([
          thndr(['get-market-depth', sym, '--levels=10']),
          thndr(['get-recent-trades', `--symbol=${sym}`, '--limit=50']),
          thndr(['get-price-snapshot', sym]),
        ]);
        return json({ sym, bids: depth.bids, asks: depth.asks, trades: trades.trades, quote: snap.quotes?.[0] ?? null, at: new Date().toISOString() });
      } catch (e) { return json({ error: e.message }, 400); }
    }
    if (req.method === 'GET' && (req.url.startsWith('/api/position?') || req.url.startsWith('/api/fills?'))) {
      // "My position" tab: Thndr position (from the last run) + your buy/sell history. History failing still returns the position.
      const sym = new URL(req.url, 'http://x').searchParams.get('sym') ?? '';
      if (!SYMBOL.test(sym)) return json({ error: 'Invalid symbol' }, 400);
      const position = state.positions[sym] ?? null;
      try { return json({ ...(await fills(sym)), position }); } catch (e) { return json({ error: e.message, sym, position, fills: null, historyError: e.message }, 400); }
    }
    if (req.method === 'GET' && req.url === '/api/live') { await live(); return json(snapshot()); }
    if (req.method === 'POST' && req.url === '/api/refresh') { await run(); return json(snapshot()); }
    if (req.method === 'POST' && req.url === '/api/login') {
      const { step, value } = await body(req);
      try { return json(await login(step, value)); } catch (e) { return json({ error: e.message, code: e.code }, 400); }
    }
    if (req.method === 'POST' && req.url === '/api/rules') {
      const { sym, add, remove } = await body(req);
      if (!SYMBOL.test(sym ?? '')) return json({ error: 'Invalid symbol' }, 400);
      const list = (config.rules[sym] ??= []);
      if (add) {
        const value = Number(add.value);
        if (!RULE_TYPES[add.type] || !['BUY', 'SELL'].includes(add.side) || !(value > 0)) return json({ error: 'Invalid alert' }, 400);
        list.push({ id: Math.random().toString(36).slice(2, 9), type: add.type, value, side: add.side, note: String(add.note ?? '').slice(0, 60) });
      }
      if (remove) config.rules[sym] = list.filter((r) => r.id !== remove);
      saveJson('config.json', config);
      for (const row of state.rows) if (row.sym === sym) checkRules(row); // already true? notify now
      return json(snapshot());
    }
    if (req.method === 'POST' && req.url === '/api/symbols') {
      const { add, remove } = await body(req);
      const sym = String(add ?? remove ?? '').trim().toUpperCase();
      if (!SYMBOL.test(sym)) return json({ error: 'Invalid symbol' }, 400);
      if (remove && state.held.includes(sym)) return json({ error: `You own ${sym} on Thndr, so it stays on the list` }, 400);
      if (add && !config.symbols.includes(sym)) config.symbols.push(sym);
      if (remove) config.symbols = config.symbols.filter((s) => s !== sym);
      saveJson('config.json', config);
      if (remove) state.rows = state.rows.filter((r) => r.sym !== sym);
      else if (!state.rows.some((r) => r.sym === sym)) {
        // Fetch only the new stock (no full refresh), so just the Add button shows loading.
        try {
          cache[sym] = await history(sym);
          state.rows.push(analyze(sym, cache[sym].closes));
          delete state.errors[sym];
        } catch (e) {
          config.symbols = config.symbols.filter((s) => s !== sym); saveJson('config.json', config);
          return json({ error: `${sym}: ${e.message}` }, 400);
        }
      }
      return json(snapshot());
    }
    json({ error: 'Not found' }, 404);
  } catch (e) { json({ error: e.message }, 500); }
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log('Already running'); openWindow(); setTimeout(() => process.exit(0), 500); return; }
  throw e;
}).listen(PORT, '127.0.0.1', () => {
  openWindow();
  console.log(`EGX Alerts on http://127.0.0.1:${PORT}`);
  run();
  setInterval(() => { if (cairo().open) run(); }, 15 * 60 * 1000);
});
