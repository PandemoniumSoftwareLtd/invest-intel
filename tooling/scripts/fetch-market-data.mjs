// Usage: node scripts/fetch-market-data.mjs [symbols=market-symbols.json] [out=market.json]
// Fetches ~1y daily prices + key stats/fundamentals from free public sources at build time:
//   FT Markets (chart series + tearsheet key stats) for listed shares/ETFs,
//   Nasdaq (annual financial statements) for US listings / ADRs,
//   CoinGecko (price history, market cap, supply, volume) for crypto.
// The symbol map is local and gitignored (it reveals the watchlist). Output is plaintext → gitignored;
// build.mjs merges it into the encrypted payload. Anything that fails is listed in `missing`, never guessed.
import fs from "node:fs";
const [symPath = "market-symbols.json", out = "market.json"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SYMS = JSON.parse(fs.readFileSync(symPath, "utf8"));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, opts = {}, tries = 3) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { ...opts, headers: { "user-agent": UA, ...(opts.headers || {}) } });
      if (r.status === 429) { await sleep(5000 * (k + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) { if (k === tries - 1) throw e; await sleep(1500); }
  }
  throw new Error("rate limited");
}
const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const strip = (s) => unesc(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const num = (s) => { if (s == null) return null; const t = String(s).replace(/[$,%\s]/g, ""); if (!t || t === "--" || t === "N/A") return null; const v = Number(t); return Number.isFinite(v) ? v : null; };
const ymd = (d) => d.toISOString().slice(0, 10);

// ---------- FT ----------
async function ftTearsheet(sym, cls = "equities") {
  const url = `https://markets.ft.com/data/${cls}/tearsheet/summary?s=${encodeURIComponent(sym)}`;
  const html = await (await get(url)).text();
  const xid = (html.match(/xid&quot;:&quot;(\d+)/) || [])[1];
  if (!xid) throw new Error("FT xid not found");
  const stats = {};
  for (const m of html.matchAll(/<th[^>]*>([\s\S]{1,120}?)<\/th>\s*<td[^>]*>([\s\S]{0,200}?)<\/td>/g)) stats[strip(m[1])] = strip(m[2]);
  for (const m of html.matchAll(/mod-ui-data-list__label">([^<]+)<\/span>\s*<span class="mod-ui-data-list__value">([^<]+)/g)) stats[strip(m[1])] = strip(m[2]);
  const asOf = (strip(html).match(/as of ([A-Z][a-z]{2} \d{1,2} \d{4}(?: \d{1,2}:\d{2} [A-Z]{2,4})?)/) || [])[1] || null;
  const currency = (html.match(/currency&quot;:&quot;([A-Z]{3})/) || [])[1] || null;
  return { url, xid, stats, asOf, currency };
}
async function ftSeries(xid) {
  const body = { days: 380, dataNormalized: false, dataPeriod: "Day", dataInterval: 1, realtime: false, yFormat: "0.###",
    timeServiceFormat: "JSON", returnDateType: "ISO8601", elements: [{ Type: "price", Symbol: xid, OverlayIndicators: [], Params: {} }] };
  const j = await (await get("https://markets.ft.com/data/chartapi/series", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const el = j.Elements?.[0]; const close = el?.ComponentSeries?.find((c) => c.Type === "Close")?.Values;
  if (!close?.length) throw new Error("FT series empty");
  const dates = j.Dates.map((d) => d.slice(0, 10));
  const pts = dates.map((d, i) => [d, close[i]]).filter((p) => p[1] != null);
  return { currency: el.Currency || null, pts };
}
const KEEP = { "Market cap": "marketCap", "P/E (TTM)": "pe", "EPS (TTM)": "eps", "Annual div yield (ADY)": "divYield", "Shares outstanding": "shares",
  "Beta": "beta", "Fund size": "fundSize", "Ongoing charge": "ongoingCharge", "Net assets": "netAssets", "Price/Book": "pb", "52 week range": "range52w" };

// ---------- Nasdaq ----------
async function nasdaqFin(sym) {
  const url = `https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/financials?frequency=1`;
  const j = await (await get(url, { headers: { accept: "application/json" } })).json();
  const d = j.data; if (!d?.incomeStatementTable) throw new Error("no Nasdaq financials");
  const h = d.incomeStatementTable.headers; const cols = ["value2", "value3", "value4", "value5"].filter((c) => h[c]);
  const row = (t, name) => { const r = d[t]?.rows?.find((x) => x.value1 === name); return r ? cols.map((c) => num(r[c])) : cols.map(() => null); };
  const periods = cols.map((c) => h[c]);
  const revenue = row("incomeStatementTable", "Total Revenue"), gross = row("incomeStatementTable", "Gross Profit"),
    opInc = row("incomeStatementTable", "Operating Income"), netInc = row("incomeStatementTable", "Net Income"),
    ocf = row("cashFlowTable", "Net Cash Flow-Operating"), capex = row("cashFlowTable", "Capital Expenditures");
  const fcf = ocf.map((v, i) => (v != null && capex[i] != null ? v + capex[i] : null));
  const cash = row("balanceSheetTable", "Cash and Cash Equivalents")[0], sti = row("balanceSheetTable", "Short-Term Investments")[0] || 0,
    std = row("balanceSheetTable", "Short-Term Debt / Current Portion of Long-Term Debt")[0] || 0, ltd = row("balanceSheetTable", "Long-Term Debt")[0] || 0;
  // Nasdaq reports in USD thousands; convert to USD millions.
  const m = (a) => a.map((v) => (v == null ? null : Math.round(v / 1000)));
  return { source: "Nasdaq (annual financial statements)", url: `https://www.nasdaq.com/market-activity/stocks/${sym.toLowerCase()}/financials`,
    unit: "USD m", periods, revenue: m(revenue), grossProfit: m(gross), operatingIncome: m(opInc), netIncome: m(netInc), operatingCashFlow: m(ocf),
    capex: m(capex), fcf: m(fcf), cash: cash == null ? null : Math.round((cash + sti) / 1000), debt: Math.round((std + ltd) / 1000) };
}

// ---------- CoinGecko ----------
async function gecko(id) {
  const base = "https://api.coingecko.com/api/v3/coins/" + id;
  const c = await (await get(`${base}?localization=false&tickers=false&community_data=false&developer_data=false`)).json();
  await sleep(2500);
  const ch = await (await get(`${base}/market_chart?vs_currency=usd&days=365&interval=daily`)).json();
  const byDay = new Map(); for (const [t, p] of ch.prices) byDay.set(ymd(new Date(t)), p);
  const md = c.market_data;
  return { pts: [...byDay.entries()].map(([d, p]) => [d, +p.toPrecision(6)]), md: {
    price: md.current_price?.usd, marketCap: md.market_cap?.usd, volume24h: md.total_volume?.usd, change24h: md.price_change_percentage_24h,
    circulating: md.circulating_supply, total: md.total_supply, max: md.max_supply, ath: md.ath?.usd, athDate: md.ath_date?.usd?.slice(0, 10),
    rank: c.market_cap_rank, lastUpdated: md.last_updated }, url: `https://www.coingecko.com/en/coins/${id}` };
}

// ---------- FX (ECB reference rates via Frankfurter; used to value portfolio holdings in one currency) ----------
async function fetchFx() {
  const url = "https://api.frankfurter.dev/v1/latest?base=GBP&symbols=USD,EUR,SEK,AUD,CAD,CHF,JPY,HKD,DKK,NOK";
  const j = await (await get(url, { headers: { accept: "application/json" } })).json();
  if (!j.rates || !j.rates.USD) throw new Error("no FX rates");
  return { base: "GBP", date: j.date, rates: j.rates, source: "ECB reference rates (via Frankfurter)", url: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html" };
}
if (process.argv.includes("--fx-only")) {
  // Refresh only the FX block of an existing market.json
  const cur = JSON.parse(fs.readFileSync(out, "utf8"));
  cur.fx = await fetchFx(); fs.writeFileSync(out, JSON.stringify(cur));
  console.log(`FX updated (${cur.fx.date}).`); process.exit(0);
}

const result = { fetchedAt: new Date().toISOString(), assets: {}, missing: [] };
try { result.fx = await fetchFx(); console.log(`FX: ${result.fx.date}`); } catch (e) { result.missing.push({ name: "FX rates", missing: ["FX rates: " + e.message] }); }
for (const [name, s] of Object.entries(SYMS)) {
  const a = { liveUrl: s.yahoo ? `https://finance.yahoo.com/quote/${encodeURIComponent(s.yahoo)}` : null, liveLabel: "Yahoo Finance" };
  const miss = [];
  try {
    if (s.coingecko) {
      const g = await gecko(s.coingecko);
      a.price = { source: "CoinGecko", url: g.url, currency: "USD", pts: g.pts };
      a.crypto = { source: "CoinGecko", url: g.url, asOf: g.md.lastUpdated, ...g.md };
      await sleep(2500);
    }
    if (s.ft) {
      const t = await ftTearsheet(s.ft, s.ftClass);
      const stats = {}; for (const [k, v] of Object.entries(t.stats)) if (KEEP[k] && v && v !== "--") stats[KEEP[k]] = v;
      a.stats = { source: "FT Markets", url: t.url, asOf: t.asOf, ...stats };
      try { const sr = await ftSeries(t.xid); a.price = { source: "FT Markets", url: t.url.replace("/summary?", "/charts?"), currency: sr.currency || t.currency, pts: sr.pts }; }
      catch (e) { miss.push("price history: " + e.message); }
      await sleep(400);
    }
    if (s.nasdaq) {
      try { a.financials = await nasdaqFin(s.nasdaq); } catch (e) { miss.push("financial statements: " + e.message); }
      await sleep(400);
    } else if (!s.coingecko) miss.push("financial statements (no free statement source for this listing)");
  } catch (e) { miss.push("all market data: " + e.message); }
  if (!a.price) miss.push("price history");
  if (a.price) {
    const p = a.price.pts; const last = p[p.length - 1], prev = p[p.length - 2];
    a.price.last = last[1]; a.price.asOf = last[0]; a.price.change1d = prev ? +(((last[1] / prev[1]) - 1) * 100).toFixed(2) : null;
  }
  result.assets[name] = a;
  if (miss.length) result.missing.push({ name, missing: miss });
  console.log(`${name}: ${a.price ? a.price.pts.length + " days" : "no prices"}${a.financials ? ", financials" : ""}${a.stats ? ", stats" : ""}${a.crypto ? ", crypto stats" : ""}${miss.length ? " | missing: " + miss.join("; ") : ""}`);
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(`Wrote ${out}; ${result.missing.length} assets with gaps.`);
