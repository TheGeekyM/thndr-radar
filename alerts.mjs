#!/usr/bin/env node
// EGX buy/sell signals. Data from the thndr CLI (github:armaaar/thndr-mcp). No deps, Node 20+.
// Used by app.mjs (desktop app). Self-check: node alerts.mjs --test
// Not financial advice: these are mechanical rules, not predictions.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const RSI_LEN = 14, RSI_BUY = 30, RSI_SELL = 70, SMA_LEN = 50;

export function rsiSeries(c, n = RSI_LEN) {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  const out = [l === 0 ? 100 : 100 - 100 / (1 + g / l)];
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
  }
  return out;
}

export const sma = (c, n, end = c.length) => c.slice(end - n, end).reduce((a, b) => a + b, 0) / n;

// Compares the latest bar with the previous one, so a rule fires only when it crosses.
export function signals(closes) {
  const out = [];
  if (closes.length < SMA_LEN + 1) return out;
  const r = rsiSeries(closes), [prev, cur] = r.slice(-2);
  if (prev >= RSI_BUY && cur < RSI_BUY) out.push({ rule: 'rsi', side: 'BUY', why: `RSI ${cur.toFixed(1)} < ${RSI_BUY} (oversold)` });
  if (prev <= RSI_SELL && cur > RSI_SELL) out.push({ rule: 'rsi', side: 'SELL', why: `RSI ${cur.toFixed(1)} > ${RSI_SELL} (overbought)` });
  const p0 = closes.at(-2), p1 = closes.at(-1), s0 = sma(closes, SMA_LEN, closes.length - 1), s1 = sma(closes, SMA_LEN);
  if (p0 <= s0 && p1 > s1) out.push({ rule: 'sma', side: 'BUY', why: `price ${p1} crossed above ${SMA_LEN}-day avg ${s1.toFixed(2)}` });
  if (p0 >= s0 && p1 < s1) out.push({ rule: 'sma', side: 'SELL', why: `price ${p1} crossed below ${SMA_LEN}-day avg ${s1.toFixed(2)}` });
  return out;
}

/** Where the stock stands right now (not only on crossing days). Same RSI thresholds as the alerts. */
export function stance(price, rsi, sma50, pl = null) {
  if (rsi == null) return { side: 'HOLD', why: 'Not enough history' };
  // Oversold but no support below (fresh lows) = falling knife: WAIT, same as the trade plan and the position advice.
  if (rsi < RSI_BUY && pl && pl.buyLo == null) return { side: 'WAIT', why: `Oversold (RSI ${rsi.toFixed(0)}) but still making new lows: wait until it stops falling` };
  const trend = sma50 == null ? '' : price > sma50 ? 'uptrend (above 50-day avg)' : 'downtrend (below 50-day avg)';
  if (rsi < RSI_BUY) return { side: 'BUY', why: `Oversold, RSI ${rsi.toFixed(0)}${sma50 != null && price < sma50 ? '; still in a downtrend, so riskier' : ''}` };
  if (rsi > RSI_SELL) return { side: 'SELL', why: `Overbought, RSI ${rsi.toFixed(0)}${sma50 != null && price > sma50 ? '; uptrend may continue' : ''}` };
  return { side: 'HOLD', why: `RSI ${rsi.toFixed(0)} neutral${trend ? `; ${trend}` : ''}` };
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Trade plan from recent price action (levels, not predictions):
 *  support  = highest of the 20/60-day lows that is still below the price
 *  buy zone = support .. support + half a typical daily move
 *  stop     = support - one typical daily move (typical move = avg |daily change| over 14 days)
 *  targets  = nearest 20/60-day highs or 50-day avg above the price
 */
export function plan(closes) {
  if (closes.length < 22) return null;
  const price = closes.at(-1), past = closes.slice(0, -1);
  const last = (n) => past.slice(-n);
  const diffs = closes.slice(-15).slice(1).map((c, i) => Math.abs(c - closes.slice(-15)[i]));
  const move = diffs.reduce((a, b) => a + b, 0) / diffs.length || price * 0.01;
  const lows = [Math.min(...last(20)), Math.min(...last(60))].filter((v) => v < price);
  const support = lows.length ? Math.max(...lows) : null;
  const highs = [Math.max(...last(20)), Math.max(...last(60)), past.length >= SMA_LEN ? sma(past, SMA_LEN) : null]
    .filter((v) => v != null && v > price * 1.005).map(r2);
  const [t1 = null, t2 = null] = [...new Set(highs)].sort((a, b) => a - b);
  const buyLo = support == null ? null : r2(support);
  const buyHi = support == null ? null : r2(Math.min(support + move / 2, price));
  // No support below = price at fresh lows: no buy zone; holders still get a stop 2 typical moves down.
  const stop = r2(support == null ? price - 2 * move : support - move);
  const entry = support == null ? price : (buyLo + buyHi) / 2;
  const rr = t1 != null && entry > stop ? (t1 - entry) / (entry - stop) : null;
  return { move: r2(move), buyLo, buyHi, stop, t1, t2, rr: rr == null ? null : Math.round(rr * 10) / 10, inZone: buyHi != null && price <= buyHi };
}

/** Everything the dashboard shows for one stock. */
export function analyze(sym, closes) {
  const price = closes.at(-1), prev = closes.at(-2);
  const enough = closes.length >= SMA_LEN + 1;
  const rsi = closes.length > RSI_LEN ? rsiSeries(closes).at(-1) : null;
  const sma50 = enough ? sma(closes, SMA_LEN) : null;
  return {
    sym, price, rsi, sma50,
    change: prev ? ((price - prev) / prev) * 100 : null,
    rsiTrail: closes.length > RSI_LEN ? rsiSeries(closes).slice(-30) : [],
    now: stance(price, rsi, sma50, plan(closes)),
    plan: plan(closes),
    // Stop-loss as it stood before the latest bar: plan().stop always sits below today's price, so this is the one a drop can break.
    prevStop: closes.length > 22 ? plan(closes.slice(0, -1)).stop : null,
    prevPlan: closes.length > 22 ? plan(closes.slice(0, -1)) : null, // levels as of yesterday's close (for automatic alerts)
    // Previous 20 sessions (today excluded): where the price recently stopped falling / rising.
    support: closes.length > 21 ? Math.min(...closes.slice(-21, -1)) : null,
    resistance: closes.length > 21 ? Math.max(...closes.slice(-21, -1)) : null,
    signals: signals(closes),
  };
}

/**
 * Backtest the app's own rules on past daily closes (buy and sell at the close; no fees, no slippage):
 *  rsi:  buy when RSI crosses below 30; sell when it crosses above 70, at -10%, or after 60 sessions
 *  plan: buy when the price is in plan()'s buy zone with risk/reward >= 1.5; sell at Target 1 or the stop, or after 60 sessions
 * Returns per strategy { trades, wins, winRate, avgPct, totalPct (compounded), worstPct, open } and buy-and-hold %.
 */
export function backtest(closes) {
  const MAX_DAYS = 60;
  const summary = (list, open) => {
    const wins = list.filter((t) => t.pct > 0).length;
    return {
      trades: list.length, wins, winRate: list.length ? wins / list.length : null,
      avgPct: list.length ? list.reduce((a, t) => a + t.pct, 0) / list.length : null,
      totalPct: list.length ? (list.reduce((a, t) => a * (1 + t.pct / 100), 1) - 1) * 100 : null,
      worstPct: list.length ? Math.min(...list.map((t) => t.pct)) : null,
      open, list: list.slice(-10),
    };
  };
  const pct = (a, b) => ((b - a) / a) * 100;
  // RSI strategy
  const r = rsiSeries(closes), rsiAt = (i) => r[i - RSI_LEN];
  let rsiTrades = [], pos = null;
  for (let i = RSI_LEN + 1; i < closes.length; i++) {
    const prev = rsiAt(i - 1), cur = rsiAt(i), c = closes[i];
    if (!pos) { if (prev >= RSI_BUY && cur < RSI_BUY) pos = { i, price: c }; continue; }
    if ((prev <= RSI_SELL && cur > RSI_SELL) || c <= pos.price * 0.9 || i - pos.i >= MAX_DAYS) {
      rsiTrades.push({ in: pos.i, out: i, buy: pos.price, sell: c, pct: pct(pos.price, c) }); pos = null;
    }
  }
  const rsiOpen = pos ? { buy: pos.price, nowPct: pct(pos.price, closes.at(-1)), days: closes.length - 1 - pos.i } : null;
  // Trade-plan strategy
  let planTrades = []; pos = null;
  for (let i = 60; i < closes.length; i++) {
    const c = closes[i];
    if (!pos) {
      const p = plan(closes.slice(0, i + 1));
      if (p && p.inZone && p.rr != null && p.rr >= 1.5 && p.t1 != null) pos = { i, price: c, stop: p.stop, target: p.t1 };
      continue;
    }
    if (c >= pos.target || c <= pos.stop || i - pos.i >= MAX_DAYS) {
      planTrades.push({ in: pos.i, out: i, buy: pos.price, sell: c, pct: pct(pos.price, c) }); pos = null;
    }
  }
  const planOpen = pos ? { buy: pos.price, nowPct: pct(pos.price, closes.at(-1)), days: closes.length - 1 - pos.i } : null;
  return { days: closes.length, rsi: summary(rsiTrades, rsiOpen), plan: summary(planTrades, planOpen), buyHoldPct: pct(closes[0], closes.at(-1)) };
}

/**
 * Automatic alerts for every stock on the list, from the trade plan as of yesterday's close (fixed levels, so they
 * don't move with today's price). pos = Thndr position if you own it.
 *  BUY        price entered the buy zone (above the stop)                  — every stock
 *  SELL stop  price at/below the stop-loss                                  — stocks you own
 *  SELL t1    price at/above Target 1                                       — stocks you own
 *  INFO even  price climbed back to your average (it was below yesterday)   — stocks you own
 */
export function autoSignals(row, pos) {
  const pp = row?.prevPlan, price = row?.price, out = [];
  if (!pp || price == null) return out;
  const f = (n) => Math.round(n * 100) / 100;
  if (pp.buyLo != null && pp.buyHi != null && price <= pp.buyHi && price > pp.stop) {
    out.push({ kind: 'zone', side: 'BUY', why: `Entered the buy zone ${f(pp.buyLo)}–${f(pp.buyHi)} (support). Stop-loss ${f(pp.stop)}${pp.t1 != null ? `, Target 1 ${f(pp.t1)}` : ''}.` });
  }
  const avg = pos?.averageCost ?? pos?.avg;
  if (avg != null) {
    if (price <= pp.stop) out.push({ kind: 'stop', side: 'SELL', why: `Fell to the stop-loss ${f(pp.stop)}: the plan broke. Consider cutting the loss (your average ${f(avg)}).` });
    if (pp.t1 != null && price >= pp.t1) out.push({ kind: 't1', side: 'SELL', why: `Reached Target 1 ${f(pp.t1)}: consider taking some profit${price > avg ? ` (+${f(((price - avg) / avg) * 100)}% on your average)` : ''}.` });
    const prev = row.change != null ? price / (1 + row.change / 100) : null;
    if (prev != null && prev < avg && price >= avg) out.push({ kind: 'even', side: 'INFO', why: `Back to your average ${f(avg)} (break-even). You can exit without a loss now.` });
  }
  return out;
}

/** Buying n more shares at price: new average cost (= new break-even, before fees) and the extra money needed. */
export function averageDown(qty, avg, n, price) {
  const total = qty + n;
  return { n, qty: total, avg: total > 0 ? (qty * avg + n * price) / total : null, extra: n * price };
}

/**
 * Rule-based advice for a stock you hold (row = analyze() result, pos = Thndr position). In order:
 *  SELL         price broke the stop-loss set before today
 *  TAKE_PROFIT  in profit and overbought, or within half a typical move of Target 1
 *  AVERAGE_DOWN in a loss, price inside the buy zone, risk/reward >= 1.5
 *  WAIT         in a loss but no buy zone (fresh lows), downtrend, or buy zone not reached yet
 *  HOLD         everything else
 * Always returns breakEven (your avg cost) and stop. Not financial advice.
 */
export function advise(row, pos) {
  const avg = pos?.averageCost, price = row?.price, pl = row?.plan;
  if (avg == null || price == null) return null;
  const pnl = ((price - avg) / avg) * 100, loss = price < avg;
  const down = row.sma50 != null && price < row.sma50;
  const base = { breakEven: avg, stop: pl?.stop ?? null, pnl };
  const say = (action, why) => ({ ...base, action, why });
  if (!pl) return say('HOLD', 'Not enough price history for a plan.');
  const brokeStop = row.prevStop ?? pl.stop;
  if (price <= brokeStop) return say('SELL', `Price ${price} fell below the stop-loss ${brokeStop}: the plan broke, so reduce or exit to keep the loss from growing.`);
  if (!loss && (row.now?.side === 'SELL' || (pl.t1 != null && pl.t1 - price <= pl.move / 2))) {
    return say('TAKE_PROFIT', row.now?.side === 'SELL'
      ? `You're up ${pnl.toFixed(1)}% and the stock is overbought (RSI ${row.rsi.toFixed(0)}): sell part, keep the rest with the stop at ${pl.stop}.`
      : `You're up ${pnl.toFixed(1)}% and the price is close to Target 1 (${pl.t1}): sell part, keep the rest with the stop at ${pl.stop}.`);
  }
  if (loss && pl.inZone && pl.rr != null && pl.rr >= 1.5) {
    return say('AVERAGE_DOWN', `You're down ${Math.abs(pnl).toFixed(1)}% and the price is in the buy zone (${pl.buyLo}–${pl.buyHi}) with risk/reward 1 : ${pl.rr}: buying more here lowers your average${down ? '; trend is still down, so add in small steps and respect the stop' : ''}.`);
  }
  if (loss && pl.buyLo == null) return say('WAIT', `You're down ${Math.abs(pnl).toFixed(1)}% and the price is making new lows (no support below): don't average down until it stops falling.`);
  if (loss && down) return say('WAIT', `You're down ${Math.abs(pnl).toFixed(1)}% and the trend is down (below the 50-day avg): don't average down yet, wait for the buy zone ${pl.buyLo}–${pl.buyHi}.`);
  if (loss) return say('HOLD', `You're down ${Math.abs(pnl).toFixed(1)}% but the trend is up: hold; if you want to average down, wait for the buy zone ${pl.buyLo}–${pl.buyHi}.`);
  return say('HOLD', `You're ${pnl >= 0 ? 'up' : 'down'} ${Math.abs(pnl).toFixed(1)}%: hold${pl.t1 != null ? `, Target 1 is ${pl.t1}` : ''}; sell if it closes below the stop ${pl.stop}.`);
}

// Per-stock alert rules set in the app: { id, type, value, side, note }.
export const RULE_TYPES = { price_below: 'Price ≤', price_above: 'Price ≥', rsi_below: 'RSI ≤', rsi_above: 'RSI ≥' };
export function ruleHit(rule, row) {
  const v = rule.type.startsWith('rsi') ? row.rsi : row.price;
  if (v == null) return false;
  return rule.type.endsWith('below') ? v <= rule.value : v >= rule.value;
}
export const ruleText = (r) => `${RULE_TYPES[r.type]} ${r.value}`;

// In-process thndr-mcp: load its use cases once (same code the CLI runs) so the instrument lookup cache and the
// session stay warm between calls. Each CLI process used to re-resolve every ticker (1 request per stock per call),
// which hit Thndr's rate limit with the 5-s live refresh. Falls back to spawning the CLI if loading fails.
const POSITIONAL = { get_price_snapshot: 'symbols', login_start: 'email', login_verify_code: 'code', login_import_session: 'cookieHeader', search_instruments: 'query', get_index_constituents: 'index', get_tag_instruments: 'tag' };
const STRINGS = new Set(['symbol', 'code', 'email', 'cookieHeader', 'query', 'cursor', 'before', 'from', 'to', 'status', 'locale', 'market', 'resolution']);
let inproc = null, inprocLibUrl = null;
function loadInProcess() {
  inproc ??= (async () => {
    const bin = process.env.THNDR_BIN || '';
    if (!bin.endsWith('.js')) throw new Error('no bundled CLI');
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const chunk = readFileSync(bin, 'utf8').match(/from "\.\/(chunk-[A-Za-z0-9_-]+\.js)"/)?.[1];
    if (!chunk) throw new Error('chunk not found');
    inprocLibUrl = pathToFileURL(join(dirname(bin), chunk)).href;
    const lib = await import(inprocLibUrl);
    const app = lib.compose(lib.loadConfig());
    return { app, run: lib.runAndPresent };
  })();
  return inproc;
}
/**
 * Firebase ID token for Thndr's realtime price feed, from the Firebase login thndr-mcp keeps in its session file.
 * Uses the cached token while valid, else Google's standard securetoken refresh. Read-only (never writes the session
 * file) and never logged.
 */
let fbToken = null;
export async function firebaseIdToken() {
  if (fbToken && fbToken.exp - Date.now() > 120_000) return fbToken.value;
  const { app } = await loadInProcess(); // ensures thndr-mcp is loaded; its config knows the session file path
  const { readFileSync } = await import('node:fs');
  const sessionPath = (await import(inprocLibUrl)).loadConfig().sessionFile;
  const fb = JSON.parse(readFileSync(sessionPath, 'utf8')).firebase ?? {};
  const key = Object.keys(fb).find((k) => k.startsWith('firebase:authUser:'));
  if (!key) throw Object.assign(new Error('Not logged in to Thndr'), { code: 'NOT_AUTHENTICATED' });
  const apiKey = key.split(':')[2], sts = fb[key].stsTokenManager ?? {};
  if (sts.accessToken && sts.expirationTime - Date.now() > 120_000) {
    fbToken = { value: sts.accessToken, exp: sts.expirationTime };
    return fbToken.value;
  }
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sts.refreshToken ?? '' }),
  });
  if (!res.ok) throw Object.assign(new Error(`Firebase token refresh failed (${res.status})`), { code: 'SESSION_EXPIRED' });
  const j = await res.json();
  fbToken = { value: j.id_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
  void app;
  return fbToken.value;
}

/** CLI-style args (['get-price-history', 'COMI', '--bars=120']) -> [use case name, input object]. */
export function toInput(args) {
  const [cmd, ...rest] = args, name = cmd.replace(/-/g, '_'), input = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v === undefined) v = rest[++i];
    k = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    input[k] = !STRINGS.has(k) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  if (pos.length) {
    const key = POSITIONAL[name] ?? 'symbol';
    input[key] = key === 'symbols' ? pos : pos[0];
  }
  return [name, input];
}

/** Runs a thndr command and returns its JSON; failures throw Error(Thndr's message), with .code like NOT_AUTHENTICATED. */
export async function thndr(args) {
  try {
    const { app, run } = await loadInProcess();
    const [name, input] = toInput(args);
    const useCase = app.useCases.find((u) => u.name === name);
    if (!useCase) throw Object.assign(new Error(`Unknown thndr command ${args[0]}`), { code: 'UNKNOWN' });
    const out = await run(useCase, input, app.logger);
    if (out.ok) return JSON.parse(JSON.stringify(out.view)); // same JSON shape as the CLI's --json
    throw Object.assign(new Error(out.error.message), { code: out.error.error, thndr: true });
  } catch (e) {
    if (e.thndr || e.code === 'UNKNOWN') throw e;
    if (!String(e.message).match(/no bundled CLI|chunk not found|Cannot find module|ERR_MODULE/)) throw e;
  }
  return thndrSpawn(args);
}

async function thndrSpawn(args) {
  try {
    // A .js CLI path is run with this same Node binary (no system `node` needed, works for the packaged app too).
    const bin = process.env.THNDR_BIN || 'thndr', js = bin.endsWith('.js');
    const { stdout } = await promisify(execFile)(js ? process.execPath : bin, [...(js ? [bin] : []), ...args, '--json'], { timeout: 120_000 });
    return JSON.parse(stdout);
  } catch (e) {
    let err;
    try { err = JSON.parse(e.stderr); } catch { err = { message: (e.stderr || e.message || String(e)).trim().split('\n').slice(-3).join(' ') }; }
    throw Object.assign(new Error(err.message), { code: err.error });
  }
}

/** Daily closes, plus the date of the last bar (to know if today's bar is already in). */
export async function history(sym) {
  const j = await thndr(['get-price-history', sym, '--resolution', '1d', '--bars', '120']);
  const bars = j.candles ?? j.points;
  return { closes: bars.map((b) => b.close), lastDay: String(bars.at(-1)?.time ?? '').slice(0, 10) };
}

export async function telegram(token, chat, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

function selfTest() {
  const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
  assert(rsiSeries(Array.from({ length: 20 }, (_, i) => i)).at(-1) === 100, 'all-up RSI should be 100');
  // 60 days rising, then a drop under the 50-day average -> SMA SELL
  const up = Array.from({ length: 60 }, (_, i) => 100 + i);
  assert(signals([...up, 120]).some((s) => s.rule === 'sma' && s.side === 'SELL'), 'expected SMA SELL');
  // sideways chop, then a slide: some day must fire RSI BUY exactly once (crossing, not every day below 30)
  const slide = [...Array.from({ length: 60 }, (_, i) => 100 + (i % 2)), ...Array.from({ length: 15 }, (_, i) => 99 - i * 2)];
  const fires = slide.map((_, i) => signals(slide.slice(0, i + 1))).filter((s) => s.some((x) => x.rule === 'rsi' && x.side === 'BUY'));
  assert(fires.length === 1, `expected one RSI BUY crossing, got ${fires.length}`);
  assert(signals(up.slice(0, 10)).length === 0, 'too little history must give no signal');
  const a = analyze('X', [...up, 120]);
  assert(a.price === 120 && a.change < 0 && a.rsi !== null && a.sma50 !== null && a.rsiTrail.length === 30, 'analyze fields');
  assert(stance(10, 25, 12).side === 'BUY' && stance(10, 75, 8).side === 'SELL' && stance(10, 50, 9).side === 'HOLD', 'stance');
  assert(stance(10, null, null).side === 'HOLD', 'stance without history');
  assert(stance(10, 25, 12, { buyLo: null }).side === 'WAIT' && stance(10, 25, 12, { buyLo: 9 }).side === 'BUY', 'oversold at fresh lows = WAIT');
  assert(ruleHit({ type: 'price_below', value: 7 }, { price: 6.9 }) && !ruleHit({ type: 'price_below', value: 7 }, { price: 7.1 }), 'price_below');
  assert(ruleHit({ type: 'rsi_above', value: 70 }, { rsi: 71 }) && !ruleHit({ type: 'rsi_above', value: 70 }, { rsi: null }), 'rsi_above');
  const b = analyze('X', [...Array.from({ length: 30 }, (_, i) => 100 + (i % 5)), 90]);
  assert(b.support === 100 && b.resistance === 104, 'support/resistance exclude today');
  // plan: chop between 100 and 110 for 60 days, now at 103 -> support 100, target 110, stop below 100
  const chop = [...Array.from({ length: 60 }, (_, i) => (i % 10 < 5 ? 100 + (i % 5) * 2.5 : 110 - (i % 5) * 2.5)), 103];
  const pl = plan(chop);
  assert(pl.buyLo === 100 && pl.stop < 100 && pl.t1 >= 105 && pl.rr > 0, `plan levels ${JSON.stringify(pl)}`);
  const crash = Array.from({ length: 61 }, (_, i) => 200 - i * 2); // new lows every day
  const pc = plan(crash);
  assert(pc.buyLo === null && pc.stop < crash.at(-1) && pc.t1 > crash.at(-1), 'no buy zone at fresh lows');
  // average down: 100 @ 10 + 100 @ 8 -> 200 @ 9, costs 800
  const ad = averageDown(100, 10, 100, 8);
  assert(ad.qty === 200 && ad.avg === 9 && ad.extra === 800, `averageDown ${JSON.stringify(ad)}`);
  assert(averageDown(100, 10, 0, 8).avg === 10, 'averageDown with 0 shares keeps the avg');
  const held = (avg) => ({ averageCost: avg, quantity: 100 });
  // chop series at 103, held at 110 (loss), not in zone, sma50 above price -> WAIT; held at 95 (profit) -> HOLD or TAKE_PROFIT
  const rc = analyze('X', chop);
  assert(advise(rc, held(110)).action === 'WAIT' && advise(rc, held(95)).breakEven === 95, `advise chop ${advise(rc, held(110)).action}`);
  // same, but price dips into the buy zone -> AVERAGE_DOWN
  const dip = analyze('X', [...chop.slice(0, -1), 100.5]);
  assert(dip.plan.inZone && advise(dip, held(110)).action === 'AVERAGE_DOWN', `advise in zone ${JSON.stringify(dip.plan)}`);
  // steady chop, then a big drop through yesterday's stop -> SELL
  const brk = analyze('X', [...chop.slice(0, -1), 90]);
  assert(90 <= brk.prevStop && advise(brk, held(110)).action === 'SELL', `advise stop ${brk.prevStop}`);
  // fresh lows while in a loss -> WAIT; profit and overbought -> TAKE_PROFIT
  assert(advise(analyze('X', crash), held(200)).action === 'WAIT', 'advise fresh lows');
  const rally = analyze('X', [...chop, 106, 108, 109, 109.5]);
  assert(advise({ ...rally, now: { side: 'SELL' }, rsi: 75 }, held(100)).action === 'TAKE_PROFIT', 'advise take profit');
  assert(advise(rc, null) === null, 'advise needs a position');
  // backtest: a gentle wave (±4%, period 40) -> RSI buys near troughs mostly win.
  // (With ±15% swings the same rule loses: RSI < 30 fires early in the fall and the -10% stop hits — the "falling knife".)
  const wave = Array.from({ length: 400 }, (_, i) => 100 + 4 * Math.sin((i * 2 * Math.PI) / 40) + i * 0.01);
  const knife = backtest(Array.from({ length: 400 }, (_, i) => 100 + 15 * Math.sin((i * 2 * Math.PI) / 40)));
  assert(knife.rsi.winRate < 0.5, 'big swings: RSI rule should mostly lose');
  const bt = backtest(wave);
  assert(bt.rsi.trades >= 3 && bt.rsi.winRate > 0.5 && bt.rsi.avgPct > 0, `rsi backtest ${JSON.stringify({ ...bt.rsi, list: 0 })}`);
  assert(bt.plan.trades >= 1, `plan backtest ${JSON.stringify({ ...bt.plan, list: 0 })}`);
  assert(Math.abs(bt.buyHoldPct - ((wave.at(-1) - wave[0]) / wave[0]) * 100) < 1e-9, 'buy & hold');
  assert(JSON.stringify(toInput(['get-price-history', 'COMI', '--resolution', '1d', '--bars', '120'])) === '["get_price_history",{"resolution":"1d","bars":120,"symbol":"COMI"}]', 'toInput history');
  assert(JSON.stringify(toInput(['get-price-snapshot', 'COMI', 'HRHO'])) === '["get_price_snapshot",{"symbols":["COMI","HRHO"]}]', 'toInput snapshot');
  assert(JSON.stringify(toInput(['login-verify-code', '--code=012345'])) === '["login_verify_code",{"code":"012345"}]', 'code stays a string');
  assert(toInput(['get-news', '--symbol=COMI', '--content-chars=0'])[1].contentChars === 0, 'kebab flags -> camelCase numbers');
  // autoSignals: levels from yesterday's plan
  const ap = { prevPlan: { buyLo: 100, buyHi: 101, stop: 98, t1: 110 }, change: 0 };
  assert(autoSignals({ ...ap, price: 100.5 }, null).map((x) => x.kind).join() === 'zone', 'zone for any stock');
  assert(autoSignals({ ...ap, price: 97 }, null).length === 0, 'not held: no stop alert');
  assert(autoSignals({ ...ap, price: 97 }, { averageCost: 105 }).map((x) => x.kind).join() === 'stop', 'held: stop');
  assert(autoSignals({ ...ap, price: 111 }, { averageCost: 105 }).map((x) => x.kind).join() === 't1', 'held: target');
  assert(autoSignals({ ...ap, price: 105, change: 2 }, { averageCost: 104 }).map((x) => x.kind).join() === 'even', 'back to break-even');
  assert(autoSignals({ ...ap, price: 105, change: 0 }, { averageCost: 104 }).length === 0, 'already above average: no repeat');
  console.log('self-test ok');
}

if (process.argv.includes('--test')) selfTest();
