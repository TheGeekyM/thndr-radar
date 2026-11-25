#!/usr/bin/env node
// Thndr Radar desktop app: local server (127.0.0.1; optional token-protected phone access) + app window.
// Checks every 15 min during EGX hours, pops a desktop notification (and Telegram if configured) on new signals.
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { advise, analyze, backtest, firebaseIdToken, history, RULE_TYPES, ruleHit, ruleText, telegram, thndr } from './alerts.mjs';

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
    mins, tradingDay: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(p.weekday),
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
  notify(side === 'INFO' ? `🔵 ${sym}${price != null ? ` @ ${price}` : ''}` : `${side === 'BUY' ? '🟢' : '🔴'} ${side} ${sym} @ ${price}`, why);
}

function checkRules(row) {
  const { day } = cairo();
  for (const r of config.rules[row.sym] ?? []) {
    if (ruleHit(r, row)) fire(`${day}:${row.sym}:rule:${r.id}`, row.sym, r.side, row.price, `${r.note || 'Your alert'}: ${ruleText(r)}`);
  }
}

// Company logos from Thndr (fetched once per stock, kept in logos.json; '' = none available).
const logos = readJson('logos.json', {});
async function fetchLogos() {
  let changed = false;
  for (const sym of config.symbols.filter((s) => !(s in logos))) {
    try {
      const d = await thndr(['get-instrument-details', sym]);
      const u = d.logoUrl ?? d.instrument?.logoUrl ?? '';
      logos[sym] = typeof u === 'string' && u.startsWith('https://') ? u : '';
      changed = true;
    } catch {}
  }
  if (changed) saveJson('logos.json', logos);
}

const AUTH_CODES = ['NOT_AUTHENTICATED', 'SESSION_EXPIRED'];
const assetIds = {}; // ticker -> Thndr asset id (for the realtime feed)

// ---- Realtime prices: Thndr's own feed (Firebase Realtime Database, what ThndrX uses) streamed over HTTPS (SSE) ----
// One stream per stock while the market is open; each new price updates the row, checks your alerts and pushes to the page.
const RTDB = 'https://thndrx-realtime-db.europe-west1.firebasedatabase.app';
const streams = new Map(); // sym -> AbortController
async function streamPrice(sym, id, ctl) {
  while (!ctl.signal.aborted) {
    try {
      const token = await firebaseIdToken();
      const res = await fetch(`${RTDB}/assetPrice/${id}/price/last/value.json?auth=${encodeURIComponent(token)}`, { headers: { accept: 'text/event-stream' }, signal: ctl.signal });
      if (!res.ok) throw new Error(`realtime ${res.status}`);
      let buf = '', event = '';
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:') && (event === 'put' || event === 'patch')) {
            const d = JSON.parse(line.slice(5));
            if (typeof d?.data === 'number') onPrice(sym, d.data);
          } else if (event === 'auth_revoked' || event === 'cancel') { buf = ''; break; }
        }
        if (event === 'auth_revoked' || event === 'cancel') break; // token expired: reconnect with a fresh one
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      console.error(`realtime ${sym}:`, e.message);
      await new Promise((r) => setTimeout(r, 30_000)); // back off; the 30-s polling keeps prices fresh meanwhile
    }
  }
}
function onPrice(sym, price) {
  const c = cache[sym], i = state.rows.findIndex((r) => r.sym === sym);
  if (!c || i < 0) return;
  const { day } = cairo(), today = c.lastDay === day;
  const closes = today ? [...c.closes.slice(0, -1), price] : [...c.closes, price];
  const prevClose = today ? c.closes.at(-2) : c.closes.at(-1);
  const old = state.rows[i];
  state.rows[i] = { ...analyze(sym, closes), change: prevClose ? ((price - prevClose) / prevClose) * 100 : old.change, signals: old.signals, volRatio: old.volRatio };
  checkRules(state.rows[i]);
  state.liveAt = new Date().toISOString(); state.realtime = true;
  pushToPages();
}
function syncStreams() {
  const want = cairo().open && !state.authError ? new Set(config.symbols.filter((x) => assetIds[x])) : new Set();
  for (const [sym, ctl] of streams) if (!want.has(sym)) { ctl.abort(); streams.delete(sym); }
  for (const sym of want) if (!streams.has(sym)) { const ctl = new AbortController(); streams.set(sym, ctl); streamPrice(sym, assetIds[sym], ctl); }
  state.realtime = streams.size > 0;
}

// Pages listen on /api/events (SSE) and reload state on each push; throttled to one push per second.
const pages = new Set();
let pushTimer = null;
function pushToPages() {
  pushTimer ??= setTimeout(() => { pushTimer = null; for (const res of pages) res.write('data: tick\n\n'); }, 1000);
}
setInterval(() => { for (const res of pages) res.write(': keep-alive\n\n'); }, 25_000);
let authNotified = false;

// Volume spike: today's traded shares ≥ 2× the 30-day average (one snapshot call for all stocks). Shown in the table too.
async function volumeSpikes(day) {
  const syms = config.symbols.filter((x) => state.rows.some((r) => r.sym === x)).slice(0, 50);
  if (!syms.length) return;
  const { quotes } = await thndr(['get-price-snapshot', ...syms]);
  for (const q of quotes) {
    if (q.instrumentId) assetIds[q.ticker] = q.instrumentId;
    const row = state.rows.find((r) => r.sym === q.ticker);
    if (!row || !q.volume || !q.averageVolume30d) continue;
    row.volRatio = q.volume / q.averageVolume30d;
    if (row.volRatio >= 2 && cairo().open) {
      fire(`${day}:${q.ticker}:volume`, q.ticker, 'INFO', q.last ?? row.price, `Volume spike: ${Math.round(q.volume).toLocaleString('en-US')} shares today = ${row.volRatio.toFixed(1)}× the 30-day average. Something may be happening; check the news.`);
    }
  }
}

// News alerts for stocks you own: newest headline per stock; the first run only remembers what's there (no flood).
const newsSeen = readJson('news-seen.json', {});
async function newsAlerts() {
  let changed = false;
  for (const sym of state.held) {
    try {
      const { items } = await thndr(['get-news', `--symbol=${sym}`, '--limit=3', '--content-chars=0']);
      const first = !(sym in newsSeen);
      const seen = new Set(newsSeen[sym] ?? []);
      for (const it of [...(items ?? [])].reverse()) {
        if (seen.has(it.id)) continue;
        seen.add(it.id); changed = true;
        if (!first) fire(`news:${it.id}`, sym, 'INFO', null, `News: ${it.title}`);
      }
      newsSeen[sym] = [...seen].slice(-20);
    } catch {}
  }
  if (changed) saveJson('news-seen.json', newsSeen);
}

// Net worth over time: one point per day (Thndr's total account value), kept in networth.json.
const netHistory = readJson('networth.json', []);
function recordNetWorth(day) {
  const v = state.account?.totalAccountValue;
  if (!(v > 0)) return;
  const last = netHistory.at(-1);
  if (last?.d === day) last.v = v; else netHistory.push({ d: day, v });
  if (netHistory.length > 2000) netHistory.splice(0, netHistory.length - 2000);
  saveJson('networth.json', netHistory);
}

// End-of-day summary for your portfolio, once per trading day after the close (14:35 Cairo).
function dailySummary() {
  const c = cairo();
  if (!c.tradingDay || c.mins < 875 || config.lastSummary === c.day || !state.held.length) return;
  let today = 0, value = 0;
  const moves = [];
  for (const sym of state.held) {
    const r = state.rows.find((x) => x.sym === sym), p = state.positions[sym];
    if (!r || !p || r.change == null) continue;
    const prev = r.price / (1 + r.change / 100);
    today += p.quantity * (r.price - prev); value += p.quantity * r.price;
    moves.push({ sym, ch: r.change });
  }
  if (!moves.length) return;
  moves.sort((a, b) => b.ch - a.ch);
  const pct = value - today ? (today / (value - today)) * 100 : 0, sg = (n) => (n >= 0 ? '+' : '−');
  const f = (n) => Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  notify(`${today >= 0 ? '📈' : '📉'} Today ${sg(today)}${f(today)} EGP (${sg(pct)}${Math.abs(pct).toFixed(2)}%)`,
    `Best ${moves[0].sym} ${sg(moves[0].ch)}${Math.abs(moves[0].ch).toFixed(1)}% · worst ${moves.at(-1).sym} ${sg(moves.at(-1).ch)}${Math.abs(moves.at(-1).ch).toFixed(1)}%` +
    (state.account?.totalAccountValue ? ` · net worth ${f(state.account.totalAccountValue)} EGP` : ''));
  config.lastSummary = c.day; saveJson('config.json', config);
}

// Sidebar extras, cached: dividends (1 h), news (10 min, en/ar), backtest (1 h, ~2 years of daily closes).
const extraCache = new Map();
async function cached(key, ttl, fn) {
  const hit = extraCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await fn();
  extraCache.set(key, { at: Date.now(), data });
  return data;
}
const dividends = (sym) => cached(`div:${sym}`, 3_600_000, async () => {
  const j = await thndr(['get-dividends', `--symbol=${sym}`, '--limit=10']);
  return { sym, dividends: j.dividends ?? [] };
});
const news = (sym, locale) => cached(`news:${sym}:${locale}`, 600_000, async () => {
  const j = await thndr(['get-news', `--symbol=${sym}`, '--limit=8', `--locale=${locale}`, '--content-chars=200']);
  return { sym, locale, items: (j.items ?? []).map(({ id, title, content, source, link, publishedAt }) => ({ id, title, content, source, link: /^https?:\/\//.test(link ?? '') ? link : null, publishedAt })) };
});
const backtestOf = (sym) => cached(`bt:${sym}`, 3_600_000, async () => {
  const j = await thndr(['get-price-history', sym, '--resolution=1d', '--bars=500']);
  const bars = j.candles ?? j.points;
  return { sym, from: bars[0]?.time, to: bars.at(-1)?.time, ...backtest(bars.map((b) => b.close)) };
});

let running = null;
function run() {
  // ponytail: one run at a time; a second click waits for the same run instead of hitting Thndr twice.
  running ??= (async () => {
    const { day } = cairo();
    const rows = [], errors = {};
    let authFail = false;
    // Account totals for the net-worth card (cash = totalAccountValue - portfolioValue).
    try {
      const a = await thndr(['get-account-summary']);
      state.account = { totalAccountValue: a.totalAccountValue, portfolioValue: a.portfolioValue, availableCash: a.availableCash, buyingPower: a.buyingPower, currency: a.currency };
    } catch (e) { if (AUTH_CODES.includes(e.code)) authFail = true; }
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
        if (AUTH_CODES.includes(e.code)) authFail = true;
        errors[sym] = AUTH_CODES.includes(e.code) ? 'Not logged in to Thndr. Click "Log in to Thndr" at the top.' : e.message;
      }
    }
    Object.assign(state, { rows, errors, lastRun: new Date().toISOString() });
    // Login expired: banner in the page + one notification (until it works again), instead of silently going stale.
    state.authError = authFail ? 'Your Thndr login expired, so prices and alerts are paused. Click "Log in to Thndr" to continue.' : null;
    if (authFail && !authNotified) notify('⚠️ Thndr Radar: login expired', 'Prices and alerts are paused. Open the app and log in to Thndr again.');
    authNotified = authFail;
    if (!authFail) {
      await volumeSpikes(day).catch((e) => console.error('volume:', e.message));
      syncStreams();
      await newsAlerts().catch((e) => console.error('news:', e.message));
      recordNetWorth(day);
    }
    fetchLogos();
  })().finally(() => { running = null; });
  return running;
}

// Live prices: one snapshot call for all symbols. The page asks every 5 s, so nothing is fetched while the window is closed.
// RSI/signal-now are recomputed with the live price; alerts still come only from the full 15-min run (no flapping).
let living = null;
let lastLive = 0;
function live() {
  // Fallback polling (realtime streams do the real work): at most one snapshot per 25 s, however many pages ask.
  if (running || !cairo().open || Date.now() - lastLive < 25_000) return Promise.resolve();
  lastLive = Date.now();
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
      state.rows[i] = { ...analyze(q.ticker, closes), change: q.changePercent ?? null, signals: state.rows[i].signals, volRatio: q.volume && q.averageVolume30d ? q.volume / q.averageVolume30d : state.rows[i].volRatio };
      if (q.instrumentId) assetIds[q.ticker] = q.instrumentId;
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

// ---- Phone access (off by default): listen on the LAN too, every request from another device needs the secret token ----
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1] ?? null;
const tokenOk = (given, tok) => !!given && given.length === tok.length && timingSafeEqual(Buffer.from(given), Buffer.from(tok));
const lanIps = () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
async function remoteInfo() {
  const on = !!config.remote?.enabled, ip = lanIps()[0];
  const url = on && ip ? `http://${ip}:${PORT}/?t=${config.remote.token}` : null;
  return { enabled: on, url, ips: lanIps(), qrSvg: url ? await QRCode.toString(url, { type: 'svg', margin: 1 }) : null };
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
  ...state, advice: advice(), log, rules: config.rules, logos, netHistory, remote: !!config.remote?.enabled, running: !!running, market: cairo().open, telegram: !!(config.telegramToken && config.telegramChat),
});

const server = http.createServer(async (req, res) => {
  const json = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  try {
    // Block other websites from talking to this server (DNS rebinding / CSRF):
    //  - from this computer: Host must be ours;
    //  - from another device (phone access on): it must carry the secret token (cookie, or ?t= once, which sets the cookie).
    //  POSTs must be JSON (cross-site JSON needs a CORS preflight we never allow).
    if (isLocal(req)) {
      if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return json({ error: 'Bad host' }, 403);
    } else {
      const tok = config.remote?.enabled && config.remote.token;
      const fromQuery = new URL(req.url, 'http://x').searchParams.get('t');
      if (!tok || !(tokenOk(fromQuery, tok) || tokenOk(cookie(req, 'radar'), tok))) return json({ error: 'Not allowed. Open the link shown in Thndr Radar on your computer.' }, 403);
      if (fromQuery) { res.writeHead(302, { 'set-cookie': `radar=${tok}; HttpOnly; SameSite=Strict; Max-Age=31536000; Path=/`, location: '/' }); return res.end(); }
    }
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
    if (req.method === 'GET' && /^\/api\/(dividends|news|backtest)\?/.test(req.url)) {
      const u = new URL(req.url, 'http://x'), sym = u.searchParams.get('sym') ?? '', kind = u.pathname.split('/')[2];
      if (!SYMBOL.test(sym)) return json({ error: 'Invalid symbol' }, 400);
      try {
        if (kind === 'dividends') return json(await dividends(sym));
        if (kind === 'news') return json(await news(sym, u.searchParams.get('locale') === 'ar' ? 'ar' : 'en'));
        return json(await backtestOf(sym));
      } catch (e) { return json({ error: e.message }, 400); }
    }
    if (req.method === 'GET' && req.url === '/api/remote') {
      if (!isLocal(req)) return json({ error: 'Only from this computer' }, 403);
      return json(await remoteInfo());
    }
    if (req.method === 'POST' && req.url === '/api/remote') {
      // Turning phone access on/off is only allowed from this computer.
      if (!isLocal(req)) return json({ error: 'Only from this computer' }, 403);
      const { enabled, rotate } = await body(req);
      config.remote = { enabled: !!enabled, token: rotate || !config.remote?.token ? randomBytes(24).toString('base64url') : config.remote.token };
      saveJson('config.json', config);
      json(await remoteInfo());
      setTimeout(relisten, 200); // after the reply is sent (relisten closes open connections)
      return;
    }
    if (req.method === 'GET' && req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      pages.add(res);
      req.on('close', () => pages.delete(res));
      return;
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
});
let started = false;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !started) { console.log('Already running'); openWindow(); setTimeout(() => process.exit(0), 500); return; }
  throw e;
});
const host = () => (config.remote?.enabled ? '0.0.0.0' : '127.0.0.1');
function relisten() { server.close(); server.closeAllConnections?.(); server.listen(PORT, host()); }
server.listen(PORT, host(), () => {
  if (started) return;
  started = true;
  openWindow();
  console.log(`Thndr Radar on http://127.0.0.1:${PORT}${config.remote?.enabled ? ' (phone access on)' : ''}`);
  run();
  setInterval(() => { if (cairo().open) run(); }, 15 * 60 * 1000);
  setInterval(() => { dailySummary(); syncStreams(); }, 60 * 1000);
});
