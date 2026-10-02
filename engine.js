// TrendCheck signal engine: SMA 20/50/100/200 + RSI(14, Wilder) -> verdict
(function (root) {
  function sma(c, n, end) { // end = index (inclusive)
    if (end + 1 < n) return null;
    let s = 0; for (let i = end - n + 1; i <= end; i++) s += c[i];
    return s / n;
  }
  function smaSeries(c, n) {
    const out = new Array(c.length).fill(null); let s = 0;
    for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) out[i] = s / n; }
    return out;
  }
  function rsiSeries(c, n = 14) { // Wilder's smoothing (Wilder, 1978)
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
  const pct = (a, b) => (a == null || b == null || b === 0) ? null : (a / b - 1) * 100;

  function analyze(c) {
    const i = c.length - 1;
    const price = c[i];
    const s20 = sma(c, 20, i), s50 = sma(c, 50, i), s100 = sma(c, 100, i), s200 = sma(c, 200, i);
    const s200prev = sma(c, 200, i - 20);
    const rsiArr = rsiSeries(c, 14);
    const rsi = rsiArr[i];
    const enough = s200 != null && rsi != null;
    const ind = { price, s20, s50, s100, s200, s200prev, rsi,
      d20: pct(price, s20), d50: pct(price, s50), d100: pct(price, s100), d200: pct(price, s200) };
    if (!enough) {
      return { ind, verdict: 'NODATA', label: 'Not enough history', score: null, headline: 'Needs at least 200 trading days of prices.', checks: [] };
    }
    const aboveS200 = price > s200;
    const golden = s50 > s200;
    const shortUp = s20 > s50;
    const s200Rising = s200prev != null ? s200 > s200prev : null;
    const notOverbought = rsi < 70;
    const buyZone = rsi >= 30 && rsi <= 50;
    const nearSupport = (Math.abs(ind.d20) <= 3) || (Math.abs(ind.d50) <= 3);
    const stretched = ind.d50 > 15;
    const aboveCount = [s20, s50, s100, s200].filter(s => price > s).length;

    const checks = [
      { ok: aboveS200, label: 'Price above SMA 200', why: 'Long-term uptrend' },
      { ok: golden, label: 'SMA 50 above SMA 200', why: 'Golden cross in place' },
      { ok: shortUp, label: 'SMA 20 above SMA 50', why: 'Short-term momentum up' },
      { ok: s200Rising === true, label: 'SMA 200 rising', why: 'vs. 20 sessions ago' },
      { ok: notOverbought, label: 'RSI below 70', why: 'Not overbought' },
      { ok: buyZone, label: 'RSI between 30 and 50', why: 'Pullback zone' },
      { ok: nearSupport, label: 'Within 3% of SMA 20 or 50', why: 'Buying near support' },
    ];

    // Score 0-100: trend (60) + timing (40)
    let trend = (aboveS200 ? 25 : 0) + (golden ? 15 : 0) + (shortUp ? 10 : 0) + (s200Rising ? 10 : 0);
    let timing = rsi < 30 ? 30 : rsi < 40 ? 40 : rsi < 50 ? 32 : rsi < 60 ? 22 : rsi < 70 ? 10 : 0;
    if (nearSupport && rsi < 60) timing = Math.min(40, timing + 5);
    if (stretched) timing = Math.max(0, timing - 10);
    let score = trend + timing;
    const downtrend = !aboveS200 && !golden;
    if (downtrend) score = Math.min(score, 30);

    let verdict, headline;
    if (downtrend) {
      verdict = 'AVOID';
      headline = rsi < 30
        ? 'Oversold, but price and SMA 50 are below SMA 200. Catching a falling knife.'
        : 'Price and SMA 50 are below SMA 200. Long-term downtrend.';
    } else if (rsi >= 70 || stretched) {
      verdict = 'WAIT';
      headline = rsi >= 70
        ? `RSI ${rsi.toFixed(0)} is overbought. Wait for a pullback toward SMA 20 or 50.`
        : `Price is ${ind.d50.toFixed(1)}% above SMA 50. Stretched; wait for a pullback.`;
    } else if (aboveS200 && golden) {
      if (rsi <= 40) { verdict = 'STRONG'; headline = `Uptrend with RSI ${rsi.toFixed(0)}. A pullback inside a healthy trend.`; }
      else if (rsi <= 55 && (nearSupport || price < s20)) { verdict = 'BUY'; headline = 'Uptrend intact and price is sitting near support.'; }
      else if (rsi <= 55) { verdict = 'BUY'; headline = 'Uptrend intact with neutral RSI. Reasonable entry.'; }
      else { verdict = 'HOLD'; headline = 'Uptrend intact but no discount. Good to hold, small adds only.'; }
    } else if (aboveS200 && !golden) {
      verdict = 'WATCH'; headline = 'Price reclaimed SMA 200 but SMA 50 is still below it. Early recovery, unconfirmed.';
    } else {
      verdict = 'WATCH'; headline = 'Price slipped under SMA 200 while SMA 50 is still above it. Trend is being tested.';
    }
    const labels = { STRONG: 'Strong buy', BUY: 'Buy', HOLD: 'Hold', WATCH: 'Watch', WAIT: 'Wait', AVOID: 'Avoid' };
    return { ind, verdict, label: labels[verdict], score: Math.round(score), trend, timing, headline, checks, aboveCount };
  }
  const api = { sma, smaSeries, rsiSeries, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC = api;
})(this);
