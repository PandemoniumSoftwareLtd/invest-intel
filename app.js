"use strict";
// Invest Intel — the app shell holds NO dashboard data. data.enc.json is AES-GCM encrypted;
// the key is derived in-browser from the passcode with PBKDF2-SHA256.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();

  // ---------- settings (localStorage; nothing sensitive) ----------
  const DEFAULTS = { checkEvery: "open", autoRefresh: false, theme: "system", remember: true, startView: "Focus", density: "comfortable" };
  const S = Object.assign({}, DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem("settings") || "{}"); } catch { return {}; } })());
  const saveSettings = () => localStorage.setItem("settings", JSON.stringify(S));
  function applyLook() {
    const r = document.documentElement;
    if (S.theme === "system") delete r.dataset.theme; else r.dataset.theme = S.theme;
    document.body.classList.toggle("compact", S.density === "compact");
  }
  applyLook();
  $("#remember").checked = S.remember;

  // ---------- key storage (IndexedDB, non-extractable CryptoKey) ----------
  const DB = "invest-intel", STORE = "keys";
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idbOp = async (mode, fn) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode); const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error);
    });
  };
  const saveKey = (k, salt) => idbOp("readwrite", (s) => s.put({ key: k, salt }, "k"));
  const loadKey = () => idbOp("readonly", (s) => s.get("k")).catch(() => null);
  const clearKey = () => idbOp("readwrite", (s) => s.delete("k")).catch(() => {});

  // ---------- crypto ----------
  let payload = null, currentKey = null;
  async function getPayload() {
    const r = await fetch("data.enc.json", { cache: "no-store" });
    if (!r.ok) throw new Error("Could not load data (" + r.status + ")");
    return r.json();
  }
  async function deriveKey(pass, p) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64(p.salt), iterations: p.iterations },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }
  async function decrypt(key, p) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(p.iv) }, key, b64(p.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---------- lock screen ----------
  async function tryRemembered() {
    if (!S.remember) return false;
    const saved = await loadKey();
    if (!saved || !saved.key) return false;
    try {
      payload = payload || await getPayload();
      if (saved.salt !== payload.salt) { await clearKey(); return false; }
      const data = await decrypt(saved.key, payload); currentKey = saved.key; start(data); return true;
    } catch { await clearKey(); return false; }
  }
  $("#lockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = $("#pass").value; const btn = $("#unlockBtn"); const msg = $("#lockMsg");
    msg.textContent = ""; btn.disabled = true; btn.textContent = "Unlocking…";
    try {
      payload = await getPayload();
      const key = await deriveKey(pass, payload);
      let data;
      try { data = await decrypt(key, payload); } catch { throw new Error("Wrong passcode"); }
      S.remember = $("#remember").checked; saveSettings();
      if (S.remember) await saveKey(key, payload.salt).catch(() => {});
      currentKey = key; $("#pass").value = ""; start(data);
    } catch (err) { msg.textContent = err.message || "Could not unlock"; }
    finally { btn.disabled = false; btn.textContent = "Unlock"; }
  });
  async function lockNow() { await clearKey(); currentKey = null; location.reload(); }
  $("#lockBtn").addEventListener("click", lockNow);
  $("#themeBtn").addEventListener("click", () => {
    const dark = S.theme === "dark" || (S.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    S.theme = dark ? "light" : "dark"; saveSettings(); applyLook(); if (D) render();
  });

  // ---------- app constants ----------
  const THEMES = ["Defence", "AI supply chain", "Crypto"];
  const ACTIONS = ["Buy", "Accumulate on dips", "Watch", "Trim", "Avoid"];
  const FACTORS = [
    { key: "m", label: "Theme momentum / catalyst strength", short: "Mom", what: "Strength of the theme and news flow" },
    { key: "f", label: "Business fundamentals", short: "Fund", what: "Cash generation, margins, balance sheet (network health for crypto)" },
    { key: "p", label: "Market position / share", short: "Pos", what: "Moat, share, pricing power" },
    { key: "pa", label: "Partnerships & customer concentration", short: "Partn", what: "Quality of partners; higher = less concentration" },
    { key: "v", label: "Valuation vs growth", short: "Val", what: "Higher = cheaper relative to growth" },
    { key: "t", label: "Timing / near-term catalyst", short: "Time", what: "A dated catalyst in the next ~6 weeks" },
    { key: "r", label: "Risk", short: "Risk", what: "Higher = lower risk" },
  ];
  const ACTION_TONE = { Buy: "success", "Accumulate on dips": "accent", Watch: "neutral", Trim: "warning", Avoid: "danger" };
  const STANCE_TONE = { Overweight: "success", Neutral: "neutral", Underweight: "warning" };
  const DIR_TONE = { Positive: "success", Negative: "danger", Mixed: "neutral", Pending: "neutral" };
  const IMPACT_TONE = { Positive: "success", Negative: "danger", Mixed: "neutral" };
  const VIEWS = ["Focus", "Scoreboard", "Themes", "Crypto", "Calendar", "Sources"];
  const TABS = [["Focus", "◎"], ["Scoreboard", "≡"], ["Themes", "◇"], ["Crypto", "₿"], ["Calendar", "▦"], ["Sources", "↗"], ["Settings", "⚙"]];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const RANGES = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366 };
  const CHECK = { open: ["On open only", 0], "15m": ["Every 15 min", 15], "1h": ["Every hour", 60], "4h": ["Every 4 hours", 240] };

  let D, W, ranked, st, pending = null, timer = null;
  const IDEA_VIEWS = ["Focus", "Scoreboard", "Themes", "Crypto"];
  const isWide = () => matchMedia("(min-width: 900px)").matches;
  // global filters (theme, action, min score) apply to every idea list
  const vis = (arr) => arr.filter((i) => (st.fTheme === "All" || i.theme === st.fTheme) && (st.fAction === "All" || i.action === st.fAction) && score10(i) >= Number(st.fMin) * 10);
  const pill = (t, tone) => `<span class="pill t-${tone}">${esc(t)}</span>`;
  const score10 = (i) => Math.round(FACTORS.reduce((a, f) => a + i.s[f.key] * W[f.key], 0) / 10);
  const fmt = (t) => (t / 10).toFixed(1);
  const byScore = (a, b) => score10(b) - score10(a);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dLabel = (s) => { const [y, m, d] = s.slice(0, 10).split("-"); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
  function asOfDate() {
    const m = /(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})/.exec(D.asOf);
    return m ? new Date(+m[3], MONTHS.indexOf(m[2]), +m[1]) : new Date();
  }
  const mkt = (i) => (D.market && D.market.assets && D.market.assets[i.name]) || null;
  const keyOf = (i) => i.ticker + "|" + i.name;

  // ---------- number formatting ----------
  const big = (v, cur = "$") => {
    if (v == null) return "—"; const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e12) return `${s}${cur}${(a / 1e12).toFixed(2)}tn`; if (a >= 1e9) return `${s}${cur}${(a / 1e9).toFixed(1)}bn`;
    if (a >= 1e6) return `${s}${cur}${(a / 1e6).toFixed(1)}m`; return `${s}${cur}${a.toLocaleString("en-GB")}`;
  };
  const usdM = (v) => (v == null ? "—" : big(v * 1e6));
  const pct = (v, dp = 1) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}%`);
  const pctPlain = (v, dp = 1) => (v == null || !isFinite(v) ? "—" : `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}%`);
  function money(v, cur) {
    if (v == null) return "—";
    const dp = v >= 1000 ? 0 : v >= 10 ? 2 : 3;
    const n = v.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    if (cur === "GBp" || cur === "GBX") return n + "p";
    const sym = { USD: "$", GBP: "£", EUR: "€", AUD: "A$", SEK: "SEK " }[cur];
    return sym ? sym + n : `${n} ${cur || ""}`.trim();
  }

  // ---------- start / render plumbing ----------
  function start(data) {
    D = data; W = data.weights; ranked = [...D.ideas].sort(byScore);
    const base = asOfDate();
    const saved = sessionStorage.getItem("view");
    st = { view: saved || (VIEWS.includes(S.startView) ? S.startView : "Focus"), group: "All", action: "All", sort: "overall", cols: "Decision",
      theme: "Defence", cal: "All", month: iso(base).slice(0, 7), detail: null, range: "6M", back: null,
      q: "", fTheme: "All", fAction: "All", fMin: "0", showFilters: false };
    $("#lock").hidden = true; $("#app").hidden = false;
    $("#tabs").innerHTML = `<div class="navIn"><div class="brand"><img src="icons/icon-192.png" alt="" width="28" height="28"><span>Invest Intel</span></div>`
      + TABS.map(([v, ic], n) => `<button data-tab="${v}" aria-keyshortcuts="${n + 1}"><span class="ic">${ic}</span><span class="tl">${v}</span><kbd>${n + 1}</kbd></button>`).join("")
      + `<div class="kbhelp"><kbd>/</kbd> search · <kbd>j</kbd><kbd>k</kbd> move · <kbd>Esc</kbd> close</div></div>`;
    $("#tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) goTab(b.dataset.tab); };
    $("#q").oninput = (e) => { st.q = e.target.value; render(); };
    $("#filtBtn").onclick = () => { st.showFilters = !st.showFilters; renderFilters(); };
    $("#filters").onclick = (e) => { const b = e.target.closest("[data-f]"); if (!b) return; if (b.dataset.f === "clear") { st.fTheme = "All"; st.fAction = "All"; st.fMin = "0"; } else st[b.dataset.f] = b.dataset.val; renderFilters(); render(); };
    $("#filters").onchange = (e) => { const t = e.target.closest("select[data-f]"); if (t) { st[t.dataset.f] = t.value; renderFilters(); render(); } };
    let rt; window.onresize = () => { clearTimeout(rt); rt = setTimeout(render, 150); };
    document.addEventListener("keydown", onKey);
    renderFilters();
    $("#view").onclick = onClick; $("#view").onchange = onChange;
    $("#banner").onclick = (e) => { if (e.target.closest("[data-apply]")) applyPending(); if (e.target.closest("[data-dismiss]")) hideBanner(); };
    window.onpopstate = () => { if (st.detail) { st.detail = null; render(); } };
    render(); schedule();
  }

  function onClick(e) {
    if (e.target.closest("a")) return;
    const act = e.target.closest("[data-act]");
    if (act) {
      const a = act.dataset.act;
      if (a === "back") { history.length > 1 && history.state && history.state.detail ? history.back() : (st.detail = null, render()); return; }
      if (a === "lock") { lockNow(); return; }
      if (a === "check") { checkNow(true); return; }
    }
    const c = e.target.closest("[data-set]");
    if (c) { st[c.dataset.set] = c.dataset.val; render(); return; }
    const s = e.target.closest("button[data-setting]");
    if (s) { setSetting(s.dataset.setting, s.dataset.val); return; }
    const ka = e.target.closest("[data-kpi-action]");
    if (ka) { st.fAction = st.fAction === ka.dataset.kpiAction ? "All" : ka.dataset.kpiAction; renderFilters(); render(); return; }
    const g = e.target.closest("[data-goto]"); if (g) { goTab(g.dataset.goto); return; }
    const card = e.target.closest("[data-open]");
    if (card) openDetail(card.dataset.open);
  }
  function onChange(e) {
    const s = e.target.closest("select[data-set]"); if (s) { st[s.dataset.set] = s.value; render(); return; }
    const t = e.target.closest("[data-setting]"); if (t) setSetting(t.dataset.setting, t.type === "checkbox" ? t.checked : t.value);
  }
  function goTab(v) {
    st.view = v; st.detail = null; st.q = ""; $("#q").value = ""; sessionStorage.setItem("view", v); render(); scrollTo(0, 0);
  }
  function openDetail(k) {
    st.detail = k; st.range = "6M";
    if (isWide() && splitOn()) { render(); const p = $(".detailpane"); if (p) p.scrollTop = 0; return; }
    history.pushState({ detail: k }, ""); render(); scrollTo(0, 0);
  }
  const splitOn = () => isWide() && (IDEA_VIEWS.includes(st.view) || st.q.trim() !== "");
  function onKey(e) {
    if (!D || $("#app").hidden) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === "Escape") {
      if (st.q) { st.q = ""; $("#q").value = ""; $("#q").blur(); render(); }
      else if (typing) e.target.blur();
      else if (st.showFilters) { st.showFilters = false; renderFilters(); }
      else if (st.detail) { if (!splitOn() && history.state && history.state.detail) history.back(); else { st.detail = null; render(); } }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
    if (/^[1-7]$/.test(e.key)) { goTab(TABS[+e.key - 1][0]); return; }
    if ((e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") && splitOn()) {
      const ks = [...new Set([...document.querySelectorAll(".listpane .idea[data-open]")].map((x) => x.dataset.open))]; if (!ks.length) return;
      e.preventDefault(); const cur = ks.indexOf(st.detail || selKey()); const n = Math.max(0, Math.min(ks.length - 1, cur + (e.key === "j" || e.key === "ArrowDown" ? 1 : -1)));
      openDetail(ks[n]); const el = document.querySelector(`.listpane .idea[data-open="${CSS.escape(ks[n])}"]`); if (el) el.scrollIntoView({ block: "nearest" });
    }
  }
  function renderFilters() {
    const n = (st.fTheme !== "All") + (st.fAction !== "All") + (st.fMin !== "0");
    $("#fcount").hidden = !n; $("#fcount").textContent = n; $("#filtBtn").setAttribute("aria-expanded", st.showFilters);
    $("#filters").hidden = !st.showFilters;
    const fc = (key, opts) => `<div class="chips">${opts.map((o) => `<button data-f="${key}" data-val="${esc(o)}" class="${st[key] === o ? "on" : ""}">${esc(o)}</button>`).join("")}</div>`;
    $("#filters").innerHTML = `<div class="slbl">Theme</div>${fc("fTheme", ["All", ...THEMES])}<div class="slbl">Action</div>${fc("fAction", ["All", ...ACTIONS])}
      <div class="frow"><label class="slbl" for="fMin">Min score</label><select id="fMin" data-f="fMin">${["0", "5", "6", "7", "7.5", "8"].map((v) => `<option value="${v}"${st.fMin === v ? " selected" : ""}>${v === "0" ? "Any" : v + "+"}</option>`).join("")}</select>
      <button class="btn" data-f="clear">Clear</button></div><div class="tk">Filters apply to every idea list, the KPI strip and search.</div>`;
  }
  function selKey() {
    if (st.detail) return st.detail;
    const first = document.querySelector(".listpane .idea[data-open]"); return first ? first.dataset.open : null;
  }

  async function setSetting(k, v) {
    if (k === "autoRefresh" || k === "remember") v = v === true || v === "true";
    S[k] = v; saveSettings();
    if (k === "theme" || k === "density") applyLook();
    if (k === "checkEvery") schedule();
    if (k === "remember") {
      if (v && currentKey && payload) await saveKey(currentKey, payload.salt).catch(() => {});
      if (!v) await clearKey();
    }
    render();
  }

  // ---------- new-data checks ----------
  function schedule() {
    clearInterval(timer); const mins = CHECK[S.checkEvery] ? CHECK[S.checkEvery][1] : 0;
    if (mins) timer = setInterval(() => checkNow(false), mins * 60000);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && D) checkNow(false); });
  let lastCheck = null, checkMsg = "";
  async function checkNow(manual) {
    try {
      const p = await getPayload(); lastCheck = new Date();
      if (payload && p.iv === payload.iv) { checkMsg = "Up to date"; if (manual && st.view === "Settings") render(); return; }
      let data = null;
      try { if (currentKey && p.salt === payload.salt) data = await decrypt(currentKey, p); } catch {}
      pending = { p, data };
      if (data && S.autoRefresh) { applyPending(); return; }
      checkMsg = "New research available"; showBanner(data ? `New research available (as of ${data.asOf}).` : "New research is published. Unlock again to load it.");
      if (st.view === "Settings") render();
    } catch { checkMsg = "Offline: could not check"; if (manual && st.view === "Settings") render(); }
  }
  function applyPending() {
    if (!pending) return;
    if (!pending.data) { lockNow(); return; }
    payload = pending.p; D = pending.data; W = D.weights; ranked = [...D.ideas].sort(byScore); pending = null; checkMsg = "Updated";
    hideBanner(); render();
  }
  function showBanner(msg) {
    const b = $("#banner"); b.hidden = false;
    b.innerHTML = `<span>${esc(msg)}</span><button data-apply>Refresh</button><button data-dismiss aria-label="Dismiss">✕</button>`;
  }
  function hideBanner() { $("#banner").hidden = true; }

  // ---------- shared components ----------
  const chips = (key, opts) => `<div class="chips">${opts.map((o) => {
    const [v, l, n] = Array.isArray(o) ? o : [o, o];
    return `<button data-set="${key}" data-val="${esc(v)}" class="${st[key] === v ? "on" : ""}">${esc(l)}${n != null ? `<span class="cnt">${n}</span>` : ""}</button>`;
  }).join("")}</div>`;
  const seg = (setting, opts) => `<div class="chips">${opts.map(([v, l]) =>
    `<button data-setting="${setting}" data-val="${esc(v)}" class="${String(S[setting]) === String(v) ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`;
  const select = (key, label, opts) => `<select data-set="${key}" aria-label="${esc(label)}">${opts.map(([v, l]) =>
    `<option value="${esc(v)}"${st[key] === v ? " selected" : ""}>${esc(label)}: ${esc(l)}</option>`).join("")}</select>`;
  const list = (rows) => `<div class="card list">${rows.map((r) => `<div class="item"><div class="lead">${esc(r.lead)}</div><div class="body">
    <div class="ttl">${esc(r.title)}</div>${r.detail ? `<div class="det">${esc(r.detail)}</div>` : ""}</div>${r.pill || ""}</div>`).join("")}</div>`;
  const linkList = (links) => `<div class="card list links">${links.map((l) => `<a class="item" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">
    <div class="body"><div class="ttl">${esc(l.title)}</div><div class="det">${esc(l.site)}${l.date ? " · " + esc(l.date) : ""}</div></div></a>`).join("")}</div>`;
  const ext = (href, label) => href ? `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : "";

  function spark(i) {
    const m = mkt(i); if (!m || !m.price) return "";
    const pts = m.price.pts.slice(-92).map((p) => p[1]); if (pts.length < 2) return "";
    const lo = Math.min(...pts), hi = Math.max(...pts), w = 70, h = 22;
    const d = pts.map((v, k) => `${(k / (pts.length - 1) * w).toFixed(1)},${(h - (v - lo) / ((hi - lo) || 1) * h).toFixed(1)}`).join(" ");
    const up = pts[pts.length - 1] >= pts[0];
    return `<svg class="spark ${up ? "up" : "dn"}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${d}"/></svg>`;
  }

  function ideaCard(i, opts = {}) {
    const body = opts.body ?? i.trigger; const m = mkt(i);
    const px = m && m.price ? `<span class="px">${money(m.price.last, m.price.currency)} <span class="${m.price.change1d >= 0 ? "pos" : "neg"}">${pct(m.price.change1d)}</span></span>` : "";
    return `<button class="card idea${st.detail === keyOf(i) ? " sel" : ""}" data-open="${esc(keyOf(i))}" aria-label="Open ${esc(i.name)} details"${st.detail === keyOf(i) ? ' aria-current="true"' : ""}>
      <div class="row1"><div><div class="nm">${esc(i.name)} <span class="tk">${esc(i.ticker)} · ${esc(i.listing)}</span></div>
      <div>${pill(i.action, ACTION_TONE[i.action])} <span class="tk">${esc(i.theme)} · ${esc(i.role)}</span></div></div>
      <div class="rt"><div class="score">${fmt(score10(i))}</div>${spark(i)}</div></div>
      ${px ? `<div class="cat">${px}</div>` : ""}
      ${opts.link && i.link ? `<div class="cat">${esc(i.link)}</div>` : ""}
      ${body ? `<div class="trig">${esc(body)}</div>` : ""}
      <div class="cat">Next: ${esc(i.catalystDate)} · ${esc(i.catalyst)} <span class="chev">›</span></div></button>`;
  }

  function bars(items) {
    return `<div class="card bars">${items.map((i) => `<button class="b" data-open="${esc(keyOf(i))}"><div class="lbl">${esc(i.name)}</div>
      <div class="track"><div class="fill" data-w="${score10(i)}"></div></div><div class="v">${fmt(score10(i))}</div></button>`).join("")}</div>`;
  }

  function scatter(pts, xName, yName, x0, x1, y0, y1, sized) {
    const Wd = 340, H = 250, L = 30, R = 10, T = 10, B = 30;
    const sx = (v) => L + (v - x0) / (x1 - x0) * (Wd - L - R), sy = (v) => H - B - (v - y0) / (y1 - y0) * (H - T - B);
    let g = "";
    for (let v = x0; v <= x1; v += (x1 - x0) / 5) g += `<line class="ax" x1="${sx(v)}" x2="${sx(v)}" y1="${T}" y2="${H - B}"/><text x="${sx(v)}" y="${H - B + 12}" text-anchor="middle">${+v.toFixed(1)}</text>`;
    for (let v = y0; v <= y1; v += (y1 - y0) / 6) g += `<line class="ax" x1="${L}" x2="${Wd - R}" y1="${sy(v)}" y2="${sy(v)}"/><text x="${L - 4}" y="${sy(v) + 3}" text-anchor="end">${+v.toFixed(1)}</text>`;
    const dots = pts.map((p) => {
      const r = sized ? 2 + p.size * 0.7 : 4.5;
      return `<g class="pt" data-open="${esc(p.k)}"><circle class="d${THEMES.indexOf(p.series)}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${r.toFixed(1)}" fill-opacity="0.8"/>
      <text class="lab" x="${(sx(p.x) + r + 1.5).toFixed(1)}" y="${(sy(p.y) + 3).toFixed(1)}">${esc(p.label)}</text></g>`;
    }).join("");
    return `<div class="card"><svg class="sc" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="${esc(yName)} vs ${esc(xName)}">${g}${dots}
      <text x="${(L + Wd - R) / 2}" y="${H - 4}" text-anchor="middle">${esc(xName)}</text></svg>
      <div class="legend">${THEMES.map((t, n) => `<span><i class="l${n}"></i>${esc(t)}</span>`).join("")}<span>↑ ${esc(yName)}</span></div></div>`;
  }

  function monthGrid(ym) {
    const [y, m] = ym.split("-").map(Number); const first = new Date(y, m - 1, 1); const days = new Date(y, m, 0).getDate();
    const off = (first.getDay() + 6) % 7; const today = iso(asOfDate());
    let h = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="dh">${d}</div>`).join("");
    for (let k = 0; k < off; k++) h += `<div class="day empty"></div>`;
    for (let d = 1; d <= days; d++) {
      const ds = `${ym}-${String(d).padStart(2, "0")}`;
      const evs = D.catalysts.filter((c) => c.date === ds);
      h += `<div class="day${ds === today ? " today" : ""}"><div class="dn">${d}</div>${evs.map((c) => `<div class="ev" title="${esc(c.event)}">${esc(c.event)}</div>`).join("")}</div>`;
    }
    return `<div class="month">${h}</div>`;
  }

  // ---------- detail view ----------
  function priceChart(m) {
    const all = m.price.pts; const lastD = new Date(all[all.length - 1][0]);
    const from = new Date(lastD); from.setDate(from.getDate() - RANGES[st.range]);
    const pts = all.filter((p) => new Date(p[0]) >= from);
    if (pts.length < 2) return `<div class="muted small">Not enough history for this range.</div>`;
    const vals = pts.map((p) => p[1]); const lo = Math.min(...vals), hi = Math.max(...vals);
    const pane = splitOn(); const wide = isWide() && !pane; const Wd = pane ? 420 : wide ? 620 : 340, H = pane ? 210 : wide ? 240 : 170, L = 4, R = 4, T = 14, B = 18;
    const sx = (k) => L + k / (pts.length - 1) * (Wd - L - R), sy = (v) => T + (hi - v) / ((hi - lo) || 1) * (H - T - B);
    const line = pts.map((p, k) => `${sx(k).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ");
    const area = `${L},${H - B} ${line} ${Wd - R},${H - B}`;
    const chg = (vals[vals.length - 1] / vals[0] - 1) * 100; const up = chg >= 0;
    const iHi = vals.indexOf(hi), iLo = vals.indexOf(lo);
    return `<div class="rangeRow">${chips("range", Object.keys(RANGES))}<span class="${up ? "pos" : "neg"} rchg">${st.range} ${pct(chg)}</span></div>
      <svg class="pc ${up ? "up" : "dn"}" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Price chart ${st.range}">
      <polygon class="ar" points="${area}"/><polyline class="ln" points="${line}"/>
      <circle class="hl" cx="${sx(iHi)}" cy="${sy(hi)}" r="2.5"/><text x="${Math.min(sx(iHi), Wd - 60)}" y="${sy(hi) - 4}">${esc(money(hi, m.price.currency))}</text>
      <circle class="hl" cx="${sx(iLo)}" cy="${sy(lo)}" r="2.5"/><text x="${Math.min(sx(iLo) + 5, Wd - 60)}" y="${sy(lo) - 5}">${esc(money(lo, m.price.currency))}</text>
      <text x="${L}" y="${H - 3}">${esc(dLabel(pts[0][0]))}</text><text x="${Wd - R}" y="${H - 3}" text-anchor="end">${esc(dLabel(pts[pts.length - 1][0]))}</text></svg>`;
  }
  const kv = (rows) => `<dl class="kv">${rows.filter((r) => r && r[1] != null && r[1] !== "" && r[1] !== "—").map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join("")}</dl>`;
  function trendBars(title, periods, vals) {
    const idx = periods.map((_, k) => k).filter((k) => vals[k] != null).reverse(); if (idx.length < 2) return "";
    const mx = Math.max(...idx.map((k) => Math.abs(vals[k]))) || 1;
    return `<div class="tb"><div class="tbt">${esc(title)}</div>${idx.map((k) => `<div class="tbr"><span class="tbl">FY${esc(periods[k].slice(-4))}</span>
      <span class="track"><span class="fill ${vals[k] < 0 ? "negf" : ""}" data-w="${(Math.abs(vals[k]) / mx * 100).toFixed(1)}"></span></span><span class="tbv">${esc(usdM(vals[k]))}</span></div>`).join("")}</div>`;
  }

  function detail(i) {
    const m = mkt(i) || {}; const p = m.price, f = m.financials, s = m.stats, c = m.crypto;
    let out = `${splitOn() ? "" : `<button class="back" data-act="back">‹ Back</button>`}
      <div class="card dh1"><div class="row1"><div><h2 class="dname">${esc(i.name)}</h2><div class="tk">${esc(i.ticker)} · ${esc(i.listing)} · ${esc(i.theme)} · ${esc(i.role)}</div>
      <div class="mt6">${pill(i.action, ACTION_TONE[i.action])}</div></div><div class="score big">${fmt(score10(i))}<div class="tk">/10</div></div></div></div>`;
    // price
    out += `<div class="dgrid"><div class="dcol"><h3>Price</h3><div class="card">`;
    if (p) {
      out += `<div class="pxrow"><span class="pxbig">${esc(money(p.last, p.currency))}</span> <span class="${p.change1d >= 0 ? "pos" : "neg"}">${pct(p.change1d, 2)} day</span></div>
        <div class="tk">Last daily close ${esc(dLabel(p.asOf))} (latest bar may be intraday, delayed) · Source: <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.source)}</a></div>
        ${priceChart(m)}`;
    } else out += `<div class="muted">Price history unavailable from the free sources this build uses.</div>`;
    out += `<div class="mt6">${ext(m.liveUrl, "Open live chart on " + (m.liveLabel || "Yahoo Finance"))}</div></div>`;
    // decision
    out += `<h3>Decision</h3><div class="card">${kv([["Action", pill(i.action, ACTION_TONE[i.action]), true], ["Trigger / entry", i.trigger], ["Next catalyst", `${i.catalystDate}: ${i.catalyst}`], ["Key risk", i.risk], ["Buying from the UK", i.uk]])}</div>`;
    // thesis in left column
    out += `<h3>Thesis, market position and partners</h3><div class="card">${kv([["Thesis and key numbers", i.thesis], ["Link to the leader", i.link], ["Main risk", i.risk]])}</div></div><div class="dcol">`;
    // scores
    out += `<h3>Factor scores</h3><div class="card bars fs">${FACTORS.map((fa) => `<div class="b nb"><div class="lbl">${esc(fa.label)}</div>
      <div class="track"><div class="fill" data-w="${i.s[fa.key] * 10}"></div></div><div class="v">${i.s[fa.key]}</div></div>`).join("")}
      <div class="tk">Weights: ${FACTORS.map((fa) => `${fa.short} ${W[fa.key]}%`).join(", ")}. Risk: higher = lower risk.</div></div>`;
    // fundamentals
    if (c) {
      out += `<h3>Network and market</h3><div class="card">${kv([
        ["Market cap", big(c.marketCap)], ["Rank by market cap", c.rank ? "#" + c.rank : null],
        ["Circulating supply", c.circulating != null ? Math.round(c.circulating).toLocaleString("en-GB") : null],
        ["Max supply", c.max != null ? Math.round(c.max).toLocaleString("en-GB") : "No hard cap"],
        ["24h volume", big(c.volume24h)], ["24h change", pct(c.change24h, 2)],
        ["All-time high", c.ath != null ? `${money(c.ath, "USD")} (${dLabel(c.athDate || "")})` : null],
        ["From all-time high", c.ath && c.price ? pct((c.price / c.ath - 1) * 100) : null]])}
        <div class="tk">As of ${esc(dLabel(c.asOf || ""))} · Source: <a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">CoinGecko</a></div></div>`;
      const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pat = new RegExp("\\b(" + reEsc(i.ticker) + "|" + reEsc(i.name) + ")", "i");
      const regs = D.cryptoRegs.filter((r) => pat.test(r.measure + " " + r.impact + " " + r.next));
      out += `<h3>ETF flows and regulation</h3><div class="card">${kv([["Flows and adoption", i.thesis], ["Watch", i.risk]])}
        ${regs.length ? `<div class="list">${regs.map((r) => `<div class="item"><div class="lead">${esc(r.j)}</div><div class="body"><div class="ttl">${esc(r.measure)}</div><div class="det">${esc(r.status)} · ${esc(r.next)}</div></div>${pill(r.direction, DIR_TONE[r.direction])}</div>`).join("")}</div>` : ""}
        <div class="tk">From the dashboard's sourced research (see Sources).</div></div>`;
    } else {
      out += `<h3>Fundamentals</h3>`;
      if (f) {
        const k0 = 0, rev = f.revenue[k0], revP = f.revenue[1];
        const gm = rev && f.grossProfit[k0] != null ? f.grossProfit[k0] / rev * 100 : null;
        const om = rev && f.operatingIncome[k0] != null ? f.operatingIncome[k0] / rev * 100 : null;
        const nc = f.cash != null ? f.cash - (f.debt || 0) : null;
        const mcap = s && s.marketCap && /USD$/.test(s.marketCap) ? (() => { const mm = /([\d.]+)(tn|bn|m)/.exec(s.marketCap); return mm ? +mm[1] * { tn: 1e6, bn: 1e3, m: 1 }[mm[2]] : null; })() : null;
        const evs = mcap != null && nc != null && rev ? (mcap - nc) / rev : null;
        out += `<div class="card">${kv([
          ["Fiscal year", `FY ending ${f.periods[0]}`],
          ["Revenue", `${usdM(rev)}${revP ? ` (${pct((rev / revP - 1) * 100)} y/y)` : ""}`],
          ["Gross margin", pctPlain(gm)], ["Operating margin", pctPlain(om)],
          ["Free cash flow", f.fcf[0] != null ? `${usdM(f.fcf[0])}${rev ? ` (${pctPlain(f.fcf[0] / rev * 100)} of revenue)` : ""}` : null],
          ["Net cash / (debt)", nc != null ? (nc >= 0 ? `Net cash ${usdM(nc)}` : `Net debt ${usdM(-nc)}`) : null],
          ["EV / Sales (derived)", evs != null ? evs.toFixed(1) + "x" : null]])}
          <div class="grid2t">${trendBars("Revenue", f.periods, f.revenue)}${trendBars("Free cash flow", f.periods, f.fcf)}</div>
          <div class="tk">Annual statements · Source: <a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.source)}</a>. FCF = operating cash flow + capex. EV/Sales uses FT market cap with year-end cash and debt.</div></div>`;
      }
      if (s) {
        out += `<div class="card">${kv([["Market cap", s.marketCap], ["P/E (TTM)", s.pe], ["EPS (TTM)", s.eps], ["Dividend yield", s.divYield], ["Shares outstanding", s.shares],
          ["Fund size", s.fundSize], ["Ongoing charge", s.ongoingCharge], ["Beta", s.beta]])}
          <div class="tk">${s.asOf ? `As of ${esc(s.asOf)} · ` : ""}Source: <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.source)}</a></div></div>`;
      }
      if (!f && !s) out += `<div class="card muted">No fundamentals available from free sources for this asset.</div>`;
      else if (!f) out += `<div class="card muted small">Statement data (revenue trend, margins, FCF) isn't available from a free source for this listing. Sourced figures are in the thesis below.</div>`;
    }
    out += `</div></div>`;
    const miss = (D.market && D.market.missing || []).find((x) => x.name === i.name);
    if (miss) out += `<div class="tk mt6">Not available: ${esc(miss.missing.join("; "))}.</div>`;
    return out;
  }

  // ---------- views ----------
  const V = {
    Focus() {
      const R = vis(ranked);
      const act = [...R.filter((i) => i.action === "Buy" || i.action === "Accumulate on dips").slice(0, 6),
        ...R.filter((i) => i.action === "Trim" || i.action === "Avoid")];
      const b = asOfDate(), e = new Date(b); e.setDate(e.getDate() + 7);
      const n7 = D.catalysts.filter((c) => c.date >= iso(b) && c.date <= iso(e));
      const nextC = D.catalysts.find((c) => c.date >= iso(b));
      const top = R[0];
      const kpi = `<div class="kpis">
        <div class="kpi wide2"><div class="kl">Ideas by action</div><div class="kacts">${ACTIONS.map((a) => { const n = R.filter((i) => i.action === a).length;
          return `<button class="kact${st.fAction === a ? " on" : ""}" data-kpi-action="${esc(a)}">${pill(a, ACTION_TONE[a])}<b>${n}</b></button>`; }).join("")}</div></div>
        ${top ? `<button class="kpi" data-open="${esc(keyOf(top))}"><div class="kl">Top idea</div><div class="kv1">${esc(top.name)} <span class="kscore">${fmt(score10(top))}</span></div><div class="ks">${esc(top.action)} · ${esc(top.ticker)}</div></button>` : ""}
        ${nextC ? `<button class="kpi" data-goto="Calendar"><div class="kl">Next catalyst</div><div class="kv1">${esc(nextC.label)}</div><div class="ks">${esc(nextC.event)}</div></button>` : ""}
        <button class="kpi kall" data-goto="Themes"><div class="kl">Theme stance</div><div class="kthemes">${THEMES.map((t) => `<span>${esc(t)} ${pill(D.themeStances[t].stance, STANCE_TONE[D.themeStances[t].stance])}</span>`).join("")}</div></button>
      </div>`;
      return `${kpi}<h2>Act now <span class="tk">(${act.length})</span></h2><div class="cards">${act.length ? act.map((i) => ideaCard(i)).join("") : `<div class="card muted">No ideas match the current filters.</div>`}</div>
      <div class="grid2"><div><h2>What changed</h2>${list(D.changes.map((c) => ({ lead: c.date, title: c.what, detail: c.soWhat, pill: pill(c.impact, IMPACT_TONE[c.impact]) })))}</div>
      <div><h2>Next 7 days</h2>${list(n7.map((c) => ({ lead: c.label, title: c.event, detail: `${c.type} · ${c.why}` })))}</div></div>
      <h2>Conviction and risk-reward</h2><div class="grid2"><div><h3>Top 10 by overall score</h3>${bars(R.slice(0, 10))}</div>
      <div><h3>Overall score vs safety</h3>${scatter(vis(D.ideas).map((i) => ({ x: i.s.r, y: score10(i) / 10, label: i.ticker, series: i.theme, k: keyOf(i) })), "Risk score (higher = safer)", "Overall score", 0, 10, 3, 9)}</div></div>
      ${D.notes.conviction ? `<div class="note">${esc(D.notes.conviction)}</div>` : ""}
      <h2>Market backdrop</h2><div class="card"><dl class="kv">${D.marketBackdrop.map((m) => `<dt>${esc(m.label)}</dt><dd>${esc(m.value)}</dd>`).join("")}</dl></div>`;
    },
    Scoreboard() {
      const groups = ["All", ...THEMES, "Second-order", "Near peak"].map((g) => [g, g, g === "All" ? D.ideas.length : D.ideas.filter((i) => i.theme === g || i.role === g).length]);
      const board = vis(D.ideas).filter((i) => (st.group === "All" || i.theme === st.group || i.role === st.group) && (st.action === "All" || i.action === st.action))
        .sort((a, b) => { const av = st.sort === "overall" ? score10(a) : a.s[st.sort] * 10, bv = st.sort === "overall" ? score10(b) : b.s[st.sort] * 10; return bv - av || byScore(a, b); });
      let rows;
      if (st.cols === "Scores") rows = `<div class="card"><table class="simple"><tr><th>Idea</th><th>All</th>${FACTORS.map((f) => `<th>${f.short}</th>`).join("")}</tr>
        ${board.map((i) => `<tr class="rowlink" data-open="${esc(keyOf(i))}"><td>${esc(i.name)}</td><td><b>${fmt(score10(i))}</b></td>${FACTORS.map((f) => `<td>${i.s[f.key]}</td>`).join("")}</tr>`).join("")}</table></div>`;
      else if (st.cols === "Thesis") rows = `<div class="cards">${board.map((i) => ideaCard(i, { body: i.thesis })).join("")}</div>`;
      else if (st.cols === "How to buy") rows = `<div class="cards">${board.map((i) => ideaCard(i, { body: i.uk })).join("")}</div>`;
      else rows = `<div class="cards">${board.map((i) => ideaCard(i, { link: true })).join("")}</div>`;
      return `<h2>Idea scoreboard</h2>${chips("group", groups)}
        <div class="selects">${select("action", "Action", [["All", "All"], ...ACTIONS.map((a) => [a, a])])}
        ${select("sort", "Sort", [["overall", "Overall score"], ...FACTORS.map((f) => [f.key, f.label])])}</div>
        ${chips("cols", ["Decision", "Scores", "Thesis", "How to buy"])}
        ${board.length ? rows : `<div class="card muted">No ideas match these filters.</div>`}
        <div class="grid2"><div><h2>Momentum vs valuation</h2>${scatter(board.map((i) => ({ x: i.s.v, y: i.s.m, label: i.ticker, size: score10(i) / 10, series: i.theme, k: keyOf(i) })), "Valuation score (higher = cheaper)", "Momentum", 0, 10, 0, 10, true)}</div>
        <div><h2>Factor heatmap</h2><div class="card"><table class="heat"><tr><th></th>${FACTORS.map((f) => `<th>${f.short}</th>`).join("")}</tr>
        ${board.slice(0, 12).map((i) => `<tr class="rowlink" data-open="${esc(keyOf(i))}"><td>${esc(i.name)}</td>${FACTORS.map((f) => `<td class="h h${i.s[f.key]}">${i.s[f.key]}</td>`).join("")}</tr>`).join("")}</table><div class="tk">Top 12 shown</div></div></div></div>
        <h2>How the score works</h2><div class="card"><table class="simple"><tr><th>Factor</th><th>Weight</th><th>High score means</th></tr>
        ${FACTORS.map((f) => `<tr><td>${esc(f.label)}</td><td>${W[f.key]}%</td><td>${esc(f.what)}</td></tr>`).join("")}</table></div>
        ${D.notes.actions ? `<div class="note">${esc(D.notes.actions)}</div>` : ""}`;
    },
    Themes() {
      const t = st.theme, s = D.themeStances[t]; const inT = (r) => vis(ranked).filter((i) => i.theme === t && i.role === r);
      const sec = (h, r, o) => inT(r).length ? `<h2>${h}</h2><div class="cards">${inT(r).map((i) => ideaCard(i, o)).join("")}</div>` : "";
      return `${chips("theme", THEMES.map((x) => [x, x, D.ideas.filter((i) => i.theme === x).length]))}
        <h2>Theme stance</h2><div class="card"><dl class="kv"><dt>Stance</dt><dd>${pill(s.stance, STANCE_TONE[s.stance])}</dd>
        <dt>Why</dt><dd>${esc(s.line)}</dd><dt>What would flip it</dt><dd>${esc(s.flip)}</dd></dl></div>
        ${sec("Core ideas", "Core")}${sec("Second-order plays", "Second-order", { link: true })}${sec("Leaders near peak", "Near peak")}
        <h2>What moved</h2>${linkList(D.news[t] || [])}`;
    },
    Crypto() {
      return `<h2>Regulation tracker</h2>${D.cryptoRegs.map((r) => `<div class="card"><b>${esc(r.j)} · ${esc(r.measure)}</b>
        <div class="cat">${pill(r.direction, DIR_TONE[r.direction])} <span class="tk">${esc(r.status)}</span></div>
        <div class="trig small">${esc(r.next)}</div><div class="det muted small">Moves: ${esc(r.impact)}</div></div>`).join("")}
        ${D.notes.cryptoNetRead ? `<div class="note">${esc(D.notes.cryptoNetRead)}</div>` : ""}
        <h2>Crypto ideas</h2><div class="cards">${vis(ranked).filter((i) => i.theme === "Crypto").map((i) => ideaCard(i)).join("")}</div>
        <h2>Crypto news</h2>${linkList(D.news.Crypto || [])}`;
    },
    Calendar() {
      const rows = D.catalysts.filter((c) => st.cal === "All" || c.type === st.cal);
      const months = [...new Set([st.month, ...D.catalysts.map((c) => c.date.slice(0, 7))])].sort();
      return `<h2>Catalyst list</h2>${chips("cal", ["All", "Earnings", "Policy", "Central bank", "Crypto"])}
        ${D.notes.calendarCaption ? `<div class="muted small">${esc(D.notes.calendarCaption)}</div>` : ""}
        ${list(rows.map((c) => ({ lead: c.label, title: c.event, detail: `${c.type} · ${c.why}` })))}
        <h2>Month view</h2>${chips("month", months.map((m) => [m, MONTHS[+m.slice(5) - 1] + " " + m.slice(0, 4)]))}${monthGrid(st.month)}`;
    },
    Sources() {
      const all = [...D.sources, ...THEMES.flatMap((t) => D.news[t] || [])];
      const mk = [{ title: "Daily prices and key stats (shares, ETFs)", site: "FT Markets", href: "https://markets.ft.com/data" },
        { title: "Annual financial statements (US listings, ADRs)", site: "Nasdaq", href: "https://www.nasdaq.com/market-activity/stocks" },
        { title: "Crypto prices, market cap, supply, volume", site: "CoinGecko", href: "https://www.coingecko.com/" }];
      return `<h2>Research sources (${all.length})</h2>${linkList(all)}<h2>Market data sources</h2>${linkList(mk)}
        ${D.market ? `<div class="tk">Market data fetched ${esc(new Date(D.market.fetchedAt).toLocaleString("en-GB", { timeZone: "Europe/London" }))} UK.</div>` : ""}`;
    },
    Settings() {
      const fetched = D.market ? new Date(D.market.fetchedAt).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }) + " UK" : "—";
      const built = D.builtAt ? new Date(D.builtAt).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }) + " UK" : "—";
      return `<h2>Settings</h2>
      <h3>Check for new data</h3><div class="card">
        <select data-setting="checkEvery" aria-label="Check for new data">${Object.entries(CHECK).map(([v, [l]]) => `<option value="${v}"${S.checkEvery === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <label class="tog"><span>Auto-refresh when new data arrives<span class="tk"> (otherwise you get a "new research" prompt)</span></span><input type="checkbox" data-setting="autoRefresh"${S.autoRefresh ? " checked" : ""}></label>
        <div class="srow"><button class="btn" data-act="check">Check now</button><span class="tk">${esc(checkMsg || "")}${lastCheck ? " · checked " + esc(lastCheck.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })) : ""}</span></div>
        <div class="tk">"On open only" checks when the app opens or comes back to the foreground.</div></div>
      <h3>Research updates</h3><div class="card">${kv([["Last data update", D.asOf], ["Published", built], ["Market data fetched", fetched], ["Publishing schedule", (D.publish && D.publish.schedule) || "—"]])}
        <div class="note">To change how often research runs, ask New Bot in chat.</div></div>
      <h3>Appearance</h3><div class="card"><div class="slbl">Theme</div>${seg("theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]])}
        <div class="slbl">Density</div>${seg("density", [["comfortable", "Comfortable"], ["compact", "Compact"]])}
        <div class="slbl">Start view</div><select data-setting="startView" aria-label="Start view">${VIEWS.map((v) => `<option${S.startView === v ? " selected" : ""}>${v}</option>`).join("")}</select></div>
      <h3>Security</h3><div class="card"><label class="tog"><span>Remember unlock on this device<span class="tk"> (stores a non-exportable key in this browser only)</span></span><input type="checkbox" data-setting="remember"${S.remember ? " checked" : ""}></label>
        <button class="btn danger" data-act="lock">🔒 Lock now</button></div>`;
    },
  };

  function searchView(q) {
    const t = q.toLowerCase(); const has = (...xs) => xs.some((x) => x && String(x).toLowerCase().includes(t));
    const ideas = vis(ranked).filter((i) => has(i.name, i.ticker, i.listing, i.theme, i.role, i.thesis, i.trigger, i.catalyst, i.risk, i.link, i.action));
    const cats = D.catalysts.filter((c) => has(c.event, c.why, c.type, c.label));
    const chg = D.changes.filter((c) => has(c.what, c.soWhat));
    const news = THEMES.flatMap((th) => D.news[th] || []).filter((n) => has(n.title, n.site));
    const regs = D.cryptoRegs.filter((r) => has(r.measure, r.impact, r.next, r.j));
    const none = !ideas.length && !cats.length && !chg.length && !news.length && !regs.length;
    return `<h2>Search: “${esc(q)}”</h2>${none ? `<div class="card muted">Nothing matches. Esc clears the search.</div>` : ""}
      ${ideas.length ? `<h3>Ideas (${ideas.length})</h3><div class="cards">${ideas.map((i) => ideaCard(i)).join("")}</div>` : ""}
      ${cats.length ? `<h3>Calendar (${cats.length})</h3>${list(cats.map((c) => ({ lead: c.label, title: c.event, detail: `${c.type} · ${c.why}` })))}` : ""}
      ${chg.length ? `<h3>What changed (${chg.length})</h3>${list(chg.map((c) => ({ lead: c.date, title: c.what, detail: c.soWhat })))}` : ""}
      ${regs.length ? `<h3>Crypto regulation (${regs.length})</h3>${list(regs.map((r) => ({ lead: r.j, title: r.measure, detail: `${r.status} · ${r.next}` })))}` : ""}
      ${news.length ? `<h3>News (${news.length})</h3>${linkList(news)}` : ""}`;
  }

  function render() {
    const wl = FACTORS.map((f) => `${f.short} ${W[f.key]}%`).join(", ");
    $("#asof").textContent = "As of " + D.asOf;
    const q = st.q.trim();
    let det = st.detail ? D.ideas.find((i) => keyOf(i) === st.detail) : null;
    const head = st.view === "Settings" && !q ? "" : `<div class="note"><b>Research, not regulated financial advice.</b> As of ${esc(D.asOf)}. Overall score (1–10) = ${esc(wl)}. Risk: higher = lower risk.</div>`;
    const foot = `<div class="foot">${isWide() ? "Select an idea to see its chart and fundamentals alongside · 1–7 switch views · / search · Esc close" : "Tap any idea for price chart, fundamentals and scores · 🔒 locks this device"}</div>`;
    const body = () => (q ? searchView(q) : V[st.view]());
    document.body.classList.toggle("split-mode", splitOn());
    const prevPane = $(".detailpane"), prevTop = prevPane ? prevPane.scrollTop : 0, prevKey = prevPane ? prevPane.dataset.k : null;
    if (splitOn()) {
      const listHtml = head + body() + foot;
      $("#view").innerHTML = `<div class="split"><div class="listpane">${listHtml}</div><aside class="detailpane" aria-label="Idea detail"></aside></div>`;
      const k = selKey(); det = k ? D.ideas.find((i) => keyOf(i) === k) : null;
      if (det && !st.detail) document.querySelectorAll(`.listpane .idea[data-open="${CSS.escape(k)}"]`).forEach((x) => x.classList.add("sel"));
      $(".detailpane").innerHTML = det ? detail(det) : `<div class="card muted">No idea selected. Pick one from the list.</div>`;
      const pane = $(".detailpane"); pane.dataset.k = det ? keyOf(det) : ""; if (det && prevKey === keyOf(det)) pane.scrollTop = prevTop;
    } else {
      $("#view").innerHTML = det ? detail(det) + `<div class="note mt12"><b>Research, not regulated financial advice.</b> As of ${esc(D.asOf)}.</div>`
        : head + body() + (st.view === "Settings" ? "" : foot);
    }
    document.querySelectorAll("[data-w]").forEach((el) => { el.style.width = el.dataset.w + "%"; });
    document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === st.view));
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  tryRemembered().then((ok) => { if (!ok) $("#pass").focus(); });
})();
