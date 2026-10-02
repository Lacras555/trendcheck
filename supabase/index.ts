// TrendCheck price feed. GET ?symbol=AAPL -> 2y daily closes + quote. GET ?q=costco -> ticker search.
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
const json = (o: unknown, status = 200, cache = "public, max-age=60, s-maxage=300") =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache } });

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

async function chart(symbol: string) {
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return json({ error: "Invalid ticker symbol" }, 400);
  try {
    const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includePrePost=false`);
    const r = j?.chart?.result?.[0];
    if (!r || !r.timestamp) return json({ error: `No price history for ${symbol}` }, 404);
    const m = r.meta || {};
    const q = r.indicators?.quote?.[0] || {};
    const t: number[] = [], c: number[] = [];
    r.timestamp.forEach((ts: number, i: number) => {
      const v = q.close ? q.close[i] : null;
      if (v != null && isFinite(v)) { t.push(ts); c.push(Math.round(v * 10000) / 10000); }
    });
    const live = m.regularMarketPrice, liveTs = m.regularMarketTime;
    if (live != null && liveTs) {
      const lastDay = t.length ? new Date(t[t.length - 1] * 1000).toISOString().slice(0, 10) : "";
      const liveDay = new Date(liveTs * 1000).toISOString().slice(0, 10);
      if (lastDay === liveDay) c[c.length - 1] = live;
      else if (liveTs > (t[t.length - 1] || 0)) { t.push(liveTs); c.push(live); }
    }
    const typeMap: Record<string, string> = { ETF: "ETF", EQUITY: "Stock", MUTUALFUND: "Fund", INDEX: "Index", CRYPTOCURRENCY: "Crypto" };
    return json({
      symbol: m.symbol || symbol, name: m.longName || m.shortName || symbol,
      type: typeMap[m.instrumentType] || m.instrumentType || "Stock",
      currency: m.currency || "USD", exchange: m.fullExchangeName || m.exchangeName || "",
      price: live != null ? live : c[c.length - 1],
      changePct: m.regularMarketChangePercent ?? null,
      high52: m.fiftyTwoWeekHigh ?? null, low52: m.fiftyTwoWeekLow ?? null,
      marketTime: liveTs || null, t, c,
    });
  } catch (e: any) {
    if (e?.status === 404) return json({ error: `Ticker ${symbol} not found` }, 404, "no-store");
    return json({ error: `Price source unavailable for ${symbol}. Try again in a minute.` }, 502, "no-store");
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
  } catch {
    return json({ results: [], error: "Search unavailable" }, 502, "no-store");
  }
}

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(req.url);
  const sym = (u.searchParams.get("symbol") || "").trim().toUpperCase();
  const q = (u.searchParams.get("q") || "").trim().slice(0, 40);
  if (sym) return chart(sym);
  if (q) return search(q);
  return json({ ok: true, service: "trendcheck" });
});
