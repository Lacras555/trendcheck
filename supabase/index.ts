// TrendCheck backend (Supabase Edge Function)
//   GET  ?symbol=AAPL           -> 10y daily closes + last 1y daily OHLC candles + quote
//   GET  ?q=costco              -> ticker search
//   POST ?action=subscribe      -> save a phone's push subscription + watchlist
//   POST ?action=sync           -> update the watchlist for a subscription
//   POST ?action=unsubscribe    -> remove a subscription
//   POST ?action=test           -> send a test notification to one subscription
//   POST ?action=cron           -> daily job: recompute signals, push changes (needs x-cron-secret)
// Prices: Yahoo Finance, split-adjusted (not dividend-adjusted), same basis as standard charts.
// Alert data lives in the separate `trendcheck` schema; existing tables are never touched.
import "./engine.js";
import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.5";

const TC = (globalThis as any).TC;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const CANDLES = 260; // ~1 trading year of daily candles
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*" };
const json = (o: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache } });

let sqlClient: any = null;
const db = () => (sqlClient ??= postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false }));
let cfgCache: Record<string, string> | null = null;
async function cfg() {
  if (cfgCache) return cfgCache;
  const rows = await db()`select key, value from trendcheck.config`;
  cfgCache = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
  return cfgCache!;
}

async function yahoo(path: string) {
  let last: any;
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + path, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.ok) return await r.json();
      last = Object.assign(new Error("Yahoo HTTP " + r.status), { status: r.status });
      if (r.status === 404) break;
    } catch (e) { last = e; }
  }
  throw last;
}
const r4 = (v: number) => Math.round(v * 10000) / 10000;

async function series(symbol: string) {
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d&includePrePost=false`);
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp) throw Object.assign(new Error("no data"), { status: 404 });
  const m = r.meta || {};
  const q = r.indicators?.quote?.[0] || {};
  const t: number[] = [], c: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [];
  r.timestamp.forEach((ts: number, i: number) => {
    const cl = q.close?.[i];
    if (cl == null || !isFinite(cl)) return;
    t.push(ts); c.push(r4(cl));
    o.push(r4(q.open?.[i] ?? cl)); h.push(r4(q.high?.[i] ?? cl)); l.push(r4(q.low?.[i] ?? cl));
  });
  const live = m.regularMarketPrice, liveTs = m.regularMarketTime;
  if (live != null && liveTs && t.length) {
    const n = t.length - 1;
    const lastDay = new Date(t[n] * 1000).toISOString().slice(0, 10);
    const liveDay = new Date(liveTs * 1000).toISOString().slice(0, 10);
    if (lastDay === liveDay) { c[n] = live; h[n] = Math.max(h[n], live); l[n] = Math.min(l[n], live); }
    else if (liveTs > t[n]) { t.push(liveTs); c.push(live); o.push(m.regularMarketOpen ?? live); h.push(m.regularMarketDayHigh ?? live); l.push(m.regularMarketDayLow ?? live); }
  }
  const typeMap: Record<string, string> = { ETF: "ETF", EQUITY: "Stock", MUTUALFUND: "Fund", INDEX: "Index", CRYPTOCURRENCY: "Crypto" };
  const k = Math.max(0, t.length - CANDLES);
  return {
    symbol: m.symbol || symbol, name: m.longName || m.shortName || symbol,
    // Yahoo sometimes tags ETFs as EQUITY; the fund name is the tiebreaker
    type: (m.instrumentType === "EQUITY" && /\bETF\b|\bFund\b/i.test(m.longName || m.shortName || "")) ? "ETF" : (typeMap[m.instrumentType] || m.instrumentType || "Stock"),
    currency: m.currency || "USD", exchange: m.fullExchangeName || m.exchangeName || "",
    price: live != null ? live : c[c.length - 1],
    changePct: m.regularMarketChangePercent ?? null,
    high52: m.fiftyTwoWeekHigh ?? null, low52: m.fiftyTwoWeekLow ?? null,
    marketTime: liveTs || null,
    t, c,                                    // full daily close history (indicators, track record)
    ohlc: { from: k, o: o.slice(k), h: h.slice(k), l: l.slice(k) }, // last ~1y daily candles, aligned to t[from..]
  };
}

async function chart(symbol: string) {
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return json({ error: "Invalid ticker symbol" }, 400);
  try { return json(await series(symbol), 200, "public, max-age=60, s-maxage=300"); }
  catch (e: any) {
    if (e?.status === 404) return json({ error: `Ticker ${symbol} not found` }, 404);
    return json({ error: `Price source unavailable for ${symbol}. Try again in a minute.` }, 502);
  }
}

async function search(q: string) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`, { headers: { "User-Agent": UA } });
    const j = await r.json();
    const name: Record<string, string> = { EQUITY: "Stock", ETF: "ETF", INDEX: "Index", MUTUALFUND: "Fund", CRYPTOCURRENCY: "Crypto" };
    const results = (j.quotes || []).filter((x: any) => x.symbol && name[x.quoteType])
      .map((x: any) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, type: name[x.quoteType], exchange: x.exchDisp || x.exchange || "" }));
    return json({ results }, 200, "public, max-age=3600");
  } catch { return json({ results: [], error: "Search unavailable" }, 502); }
}

/* ---------------- push alerts ---------------- */
const cleanSyms = (a: unknown) => Array.isArray(a) ? [...new Set(a.map(String).map(s => s.toUpperCase()).filter(s => /^[A-Z0-9.\-^=]{1,15}$/.test(s)))].slice(0, 60) : [];
const cleanLast = (o: any) => { const out: Record<string, string> = {}; if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (TC.LABELS[String(v)]) out[k.toUpperCase()] = String(v); return out; };

async function vapid() {
  const c = await cfg();
  webpush.setVapidDetails(c.vapid_subject, c.vapid_public, c.vapid_private);
}
async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: unknown) {
  await vapid();
  const d = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal" });
  const r = await fetch(d.endpoint, { method: "POST", headers: d.headers as any, body: d.body });
  return r.status;
}

async function subscribe(b: any) {
  const s = b?.subscription;
  if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth || !/^https:\/\//.test(s.endpoint)) return json({ error: "Invalid subscription" }, 400);
  const symbols = cleanSyms(b.symbols), last = cleanLast(b.verdicts);
  await db()`insert into trendcheck.subscriptions (endpoint, p256dh, auth, symbols, last)
    values (${s.endpoint}, ${s.keys.p256dh}, ${s.keys.auth}, ${symbols}, ${db().json(last)})
    on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, symbols = excluded.symbols,
      last = trendcheck.subscriptions.last || excluded.last, updated_at = now()`;
  return json({ ok: true, symbols: symbols.length });
}
async function sync(b: any) {
  if (!b?.endpoint) return json({ error: "Missing endpoint" }, 400);
  const symbols = cleanSyms(b.symbols), last = cleanLast(b.verdicts);
  const r = await db()`update trendcheck.subscriptions set symbols = ${symbols}, last = last || ${db().json(last)}, updated_at = now() where endpoint = ${b.endpoint} returning endpoint`;
  return json({ ok: r.length > 0 });
}
async function unsubscribe(b: any) {
  if (!b?.endpoint) return json({ error: "Missing endpoint" }, 400);
  await db()`delete from trendcheck.subscriptions where endpoint = ${b.endpoint}`;
  return json({ ok: true });
}
async function test(b: any) {
  const rows = await db()`select endpoint, p256dh, auth from trendcheck.subscriptions where endpoint = ${b?.endpoint ?? ""}`;
  if (!rows.length) return json({ error: "Alerts are not turned on for this phone" }, 404);
  const status = await sendPush(rows[0], { title: "TrendCheck alerts are on", body: "You will get a notice after the market closes when a signal on your list changes.", url: "./" });
  return json({ ok: status >= 200 && status < 300, status });
}

const PRIORITY: Record<string, number> = { STRONG: 0, AVOID: 1, BUY: 2, SELLOFF: 3, EXTENDED: 4, WATCH: 5, HOLD: 6 };
async function cron(req: Request) {
  const c = await cfg();
  if (req.headers.get("x-cron-secret") !== c.cron_secret) return json({ error: "Forbidden" }, 403);
  const subs = await db()`select endpoint, p256dh, auth, symbols, last from trendcheck.subscriptions`;
  const all = [...new Set(subs.flatMap((s: any) => s.symbols))] as string[];
  let mkt = null;
  try { const spy = await series("SPY"); mkt = TC.marketContext(spy); } catch { /* run without market context */ }
  const verdict: Record<string, string> = {};
  const queue = all.slice();
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const s = queue.shift()!;
      try { const d = await series(s); verdict[s] = TC.analyze(d.t, d.c, mkt).verdict; } catch { /* skip this symbol today */ }
    }
  }));
  let sent = 0, removed = 0;
  for (const s of subs as any[]) {
    const last = s.last || {}, next: Record<string, string> = { ...last }, changes: { sym: string; from: string; to: string }[] = [];
    for (const sym of s.symbols) {
      const v = verdict[sym]; if (!v || v === "NODATA") continue;
      if (last[sym] && last[sym] !== v) changes.push({ sym, from: last[sym], to: v });
      next[sym] = v;
    }
    for (const k of Object.keys(next)) if (!s.symbols.includes(k)) delete next[k];
    if (changes.length) {
      changes.sort((a, b) => (PRIORITY[a.to] ?? 9) - (PRIORITY[b.to] ?? 9));
      const head = changes[0];
      const title = changes.length === 1 ? `${head.sym}: ${TC.LABELS[head.to]}` : `${changes.length} signal changes on your list`;
      const body = changes.slice(0, 6).map(x => `${x.sym} ${TC.LABELS[x.from]} → ${TC.LABELS[x.to]}`).join("\n") + (changes.length > 6 ? `\n+${changes.length - 6} more` : "");
      try {
        const st = await sendPush(s, { title, body, url: "./", tag: "tc-daily" });
        if (st === 404 || st === 410) { await db()`delete from trendcheck.subscriptions where endpoint = ${s.endpoint}`; removed++; continue; }
        if (st >= 200 && st < 300) sent++;
      } catch { /* try again tomorrow */ }
    }
    await db()`update trendcheck.subscriptions set last = ${db().json(next)}, last_sent_at = case when ${changes.length > 0} then now() else last_sent_at end where endpoint = ${s.endpoint}`;
  }
  await db()`insert into trendcheck.runs (subs, symbols, sent, removed, note) values (${subs.length}, ${all.length}, ${sent}, ${removed}, ${mkt ? "ok" : "no SPY"})`;
  return json({ ok: true, subs: subs.length, symbols: all.length, scored: Object.keys(verdict).length, sent, removed });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(req.url);
  try {
    if (req.method === "POST") {
      const action = u.searchParams.get("action");
      if (action === "cron") return await cron(req);
      const b = await req.json().catch(() => ({}));
      if (action === "subscribe") return await subscribe(b);
      if (action === "sync") return await sync(b);
      if (action === "unsubscribe") return await unsubscribe(b);
      if (action === "test") return await test(b);
      return json({ error: "Unknown action" }, 400);
    }
    const sym = (u.searchParams.get("symbol") || "").trim().toUpperCase();
    const q = (u.searchParams.get("q") || "").trim().slice(0, 40);
    if (sym) return await chart(sym);
    if (q) return await search(q);
    return json({ ok: true, service: "trendcheck" });
  } catch (e) {
    console.error(e);
    return json({ error: "Server error" }, 500);
  }
});
