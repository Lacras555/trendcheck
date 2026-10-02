// TrendCheck signal engine v2
// Inputs: daily closes (split-adjusted, same basis as standard daily charts). Indicators: SMA 20/50/100/200, RSI 14 (Wilder),
// 6-month relative strength vs S&P 500 (SPY), market trend (SPY vs its SMA 200).
// Rules were tuned on a 2011-2026 backtest of the default watchlist (see Help screen).
(function (root) {
  const DAY = 86400;
  const dayKey = ts => Math.floor((ts - 4 * 3600) / DAY); // trading day bucket (ET-ish)

  function smaSeries(c, n) {
    const out = new Array(c.length).fill(null); let s = 0;
    for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) out[i] = s / n; }
    return out;
  }
  function rsiSeries(c, n = 14) {
    const out = new Array(c.length).fill(null);
    if (c.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  function volSeries(c, n = 20) { // annualized stdev of daily returns
    const out = new Array(c.length).fill(null);
    for (let i = n; i < c.length; i++) {
      let m = 0; const r = [];
      for (let k = i - n + 1; k <= i; k++) { const x = c[k] / c[k - 1] - 1; r.push(x); m += x; }
      m /= n; let v = 0; r.forEach(x => v += (x - m) * (x - m));
      out[i] = Math.sqrt(v / (n - 1)) * Math.sqrt(252);
    }
    return out;
  }

  // Market context from SPY
  function marketContext(spy) {
    if (!spy || !spy.c || spy.c.length < 210) return null;
    const s200 = smaSeries(spy.c, 200), rsi = rsiSeries(spy.c, 14), vol = volSeries(spy.c, 20);
    const byDay = new Map();
    spy.t.forEach((ts, i) => byDay.set(dayKey(ts), i));
    const i = spy.c.length - 1;
    return {
      t: spy.t, c: spy.c, s200,
      lookup(ts) { const d = dayKey(ts); for (let k = 0; k < 6; k++) { const j = byDay.get(d - k); if (j != null) return j; } return null; },
      now: { price: spy.c[i], s200: s200[i], up: spy.c[i] > s200[i], d200: (spy.c[i] / s200[i] - 1) * 100, rsi: rsi[i], vol: vol[i] }
    };
  }

  const LABELS = { STRONG: 'Strong buy', BUY: 'Buy', HOLD: 'Hold', EXTENDED: 'Extended', WATCH: 'Watch', SELLOFF: 'Selloff', AVOID: 'Avoid', NODATA: 'No history' };
  const RANK = { STRONG: 0, BUY: 1, HOLD: 2, EXTENDED: 3, WATCH: 4, SELLOFF: 5, AVOID: 6, NODATA: 7 };

  // Build all per-day series once, then classify any day cheaply.
  function build(t, c, mkt) {
    const S = { s20: smaSeries(c, 20), s50: smaSeries(c, 50), s100: smaSeries(c, 100), s200: smaSeries(c, 200), rsi: rsiSeries(c, 14), vol: volSeries(c, 20) };
    const n = c.length;
    S.rs = new Array(n).fill(null);   // 6-month (126 sessions) return minus SPY's over the same dates
    S.mktUp = new Array(n).fill(null);
    if (mkt) {
      const idx = t.map(ts => mkt.lookup(ts));
      for (let i = 0; i < n; i++) {
        const j = idx[i];
        if (j != null && mkt.s200[j] != null) S.mktUp[i] = mkt.c[j] > mkt.s200[j];
        if (i >= 126 && j != null && idx[i - 126] != null) {
          const j0 = idx[i - 126];
          S.rs[i] = (c[i] / c[i - 126] - 1) - (mkt.c[j] / mkt.c[j0] - 1);
        }
      }
    }
    return S;
  }

  function classify(S, c, i) {
    const p = c[i], s50 = S.s50[i], s200 = S.s200[i], rsi = S.rsi[i];
    if (s200 == null || rsi == null) return 'NODATA';
    const above = p > s200, golden = s50 > s200;
    const d50 = p / s50 - 1, rs = S.rs[i];
    if (!above && !golden) return S.mktUp[i] === false ? 'SELLOFF' : 'AVOID';
    if (above && golden) {
      if (d50 > 0.15 || rsi >= 75) return 'EXTENDED';
      if (rsi < 40) return 'STRONG';
      if (rsi < 50 || (rsi < 55 && rs != null && rs > 0)) return 'BUY';
      return 'HOLD';
    }
    return 'WATCH';
  }

  function headlineFor(v, x) {
    const r = x ? x.rsi.toFixed(0) : '';
    switch (v) {
      case 'STRONG': return `Uptrend with RSI ${r}. A pullback inside a healthy trend, historically the best entry on this list.`;
      case 'BUY': return x.rs > 0 ? `Uptrend, RSI ${r}, and beating the S&P 500. Reasonable entry.` : `Uptrend with RSI ${r}. Reasonable entry.`;
      case 'HOLD': return `Uptrend intact but no discount (RSI ${r}). Keep it; add on a dip toward SMA 20 or SMA 50.`;
      case 'EXTENDED': return x.d50 > 15 ? `Price is ${x.d50.toFixed(0)}% above SMA 50. The trend is strong, but drops from here have been deeper. Hold; add only small amounts.` : `RSI ${r} is very high. The trend is strong; keep new buys small.`;
      case 'WATCH': return x.price > x.s200 ? 'Price is back above SMA 200 but SMA 50 is still below it. Early recovery, not confirmed.' : 'Price slipped below SMA 200 while SMA 50 is still above it. The trend is being tested.';
      case 'SELLOFF': return 'Falling along with the whole market. These have often recovered with the market, after deep drops. Wait for price to reclaim SMA 200.';
      case 'AVOID': return 'Falling while the market rises. Historically the weakest setup on this list: flat returns and the deepest drops.';
      default: return 'Needs at least 200 trading days of prices.';
    }
  }

  // Full analysis for the latest bar + history-based context.
  function analyze(t, c, mkt) {
    const n = c.length, i = n - 1;
    const S = build(t, c, mkt);
    const v = classify(S, c, i);
    const ind = { price: c[i], s20: S.s20[i], s50: S.s50[i], s100: S.s100[i], s200: S.s200[i], rsi: S.rsi[i], rs: S.rs[i], vol: S.vol[i], mktUp: S.mktUp[i] };
    const pct = (a, b) => (a == null || b == null) ? null : (a / b - 1) * 100;
    ind.d20 = pct(ind.price, ind.s20); ind.d50 = pct(ind.price, ind.s50); ind.d100 = pct(ind.price, ind.s100); ind.d200 = pct(ind.price, ind.s200);
    ind.s200prev = i >= 20 ? S.s200[i - 20] : null;
    if (v === 'NODATA') return { verdict: v, label: LABELS[v], rank: RANK[v], headline: headlineFor(v), ind, checks: [], S };

    // Signal age: sessions the current verdict has held
    const V = new Array(n);
    for (let j = 199; j < n; j++) V[j] = classify(S, c, j);
    let k = i; while (k > 199 && V[k - 1] === v) k--;
    const since = { ts: t[k], sessions: i - k + 1 };
    const prevVerdict = k > 199 ? V[k - 1] : null;

    // Track record of this verdict on this ticker: forward 20-session returns
    let cnt = 0, sum = 0, win = 0, all = 0, allSum = 0;
    for (let j = 199; j < n - 20; j++) {
      const f = c[j + 20] / c[j] - 1; all++; allSum += f;
      if (V[j] === v) { cnt++; sum += f; if (f > 0) win++; }
    }
    const record = cnt >= 15 ? { n: cnt, avg: sum / cnt * 100, win: win / cnt * 100, base: allSum / all * 100, years: (n - 200) / 252 } : null;

    const trend = (ind.price > ind.s200 ? 25 : 0) + (ind.s50 > ind.s200 ? 15 : 0) + (ind.s20 > ind.s50 ? 10 : 0) + (ind.s200prev != null && ind.s200 > ind.s200prev ? 10 : 0);
    const r = ind.rsi;
    let timing = r < 30 ? 34 : r < 40 ? 40 : r < 50 ? 30 : r < 70 ? 16 : r < 75 ? 12 : 6;
    if (ind.d50 > 15) timing = Math.max(0, timing - 10);

    const checks = [
      { ok: ind.price > ind.s200, label: 'Price above SMA 200', why: 'Long-term uptrend' },
      { ok: ind.s50 > ind.s200, label: 'SMA 50 above SMA 200', why: 'Golden cross in place' },
      { ok: ind.s20 > ind.s50, label: 'SMA 20 above SMA 50', why: 'Short-term momentum up' },
      { ok: r < 50, label: 'RSI below 50', why: 'Buying a dip, not a spike' },
      { ok: ind.d50 <= 15 && r < 75, label: 'Not extended', why: 'Within 15% of SMA 50 and RSI under 75' },
      { ok: ind.rs != null && ind.rs > 0, label: 'Beating the S&P 500', why: 'Over the last 6 months' },
      { ok: ind.mktUp === true, label: 'Market in uptrend', why: 'S&P 500 above its SMA 200' },
    ];
    return {
      verdict: v, label: LABELS[v], rank: RANK[v], headline: headlineFor(v, ind), ind, checks,
      trend, timing, score: trend + timing + (ind.rs > 0 ? 5 : 0),
      leader: ind.rs == null ? null : ind.rs > 0,
      since, prevVerdict, record, S
    };
  }

  // Correlation of daily returns over the last `days` sessions, aligned by trading day
  function correlation(a, b, days = 252) {
    const mb = new Map(); b.t.forEach((ts, i) => { if (i > 0) mb.set(dayKey(ts), b.c[i] / b.c[i - 1] - 1); });
    const x = [], y = [];
    for (let i = Math.max(1, a.c.length - days); i < a.c.length; i++) {
      const rb = mb.get(dayKey(a.t[i])); if (rb == null) continue;
      x.push(a.c[i] / a.c[i - 1] - 1); y.push(rb);
    }
    if (x.length < 60) return null;
    const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxy / Math.sqrt(sxx * syy);
  }

  const api = { smaSeries, rsiSeries, volSeries, marketContext, build, classify, analyze, correlation, LABELS, RANK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (typeof globalThis !== 'undefined' ? globalThis : root).TC = api;
})(this);
