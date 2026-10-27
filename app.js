"use strict";
// Invest Intel — the app shell holds NO dashboard data. data.enc.json is AES-GCM encrypted;
// the key is derived in-browser from the passcode with PBKDF2-SHA256.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
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
  // DB v2 adds the "vault" store: portfolio, analyst settings and chat, each AES-GCM encrypted with the passcode key.
  const DB = "invest-intel", STORE = "keys", VAULT = "vault";
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => { for (const n of [STORE, VAULT]) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idbOp = async (mode, fn, store = STORE) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, mode); const req = fn(tx.objectStore(store));
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
  // Non-extractable AES-GCM key. "encrypt" lets the same passcode key seal on-device data (portfolio, chat, API key).
  async function deriveKey(pass, p) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64(p.salt), iterations: p.iterations },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
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
  async function lockNow() {
    // drop every decrypted object from memory before reloading
    try { if (AU.ctl) AU.ctl.abort(); } catch {}
    P = null; A = null; AU.draft = ""; IMP = null; try { if (RV.ctl) RV.ctl.abort(); } catch {} REV = null; D = null; pending = null;
    try { if (SHOTS.ctl) SHOTS.ctl.abort(); } catch {} dropShots();
    const v = $("#view"); if (v) v.innerHTML = ""; closeSheet();
    await clearKey(); currentKey = null; location.reload();
  }
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
  const VIEWS = ["Focus", "Scoreboard", "Themes", "Crypto", "Calendar", "Sources", "Portfolio", "Analyst"];
  // keys 1-9 follow this order; on phones Themes/Crypto/Calendar/Sources/Settings live under "More"
  const TABS = [["Focus", "◎"], ["Scoreboard", "≡"], ["Themes", "◇"], ["Crypto", "₿"], ["Calendar", "▦"], ["Sources", "↗"], ["Portfolio", "◔"], ["Analyst", "✦"], ["Settings", "⚙"]];
  const OVERFLOW = ["Themes", "Crypto", "Calendar", "Sources", "Settings"];
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
      + TABS.map(([v, ic], n) => `${v === "Portfolio" ? `<div class="navsep" aria-hidden="true"><span>You</span></div>` : ""}<button data-tab="${v}" aria-keyshortcuts="${n + 1}"${OVERFLOW.includes(v) ? ' class="ovf"' : ""}><span class="ic">${ic}</span><span class="tl">${v}</span><kbd>${n + 1}</kbd></button>`).join("")
      + `<button data-more class="more" aria-haspopup="dialog"><span class="ic">⋯</span><span class="tl">More</span></button>`
      + `<div class="kbhelp"><kbd>/</kbd> search · <kbd>j</kbd><kbd>k</kbd> move · <kbd>Esc</kbd> close</div></div>`;
    $("#tabs").onclick = (e) => { if (e.target.closest("[data-more]")) { openMore(); return; } const b = e.target.closest("[data-tab]"); if (b) goTab(b.dataset.tab); };
    $("#q").oninput = (e) => { st.q = e.target.value; render(); };
    $("#filtBtn").onclick = () => { st.showFilters = !st.showFilters; renderFilters(); };
    $("#filters").onclick = (e) => { const b = e.target.closest("[data-f]"); if (!b) return; if (b.dataset.f === "clear") { st.fTheme = "All"; st.fAction = "All"; st.fMin = "0"; } else st[b.dataset.f] = b.dataset.val; renderFilters(); render(); };
    $("#filters").onchange = (e) => { const t = e.target.closest("select[data-f]"); if (t) { st[t.dataset.f] = t.value; renderFilters(); render(); } };
    let rt; window.onresize = () => { clearTimeout(rt); rt = setTimeout(() => { if (st.view === "Analyst" && document.activeElement && document.activeElement.id === "chatIn") sizeChat(); else render(); }, 150); };
    if (window.visualViewport) { visualViewport.addEventListener("resize", sizeChat); visualViewport.addEventListener("scroll", sizeChat); }
    $("#view").addEventListener("input", onInput); $("#view").addEventListener("keydown", onViewKey); $("#view").addEventListener("submit", onSubmit);
    $("#view").addEventListener("focusin", (e) => { if (e.target.id === "chatIn" && matchMedia("(pointer: coarse)").matches) { document.body.classList.add("kb"); sizeChat(); } });
    $("#view").addEventListener("focusout", (e) => { if (e.target.id === "chatIn") setTimeout(() => { document.body.classList.remove("kb"); sizeChat(); }, 60); });
    buildIndex(); openVault();
    document.addEventListener("keydown", onKey);
    renderFilters();
    $("#view").onclick = onClick; $("#view").onchange = onChange;
    initSheet();
    $("#banner").onclick = (e) => { if (e.target.closest("[data-apply]")) applyPending(); if (e.target.closest("[data-dismiss]")) hideBanner(); };
    window.onpopstate = () => { if (st.detail) { st.detail = null; render(); } };
    render(); schedule();
  }

  function onClick(e) {
    if (e.target.closest("a")) return;
    if (extraClick(e)) return;
    const act = e.target.closest("[data-act]");
    if (act) {
      const a = act.dataset.act;
      if (a === "back") { history.length > 1 && history.state && history.state.detail ? history.back() : (st.detail = null, render()); return; }
      if (a === "lock") { lockNow(); return; }
      if (a === "check") { checkNow(true); return; }
      if (a === "closeDetail") { st.detail = null; render(); return; }
      if (EXTRA_ACTS[a]) { EXTRA_ACTS[a](act, e); return; }
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
    if (extraChange(e)) return;
    const s = e.target.closest("select[data-set]"); if (s) { st[s.dataset.set] = s.value; render(); return; }
    const t = e.target.closest("[data-setting]"); if (t) setSetting(t.dataset.setting, t.type === "checkbox" ? t.checked : t.value);
  }
  function goTab(v) {
    closeSheet(true);
    st.view = v; st.detail = null; st.q = ""; $("#q").value = ""; sessionStorage.setItem("view", v); render(); scrollTo(0, 0);
    if (v === "Analyst") scrollChat(true);
  }
  function openDetail(k) {
    st.detail = k; st.range = "6M";
    if (isWide() && splitOn()) { render(); const p = $(".detailpane"); if (p) p.scrollTop = 0; return; }
    history.pushState({ detail: k }, ""); render(); scrollTo(0, 0);
  }
  const splitOn = () => isWide() && (IDEA_VIEWS.includes(st.view) || st.view === "Portfolio" || st.q.trim() !== "");
  function onKey(e) {
    if (!D || $("#app").hidden) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === "Escape") {
      if (!$("#sheet").hidden) { closeSheet(); return; }
      if (st.q) { st.q = ""; $("#q").value = ""; $("#q").blur(); render(); }
      else if (typing) e.target.blur();
      else if (st.showFilters) { st.showFilters = false; renderFilters(); }
      else if (st.detail) { if (!splitOn() && history.state && history.state.detail) history.back(); else { st.detail = null; render(); } }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
    if (!$("#sheet").hidden) return;
    if (/^[1-9]$/.test(e.key)) { goTab(TABS[+e.key - 1][0]); return; }
    if ((e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") && splitOn()) {
      const ks = [...new Set([...document.querySelectorAll(".listpane .idea[data-open], .listpane .hold[data-open]")].map((x) => x.dataset.open))]; if (!ks.length) return;
      e.preventDefault(); const cur = ks.indexOf(st.detail || selKey()); const n = Math.max(0, Math.min(ks.length - 1, cur + (e.key === "j" || e.key === "ArrowDown" ? 1 : -1)));
      openDetail(ks[n]); const el = document.querySelector(`.listpane [data-open="${CSS.escape(ks[n])}"]`); if (el) el.scrollIntoView({ block: "nearest" });
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
    if (st.view === "Portfolio" && !st.q.trim()) return null;
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
    payload = pending.p; D = pending.data; W = D.weights; ranked = [...D.ideas].sort(byScore); pending = null; checkMsg = "Updated"; buildIndex();
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
      <div class="mt6">${pill(i.action, ACTION_TONE[i.action])}</div></div><div class="score big">${fmt(score10(i))}<div class="tk">/10</div></div></div>
      <div class="dacts"><button class="btn ask" data-act="ask" data-k="${esc(keyOf(i))}"><span aria-hidden="true">✦</span> Ask the analyst</button></div></div>
      ${positionCard(i)}`;
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

  // =====================================================================================
  // On-device vault: portfolio, analyst settings (incl. API key) and chat history.
  // Each record is AES-256-GCM encrypted with the passcode-derived key and lives only in this
  // browser's IndexedDB. Nothing here is ever sent to GitHub. Records carry the salt they were
  // sealed with so a passcode change can migrate them.
  // =====================================================================================
  const b64e = (u) => { let s = ""; const a = new Uint8Array(u); for (let k = 0; k < a.length; k += 0x8000) s += String.fromCharCode.apply(null, a.subarray(k, k + 0x8000)); return btoa(s); };
  const vget = (n) => idbOp("readonly", (s) => s.get(n), VAULT).catch(() => null);
  const vput = (n, v) => idbOp("readwrite", (s) => s.put(v, n), VAULT);
  const vdel = (n) => idbOp("readwrite", (s) => s.delete(n), VAULT).catch(() => {});
  const canEnc = () => !!(currentKey && currentKey.usages && currentKey.usages.includes("encrypt"));
  async function sealWith(key, salt, iterations, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
    return { v: 1, kdf: "PBKDF2-SHA256", cipher: "AES-256-GCM", iterations, salt, iv: b64e(iv), ct: b64e(ct) };
  }
  const openWith = async (key, rec) => JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(rec.iv) }, key, b64(rec.ct))));
  async function keyFrom(pass, salt, iterations) { return deriveKey(pass, { salt, iterations }); }
  const VS = { ready: false, needPass: false, stale: {}, err: "" };
  let P = null, A = null, IMP = null;
  const AU = { ctxDash: true, ctxPort: true, focus: null, draft: "", busy: false, ctl: null, editKey: false, showCustom: false };
  const newPortfolio = () => ({ v: 1, base: "GBP", holdings: [], updatedAt: null });
  async function vaultSave(name, obj) {
    if (!canEnc()) throw new Error("Vault is locked");
    if (VS.stale[name]) throw new Error("Saved data from a previous passcode is waiting to be restored");
    await vput(name, await sealWith(currentKey, payload.salt, payload.iterations, obj));
  }
  async function vaultLoad(name) {
    const rec = await vget(name); if (!rec) return null;
    if (rec.salt !== payload.salt) { VS.stale[name] = rec; return null; }
    return openWith(currentKey, rec);
  }
  async function openVault() {
    VS.ready = false; VS.stale = {}; VS.err = ""; VS.needPass = !canEnc();
    if (!VS.needPass) {
      try {
        P = (await vaultLoad("portfolio")) || newPortfolio();
        const ai = await vaultLoad("ai"), chat = await vaultLoad("chat"); REV = await vaultLoad("review");
        A = { cfg: Object.assign({ provider: "anthropic", models: {}, keys: {} }, ai || {}), msgs: (chat && chat.msgs) || [] };
        VS.ready = true;
      } catch (e) { VS.err = "Could not open the on-device vault (" + (e.message || "decrypt failed") + ")."; }
    }
    if (D) render();
  }
  const savePortfolio = async () => { P.updatedAt = new Date().toISOString(); await vaultSave("portfolio", P); };
  const saveAI = () => vaultSave("ai", A.cfg);
  const saveChat = () => vaultSave("chat", { msgs: A.msgs.slice(-200) });

  // Card shown when the vault can't be opened yet (remembered key from an older version, or data sealed under an old passcode)
  function vaultGate() {
    if (VS.err) return `<div class="card gate"><div class="gic">!</div><h3>Vault error</h3><p class="muted">${esc(VS.err)}</p></div>`;
    if (VS.needPass) return `<form class="card gate" data-form="vaultpass"><div class="gic">🔐</div><h3>Confirm your passcode</h3>
      <p class="muted">Your portfolio, analyst key and chat are encrypted on this device with your passcode. Enter it once to open the on-device vault.</p>
      <input type="password" name="pass" placeholder="Passcode" autocomplete="current-password" aria-label="Passcode" required>
      <button class="btn primary" type="submit">Open vault</button><p class="err" data-err></p></form>`;
    if (!VS.ready) return `<div class="card muted">Opening on-device vault…</div>`;
    const st0 = Object.keys(VS.stale);
    if (st0.length) return `<form class="card gate" data-form="stalepass"><div class="gic">↺</div><h3>Bring across your saved data</h3>
      <p class="muted">Your ${esc(st0.map((n) => ({ portfolio: "portfolio", ai: "analyst settings", chat: "chat history", review: "saved AI review" }[n])).join(", "))} on this device was encrypted with your previous passcode. Enter that passcode to re-encrypt it with the current one.</p>
      <input type="password" name="pass" placeholder="Previous passcode" autocomplete="off" aria-label="Previous passcode" required>
      <div class="srow"><button class="btn primary" type="submit">Restore</button><button class="btn" type="button" data-act="discardStale">Start fresh instead</button></div><p class="err" data-err></p></form>`;
    return "";
  }

  // ---------- currencies & FX ----------
  const CCYS = ["GBP", "USD", "EUR", "GBp", "SEK", "AUD", "CAD", "CHF", "JPY", "HKD", "DKK", "NOK"];
  function normCcy(c) {
    if (c == null) return null; const t = String(c).trim(); if (!t) return null;
    if (t === "GBp" || /^(gbx|pence|p|gbpence)$/i.test(t)) return "GBp";
    const u = t.toUpperCase().replace(/[^A-Z£$€]/g, "");
    if (u === "£") return "GBP"; if (u === "$") return "USD"; if (u === "€") return "EUR"; if (u === "GBX") return "GBp";
    return /^[A-Z]{3}$/.test(u) ? u : null;
  }
  const fxRate = (c) => (c === "GBP" ? 1 : (D.market && D.market.fx && D.market.fx.rates && D.market.fx.rates[c]) || null);
  function toBase(amt, ccy) {
    if (amt == null || !isFinite(amt)) return null; let c = normCcy(ccy); if (!c) return null;
    if (c === "GBp") { amt /= 100; c = "GBP"; }
    const base = P ? P.base : "GBP"; if (c === base) return amt;
    const rc = fxRate(c), rb = fxRate(base); if (!rc || !rb) return null;
    return amt / rc * rb;
  }
  const baseSym = () => ({ GBP: "£", USD: "$", EUR: "€" }[P.base] || P.base + " ");
  function bm(v, dp) {
    if (v == null || !isFinite(v)) return "—"; const a = Math.abs(v), s = v < 0 ? "−" : "";
    const d = dp != null ? dp : a >= 10000 ? 0 : 2;
    return s + baseSym() + a.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const bmS = (v, dp) => (v == null ? "—" : (v > 0 ? "+" : "") + bm(v, dp));
  const qtyFmt = (q) => (q == null ? "—" : q.toLocaleString("en-GB", { maximumFractionDigits: q < 1 ? 8 : q < 100 ? 4 : 2 }));

  // ---------- matching holdings to dashboard ideas ----------
  // extra symbols / name aliases come from the encrypted payload (D.match) so the public shell names no holdings or ideas
  const matchHints = (i) => (D.match && D.match[i.name]) || {};
  function normSym(s) {
    let t = String(s || "").toUpperCase().trim(); if (!t) return "";
    t = t.replace(/^(LON|LSE|NASDAQ|NYSE|NYQ|NSQ|XETRA|XETR|ETR|FRA|STO|ASX|TSX|AMS|EPA|AMEX|ARCA|BATS|OTC|GER)\s*[:.]\s*/, "");
    t = t.replace(/_(US|GB|DE|SE|NL|AU|CA)?_?EQ$/, "").replace(/[-/](USD|GBP|EUR|USDT|USDC)$/, "");
    t = t.replace(/\.(L|LN|LSE|DE|F|ST|AS|AX|TO|PA|US|IL|XETRA)$/, "");
    return t.replace(/[\s.\-/]+/g, "");
  }
  let SYMIDX = new Map();
  function buildIndex() {
    SYMIDX = new Map();
    for (const i of D.ideas) {
      const raw = [...i.ticker.split("/"), ...((/OTC:\s*([A-Z]+)/.exec(i.listing) || []).slice(1)), ...(matchHints(i).syms || [])];
      for (const r of raw) { const k = normSym(r); if (!k) continue; if (!SYMIDX.has(k)) SYMIDX.set(k, []); SYMIDX.get(k).push(i); }
    }
  }
  const nameKeys = (i) => [i.name.toLowerCase(), ...(matchHints(i).aliases || [])];
  const isCryptoIdea = (i) => !!(mkt(i) && mkt(i).crypto);
  const sameLine = (a, b) => { const g = (x) => (x === "GBp" ? "GBP" : x); return g(a) === g(b); };
  function matchIdea(h) {
    if (h.link === "none") return null;
    const pxOk = (i) => { const m = mkt(i); if (!m || !m.price) return false; if (isCryptoIdea(i)) return true; const hc = normCcy(h.ccy); return !hc || sameLine(hc, normCcy(m.price.currency)); };
    if (h.link) { const i = D.ideas.find((x) => keyOf(x) === h.link); if (i) return { i, by: "manual", px: pxOk(i) }; }
    const nm = (h.name || "").toLowerCase();
    const byName = nm ? D.ideas.find((i) => nameKeys(i).some((k) => nm.includes(k))) : null;
    const s = normSym(h.sym);
    for (const i of SYMIDX.get(s) || []) {
      // a bare symbol can collide across exchanges (e.g. the same short ticker on a US and a London listing): require a matching currency or name
      if (pxOk(i)) return { i, by: "symbol", px: true };
      if (byName === i) return { i, by: "symbol", px: false };
    }
    if (byName) return { i: byName, by: "name", px: false };
    return null;
  }
  function valueOf(h, mt) {
    const m = mt && mt.px ? mkt(mt.i) : null;
    if (m && m.price && h.qty != null) { const v = toBase(h.qty * m.price.last, m.price.currency); return { v, src: v == null ? "nofx" : "dash", px: m.price.last, pxCcy: m.price.currency, asOf: m.price.asOf }; }
    if (h.manualPx != null && h.qty != null) { const v = toBase(h.qty * h.manualPx, h.ccy); return { v, src: v == null ? "nofx" : "manual", px: h.manualPx, pxCcy: h.ccy }; }
    if (h.value != null) { const v = toBase(h.value, h.valueCcy || h.bookCcy || h.ccy); return { v, src: v == null ? "nofx" : "broker", asOf: h.valueAsOf }; }
    return { v: null, src: "none" };
  }
  function costOf(h) {
    if (h.book != null) return toBase(h.book, h.bookCcy || h.ccy);
    if (h.avg != null && h.qty != null) return toBase(h.avg * h.qty, h.ccy);
    return null;
  }
  const SRC_LABEL = { dash: "Dashboard price", manual: "Manual price", broker: "Broker value", none: "No price", nofx: "No FX rate" };

  function pfCalc() {
    const rows = P.holdings.map((h) => {
      const mt = matchIdea(h), val = valueOf(h, mt), cost = costOf(h);
      return { h, mt, ...val, cost, pl: val.v != null && cost != null ? val.v - cost : null };
    });
    const priced = rows.filter((r) => r.v != null), total = priced.reduce((a, r) => a + r.v, 0);
    for (const r of rows) r.w = r.v != null && total > 0 ? r.v / total * 100 : null;
    const costed = priced.filter((r) => r.cost != null), plTot = costed.reduce((a, r) => a + r.pl, 0), costTot = costed.reduce((a, r) => a + r.cost, 0);
    const day = priced.filter((r) => r.src === "dash" && mkt(r.mt.i).price.change1d != null).reduce((a, r) => a + r.v - r.v / (1 + mkt(r.mt.i).price.change1d / 100), 0);
    const group = (fn) => { const m = new Map(); for (const r of priced) { const k = fn(r); m.set(k, (m.get(k) || 0) + r.v); } return [...m.entries()].map(([k, v]) => ({ k, v, w: total ? v / total * 100 : 0 })).sort((a, b) => b.v - a.v); };
    const byTheme = group((r) => (r.mt ? r.mt.i.theme : "Not on dashboard"));
    const byAction = group((r) => (r.mt ? r.mt.i.action : "Not on dashboard"));
    const byCcy = group((r) => { const c = r.src === "dash" ? normCcy(r.pxCcy) : normCcy(r.h.valueCcy || r.h.ccy); return c === "GBp" ? "GBP" : c || "?"; });
    const sorted = [...rows].sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    // decision flags
    const flags = [];
    for (const r of sorted) if (r.mt && (r.mt.i.action === "Trim" || r.mt.i.action === "Avoid"))
      flags.push({ tone: r.mt.i.action === "Avoid" ? "danger" : "warning", k: keyOf(r.mt.i), t: `You hold ${r.mt.i.name}${r.w != null ? ` (${r.w.toFixed(1)}% of portfolio)` : ""}, rated ${r.mt.i.action} ${fmt(score10(r.mt.i))}`, d: r.mt.i.trigger });
    for (const r of sorted) if (r.w != null && r.w >= 25)
      flags.push({ tone: "danger", k: r.mt ? keyOf(r.mt.i) : null, t: `Concentration: ${r.h.name || r.h.sym} is ${r.w.toFixed(1)}% of priced holdings`, d: "Above 25% in one line. A single bad print moves the whole portfolio." });
    const mid = sorted.filter((r) => r.w != null && r.w >= 15 && r.w < 25);
    if (mid.length) flags.push({ tone: "warning", k: mid.length === 1 && mid[0].mt ? keyOf(mid[0].mt.i) : null, t: `${mid.length === 1 ? "1 position is" : mid.length + " positions are"} above 15% of priced holdings`,
      d: mid.map((r) => `${r.h.sym || r.h.name} ${r.w.toFixed(1)}%`).join(" · ") + ". Check you are comfortable with the single-name risk." });
    const top3 = sorted.filter((r) => r.w != null).slice(0, 3).reduce((a, r) => a + r.w, 0);
    if (priced.length > 3 && top3 >= 60) flags.push({ tone: "warning", t: `Top 3 positions are ${top3.toFixed(0)}% of priced holdings`, d: "Portfolio is concentrated in a few names." });
    for (const t of byTheme) if (t.k !== "Not on dashboard" && t.w >= 50 && priced.length > 1)
      flags.push({ tone: t.w >= 70 ? "danger" : "warning", t: `Theme concentration: ${t.w.toFixed(0)}% in ${t.k}`, d: `Dashboard stance on ${t.k}: ${D.themeStances[t.k] ? D.themeStances[t.k].stance : "n/a"}.` });
    const unp = rows.filter((r) => r.v == null);
    if (unp.length) flags.push({ tone: "neutral", t: `${unp.length} holding${unp.length > 1 ? "s have" : " has"} no price`, d: `${unp.map((r) => r.h.sym || r.h.name).slice(0, 6).join(", ")}${unp.length > 6 ? "…" : ""} ${unp.length > 1 ? "are" : "is"} excluded from totals and weights. Add a manual price or import a file with a value column.` });
    const held = new Set(rows.filter((r) => r.mt).map((r) => keyOf(r.mt.i)));
    const good = sorted.filter((r) => r.mt && (r.mt.i.action === "Buy" || r.mt.i.action === "Accumulate on dips"));
    const gaps = ranked.filter((i) => (i.action === "Buy" || i.action === "Accumulate on dips") && !held.has(keyOf(i))).slice(0, 5);
    return { rows: sorted, priced, total, plTot, costTot, day, byTheme, byAction, byCcy, flags, held, good, gaps, top3 };
  }
  const heldRow = (i) => { if (!P || !VS.ready || !P.holdings.length) return null; const c = pfCalc(); return c.rows.filter((r) => r.mt && keyOf(r.mt.i) === keyOf(i)); };

  function positionCard(i) {
    const rs = heldRow(i); if (!rs || !rs.length) return "";
    const q = rs.reduce((a, r) => a + (r.h.qty || 0), 0), v = rs.every((r) => r.v != null) ? rs.reduce((a, r) => a + r.v, 0) : null;
    const pl = rs.every((r) => r.pl != null) ? rs.reduce((a, r) => a + r.pl, 0) : null, cost = rs.every((r) => r.cost != null) ? rs.reduce((a, r) => a + r.cost, 0) : null;
    const w = rs.every((r) => r.w != null) ? rs.reduce((a, r) => a + r.w, 0) : null;
    return `<div class="card poscard"><div class="kl">Your position</div><div class="posg">
      <div><div class="tk">Quantity</div><b>${esc(qtyFmt(q))}</b></div><div><div class="tk">Value</div><b>${esc(bm(v))}</b></div>
      <div><div class="tk">P/L</div><b class="${pl > 0 ? "pos" : pl < 0 ? "neg" : ""}">${esc(bmS(pl))}${pl != null && cost ? ` <span class="small">(${pct(pl / cost * 100)})</span>` : ""}</b></div>
      <div><div class="tk">Weight</div><b>${w != null ? w.toFixed(1) + "%" : "—"}</b></div></div>
      ${reviewPosition(i)}
      <div class="tk">${esc(SRC_LABEL[rs[0].src])} · on this device only</div></div>`;
  }

  // ---------- CSV import ----------
  function parseCSV(text) {
    text = String(text).replace(/^\uFEFF/, "");
    const sample = text.split(/\r?\n/).slice(0, 60).join("\n");
    const delim = [",", ";", "\t"].map((d) => [d, sample.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cell = "", q = false;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (q) { if (c === '"') { if (text[k + 1] === '"') { cell += '"'; k++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[k + 1] === "\n") k++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return { delim, rows: rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== "")) };
  }
  function num(s, delim) {
    if (s == null) return null; let t = String(s).trim(); if (!t || /^(-|--|n\/?a|nil|none)$/i.test(t)) return null;
    const neg = /^\(.*\)$/.test(t) || /^[-−–]/.test(t);
    t = t.replace(/[£$€¥%]|GBP|USD|EUR|GBX|SEK|AUD|CAD|CHF/gi, "").replace(/p$/i, "").replace(/[()\s'−–-]/g, "");
    if (delim === ";" && /^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+,\d+$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
    const v = parseFloat(t); return isFinite(v) ? (neg ? -v : v) : null;
  }
  const normH = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const FIELDS = [
    ["sym", "Symbol / ticker", ["ticker", "symbol", "code", "epic", "tidm", "stock code", "instrument symbol", "asset", "security id", "ticker symbol"]],
    ["name", "Name", ["name", "stock", "investment", "instrument", "description", "security", "security name", "stock name", "fund name", "instrument name", "asset name", "title", "holding"]],
    ["qty", "Quantity", ["quantity", "shares", "units", "units held", "no of shares", "quantity transacted", "qty", "number of shares", "position", "balance", "amount held"]],
    ["avg", "Avg cost per unit", ["average price", "avg price", "average cost", "avg cost", "cost price", "average buy price", "average price paid", "price share", "price per share", "price per share in account currency", "price at transaction", "spot price at transaction", "cost per share", "purchase price", "cost basis price"]],
    ["book", "Book cost (total)", ["book cost", "cost", "cost basis", "total cost", "invested", "value at cost", "cost value", "purchase value", "book value", "amount invested"]],
    ["price", "Current price", ["price", "last price", "current price", "close price", "market price", "mark price", "last", "price pence", "current price pence", "price p", "latest price"]],
    ["value", "Current value", ["value", "market value", "current value", "position value", "valuation", "total value", "value gbp"]],
    ["ccy", "Currency", ["currency", "ccy", "currency price share", "instrument currency", "price currency", "spot price currency", "local currency", "trade currency"]],
    ["act", "Transaction type", ["buy sell", "side", "action", "transaction type", "type", "transaction", "order type"]],
    ["total", "Transaction total", ["total", "total amount", "net amount", "total inclusive of fees and or spread", "consideration", "total in account currency", "subtotal"]],
    ["tccy", "Total currency", ["currency total", "account currency", "total currency", "settlement currency"]],
    ["notes", "Notes", ["notes"]],
  ];
  function autoMap(headers) {
    const H = headers.map(normH), map = {}, used = new Set();
    for (const pass of ["exact", "prefix"]) for (const [f, , syn] of FIELDS) {
      if (map[f] != null) continue;
      for (const sy of syn) {
        const idx = H.findIndex((h, n) => !used.has(n) && (pass === "exact" ? h === sy : h.startsWith(sy + " ")));
        if (idx >= 0) { map[f] = idx; used.add(idx); break; }
      }
    }
    return map;
  }
  const hint = (h) => { const s = String(h || ""); if (/pence|\(p\)|gbx/i.test(s)) return "GBp"; if (/£|gbp/i.test(s)) return "GBP"; if (/\$|usd/i.test(s)) return "USD"; if (/€|eur/i.test(s)) return "EUR"; return null; };
  function detectFormat(headers, ibkr) {
    const H = headers.map(normH), has = (...n) => n.every((x) => H.includes(x));
    if (ibkr) return ["Interactive Brokers activity statement (Open Positions)", "USD"];
    if (has("transaction type", "asset") && H.some((h) => h.startsWith("quantity transacted"))) return ["Coinbase transaction history", "GBP"];
    if (has("action") && H.includes("no of shares")) return ["Trading 212 history (aggregated into positions)", "GBP"];
    if (H.includes("buy sell") && (has("title") || H.includes("price per share in account currency"))) return ["Freetrade activity (aggregated into positions)", "GBP"];
    if (H.includes("units held") || has("code", "stock")) return ["Hargreaves Lansdown portfolio", "GBP"];
    if (H.includes("investment") && H.some((h) => h.startsWith("value"))) return ["AJ Bell portfolio", "GBP"];
    if (has("symbol") && (H.includes("cost basis") || H.includes("mark price") || H.includes("close price"))) return ["Interactive Brokers positions", "USD"];
    return ["Generic CSV", "GBP"];
  }
  function startImport(text, fileName) {
    const { delim, rows } = parseCSV(text);
    if (!rows.length) throw new Error("The file is empty or isn't a CSV.");
    let body = rows, ibkr = false;
    const op = rows.filter((r) => r[0] === "Open Positions");
    if (op.length) {
      ibkr = true; const hdr = op.find((r) => r[1] === "Header");
      body = [hdr.slice(2), ...op.filter((r) => r[1] === "Data" && (!/discriminator/i.test(hdr[2] || "") || /summary/i.test(r[2]))).map((r) => r.slice(2))];
    }
    // header row = the row (in the first 40) that matches the most known column names
    let hi = 0, best = -1;
    body.slice(0, 40).forEach((r, n) => { const sc = Object.keys(autoMap(r)).length; if (sc > best) { best = sc; hi = n; } });
    const headers = body[hi], data = body.slice(hi + 1).filter((r) => r.length >= Math.min(2, headers.length));
    const map = autoMap(headers); const [fmt0, defCcy] = detectFormat(headers, ibkr);
    if (best < 2) throw new Error("Couldn't find a header row with columns like Ticker, Quantity or Value.");
    IMP = { fileName, delim, headers, data, map, fmt: fmt0, defCcy, mode: P.holdings.length ? "add" : "replace", acct: fmt0.replace(/ \(.*| (history|activity|portfolio|positions|transaction history|activity statement)$/i, "").trim() };
  }
  function txKind(v) {
    const t = String(v || "").toLowerCase().trim(); if (!t) return null;
    if (/convert/.test(t)) return "convert";
    if (/\bsell|\bsold|disposal/.test(t)) return "sell";
    if (/\bbuy|\bbought|purchase/.test(t)) return "buy";
    if (/^(receive|received|rewards? income|staking income|learning reward|inflation reward|airdrop|incentive)/.test(t)) return "in";
    if (/^(send|sent)/.test(t)) return "out";
    return null;
  }
  function computeImport() {
    if (IMP.kind === "shots") {
      const out = [], today = new Date().toISOString().slice(0, 10); let ignored = 0;
      for (const r of IMP.rows) {
        const sym = String(r.sym || "").trim(), name = String(r.name || "").trim(); if (!sym && !name) { ignored++; continue; }
        const q = toNum(r.qty), avg = toNum(r.avg), price = toNum(r.price), value = toNum(r.value), book = toNum(r.book), c = normCcy(r.ccy) || IMP.defCcy;
        if ((q == null || q <= 0) && value == null) { ignored++; continue; }
        const h = { sym, name: name || sym, qty: q != null && q > 0 ? q : null, ccy: c, avg, book, bookCcy: c };
        if (value != null) { h.value = value; h.valueCcy = c; h.valueAsOf = today; } else if (price != null && h.qty != null) { h.value = +(price * h.qty).toFixed(4); h.valueCcy = c; h.valueAsOf = today; }
        out.push(h);
      }
      return { holdings: out, isTx: false, used: out.length, ignored };
    }
    const I = IMP, m = I.map, col = (r, f) => (m[f] != null && m[f] >= 0 ? r[m[f]] : null), N = (r, f) => num(col(r, f), I.delim);
    const hc = (f) => (m[f] != null && m[f] >= 0 ? hint(I.headers[m[f]]) : null);
    const rowCcy = (r) => normCcy(col(r, "ccy")) || I.defCcy;
    const isTx = m.act != null && m.act >= 0 && I.data.some((r) => { const k = txKind(col(r, "act")); return k === "buy" || k === "sell"; });
    const skip = (r) => { const s = (col(r, "sym") || "") + " " + (col(r, "name") || ""); return !s.trim() || /^\s*(total|totals|cash|sub ?total|grand total)\b/i.test(s.trim()); };
    const out = [], today = new Date().toISOString().slice(0, 10); let used = 0, ignored = 0;
    if (isTx) {
      const pos = new Map();
      const get = (sym, name, r) => { const k = (normSym(sym) || String(name || "").toLowerCase()); if (!pos.has(k)) pos.set(k, { sym: sym || "", name: name || sym || "", qty: 0, book: 0, bookCcy: null, ccy: null, costKnown: true }); return pos.get(k); };
      const rowsS = I.data;
      // most exports are newest-first; sort by any timestamp-like column so sells follow buys
      const tsIdx = I.headers.findIndex((h) => /^(time|timestamp|date|trade date|date time)$/i.test(normH(h)));
      const ordered = tsIdx >= 0 ? [...rowsS].sort((a, b) => String(a[tsIdx]).localeCompare(String(b[tsIdx]))) : rowsS;
      for (const r of ordered) {
        const k = txKind(col(r, "act")); if (!k || skip(r)) { ignored++; continue; }
        const q = Math.abs(N(r, "qty") || 0); if (!q) { ignored++; continue; }
        const p = get(col(r, "sym"), col(r, "name"), r); used++;
        p.ccy = p.ccy || rowCcy(r);
        const tot = N(r, "total"), tccy = normCcy(col(r, "tccy")) || hc("total") || rowCcy(r);
        const px = N(r, "avg"), pxCcy = hc("avg") || rowCcy(r);
        if (k === "buy" || k === "in") {
          let c = tot != null ? Math.abs(tot) : px != null ? px * q : null, cc = tot != null ? tccy : pxCcy;
          if (c == null) { p.costKnown = k === "in" ? p.costKnown : false; c = 0; }
          if (p.bookCcy && cc !== p.bookCcy && c) { const cv = toBaseCcy(c, cc, p.bookCcy); if (cv == null) p.costKnown = false; else c = cv; } else if (!p.bookCcy && c) p.bookCcy = cc;
          p.qty += q; p.book += c;
        } else {
          const frac = p.qty > 0 ? Math.min(q / p.qty, 1) : 0; const removed = p.book * frac;
          p.book -= removed; p.qty -= q;
          if (k === "convert") {
            const mm = /converted\s+([\d.,]+)\s+([A-Z0-9]+)\s+to\s+([\d.,]+)\s+([A-Z0-9]+)/i.exec(col(r, "notes") || "");
            if (mm) { const t = get(mm[4], mm[4], r); t.qty += num(mm[3]); t.book += removed; t.bookCcy = t.bookCcy || p.bookCcy; t.ccy = t.ccy || p.ccy; }
          }
        }
      }
      for (const p of pos.values()) if (p.qty > 1e-9) out.push({ sym: p.sym, name: p.name, qty: +p.qty.toPrecision(12), ccy: p.ccy, book: p.costKnown && p.book > 0 ? +p.book.toFixed(4) : null, bookCcy: p.bookCcy || p.ccy });
    } else {
      for (const r of I.data) {
        if (skip(r)) { ignored++; continue; }
        const qty = N(r, "qty"), val = N(r, "value"), price = N(r, "price");
        if ((qty == null || qty <= 0) && val == null) { ignored++; continue; }
        used++;
        const c = rowCcy(r), pxC = hc("price") || c;
        const h = { sym: col(r, "sym") || "", name: col(r, "name") || col(r, "sym") || "", qty, ccy: hc("avg") || pxC || c, avg: N(r, "avg"), book: N(r, "book"), bookCcy: hc("book") || c };
        if (val != null) { h.value = val; h.valueCcy = hc("value") || c; }
        else if (price != null && qty != null) { h.value = +(price * qty).toFixed(4); h.valueCcy = pxC; }
        if (h.value != null) h.valueAsOf = today;
        out.push(h);
      }
    }
    return { holdings: out, isTx, used, ignored };
  }
  function toBaseCcy(amt, from, to) { const g = toBase(amt, from); if (g == null) return null; const b = P.base; if (to === b) return g; const rb = fxRate(b), rt = fxRate(to === "GBp" ? "GBP" : to); if (!rb || !rt) return null; return g / rb * rt * (to === "GBp" ? 100 : 1); }
  const uid = () => b64e(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, "");
  async function commitImport() {
    const res = computeImport(); if (!res.holdings.length) throw new Error("No holdings found with these columns.");
    const src = (IMP.acct || "Import").slice(0, 40), now = new Date().toISOString();
    const hs = res.holdings.map((h) => ({ id: uid(), ...h, src, added: now }));
    if (IMP.mode === "replace") P.holdings = hs;
    else { const keyH = (h) => src + "|" + (normSym(h.sym) || h.name.toLowerCase()); const nk = new Set(hs.map(keyH)); P.holdings = [...P.holdings.filter((h) => !nk.has(keyH(h))), ...hs]; }
    await savePortfolio(); IMP = null; return hs.length;
  }

  // ---------- encrypted backup (move holdings between iPhone, iPad and Mac) ----------
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  async function exportBackup() {
    const rec = await sealWith(currentKey, payload.salt, payload.iterations, { kind: "invest-intel-portfolio", exportedAt: new Date().toISOString(), portfolio: P });
    const blob = new Blob([JSON.stringify({ app: "invest-intel", type: "encrypted-backup", ...rec }, null, 1)], { type: "application/json" });
    const name = `invest-intel-backup-${iso(new Date())}.json`;
    const file = new File([blob], name, { type: "application/json" });
    if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: "Invest Intel backup" }); return "shared"; } catch (e) { if (e.name === "AbortError") return "cancelled"; } }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return "downloaded";
  }
  async function readBackup(text, pass) {
    let rec; try { rec = JSON.parse(text); } catch { throw new Error("That isn't an Invest Intel backup file."); }
    if (rec.app !== "invest-intel" || !rec.ct || !rec.iv || !rec.salt) throw new Error("That isn't an Invest Intel backup file.");
    let key = currentKey;
    if (rec.salt !== payload.salt) { if (!pass) { const e = new Error("needpass"); e.needPass = true; throw e; } key = await keyFrom(pass, rec.salt, rec.iterations || payload.iterations); }
    let o; try { o = await openWith(key, rec); } catch { throw new Error(pass ? "Wrong passcode for this backup." : "This backup was made with a different passcode."); }
    if (!o.portfolio || !Array.isArray(o.portfolio.holdings)) throw new Error("Backup has no holdings.");
    return o;
  }
  // =====================================================================================
  // Sheet (bottom sheet on phones, centred dialog on iPad/Mac) used by import, edit, backup, More
  // =====================================================================================
  let sheetKind = null, sheetData = null, lastFocus = null;
  function initSheet() {
    const w = $("#sheet");
    w.onclick = (e) => { if (e.target === w || e.target.closest("[data-close]")) { closeSheet(); return; } onSheetClick(e); };
    initShotEvents();
    w.onchange = onSheetChange; w.oninput = onSheetInput; w.onsubmit = (e) => { e.preventDefault(); onSheetSubmit(e.target.closest("form")); };
  }
  function openSheet(kind, data) {
    sheetKind = kind; sheetData = data || null; lastFocus = document.activeElement;
    const w = $("#sheet"); w.hidden = false; document.body.classList.add("sheet-open"); paintSheet();
    requestAnimationFrame(() => { w.classList.add("in"); const f = w.querySelector("[autofocus]") || w.querySelector(".sheet"); if (f && !matchMedia("(pointer: coarse)").matches) f.focus(); });
  }
  function closeSheet(instant) {
    const w = $("#sheet"); if (!w || w.hidden) return; w.classList.remove("in"); document.body.classList.remove("sheet-open");
    if (SHOTS.ctl) try { SHOTS.ctl.abort(); } catch {}
    SHOTS.busy = false; dropShots(); if (IMP && IMP.kind === "shots") IMP = null;
    const done = () => { w.hidden = true; w.querySelector(".sheet").innerHTML = ""; sheetKind = null; sheetData = null; if (lastFocus && lastFocus.focus) try { lastFocus.focus({ preventScroll: true }); } catch {} };
    if (instant) done(); else setTimeout(done, 180);
  }
  const sheetHead = (t, sub) => `<div class="shh"><div class="grab" aria-hidden="true"></div><div class="shrow"><div><h2>${esc(t)}</h2>${sub ? `<div class="tk">${sub}</div>` : ""}</div><button class="iconBtn" data-close aria-label="Close">✕</button></div></div>`;
  function paintSheet() {
    const el = $("#sheet .sheet"); let h = "";
    if (sheetKind === "more") h = sheetHead("More") + `<div class="morelist">${OVERFLOW.map((v) => { const t = TABS.find((x) => x[0] === v); return `<button class="moreit${st.view === v ? " on" : ""}" data-tab-go="${v}"><span class="ic">${t[1]}</span>${esc(v)}<span class="chev">›</span></button>`; }).join("")}</div>`;
    else if (sheetKind === "import") h = importSheet();
    else if (sheetKind === "shots") h = shotsSheet();
    else if (sheetKind === "importChoose") h = importChooser();
    else if (sheetKind === "edit") h = editSheet();
    else if (sheetKind === "backup") h = backupSheet();
    else if (sheetKind === "restorepass") h = sheetHead("Backup passcode") + `<form class="shb" data-form="restorepass"><p class="muted small">This backup was encrypted with a different passcode (or before a passcode change). Enter the passcode it was made with.</p>
      <input type="password" name="pass" autocomplete="off" placeholder="Backup passcode" aria-label="Backup passcode" required autofocus><p class="err" data-err></p>
      <div class="shf"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Open backup</button></div></form>`;
    else if (sheetKind === "restore") h = restoreSheet();
    else if (sheetKind === "rules") h = rulesSheet();
    else if (sheetKind === "week") h = weekSheet();
    else if (sheetKind === "pos") h = posSheet();
    else if (sheetKind === "aiReview") h = aiReviewSheet();
    else if (sheetKind === "context") h = sheetHead("What the analyst sees", `Sent to ${esc(PROVIDERS[A.cfg.provider].label)} with your next message`) + `<div class="shb"><div class="tk">${(sheetData.length / 1000).toFixed(1)}k characters (≈${Math.round(sheetData.length / 3.8 / 1000)}k tokens)</div><pre class="ctxpre">${esc(sheetData)}</pre></div>`;
    el.innerHTML = h; el.classList.toggle("wide", (sheetKind === "import" && !!IMP && IMP.kind === "shots") || sheetKind === "aiReview" || sheetKind === "rules");
    if (sheetKind === "shots") for (const i of SHOTS.imgs) { const t = el.querySelector(`[data-thumb="${i.id}"]`); if (t && i.thumb) t.prepend(i.thumb); }
    el.querySelectorAll("[data-w]").forEach((x) => { x.style.width = x.dataset.w + "%"; });
    el.querySelectorAll("[data-l]").forEach((x) => { x.style.left = x.dataset.l + "%"; });
  }
  function openMore() { openSheet("more"); }

  // =====================================================================================
  // Import from screenshots. Images are downscaled on the device (canvas → JPEG), sent once to the
  // user's chosen AI provider to read the holdings, and then dropped. They are never written to
  // IndexedDB, localStorage, Cache Storage or GitHub.
  // =====================================================================================
  const SHOTS = { imgs: [], busy: false, ctl: null, err: "", drag: false };
  const MAX_SHOTS = 8, MAX_EDGE = 1600;
  const VISION_FALLBACK = { anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol", xai: "grok-4.7" };
  function dropShots() { for (const i of SHOTS.imgs) { i.data = null; if (i.thumb) { i.thumb.width = 0; i.thumb.height = 0; } } SHOTS.imgs = []; SHOTS.err = ""; SHOTS.drag = false; }
  async function decodeImage(file) {
    try { const bm = await createImageBitmap(file); return { src: bm, w: bm.width, h: bm.height, done: () => bm.close && bm.close() }; } catch {}
    // fallback for browsers whose createImageBitmap can't take this type (img-src allows blob: for this only)
    const url = URL.createObjectURL(file); const img = new Image(); img.src = url;
    try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw e; }
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  }
  async function shrink(file) {
    const d = await decodeImage(file);
    try {
      const sc = Math.min(1, MAX_EDGE / Math.max(d.w, d.h)), w = Math.max(1, Math.round(d.w * sc)), h = Math.max(1, Math.round(d.h * sc));
      const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.imageSmoothingQuality = "high"; x.drawImage(d.src, 0, 0, w, h);
      const data = c.toDataURL("image/jpeg", 0.85).split(",")[1];
      const ts = Math.min(1, 220 / Math.max(w, h)), t = document.createElement("canvas"); t.width = Math.round(w * ts); t.height = Math.round(h * ts);
      t.getContext("2d").drawImage(c, 0, 0, t.width, t.height); c.width = 0; c.height = 0;
      return { id: uid(), name: file.name || "Pasted image", w, h, data, thumb: t, kb: Math.round(data.length * 0.75 / 1024) };
    } finally { d.done(); }
  }
  const isImageFile = (f) => f && (/^image\//.test(f.type) || /\.(png|jpe?g|heic|heif|webp|gif)$/i.test(f.name || ""));
  async function addShots(files) {
    SHOTS.err = "";
    for (const f of files) {
      if (!isImageFile(f)) { SHOTS.err = `${f.name || "That file"} isn't an image.`; continue; }
      if (SHOTS.imgs.length >= MAX_SHOTS) { SHOTS.err = `Up to ${MAX_SHOTS} screenshots at a time. Import these, then add the rest.`; break; }
      if (f.size > 40e6) { SHOTS.err = `${f.name} is too large.`; continue; }
      try { SHOTS.imgs.push(await shrink(f)); }
      catch { SHOTS.err = `Couldn't open ${f.name || "an image"}${/hei[cf]/i.test((f.type || "") + (f.name || "")) ? ". This browser can't decode HEIC; in Photos use Share → Save as JPEG, or take a screenshot (PNG) instead" : ""}.`; }
    }
    if (sheetKind === "shots") paintSheet();
  }
  async function pickShots() {
    const fs = await filePick("image/*,.png,.jpg,.jpeg,.heic,.heif", true); if (fs && fs.length) await addShots(fs);
  }
  const SHOT_PROMPT = `You extract investment holdings from screenshots of brokerage, investing or portfolio-tracker apps.
Return ONLY one JSON object (no prose, no code fences) with this shape:
{"broker": string|null, "holdings": [{"name": string|null, "symbol": string|null, "quantity": number|null, "avgCost": number|null, "price": number|null, "value": number|null, "costTotal": number|null, "currency": string|null, "account": string|null, "confidence": number, "uncertain": [string], "image": number}], "unreadable": [string], "notes": string|null}
Rules:
- Copy numbers exactly as shown, as plain JSON numbers (no currency symbols, no thousands separators). If a field is not visible, use null. Never estimate, compute or infer a missing number (for example, do not derive quantity from value and price).
- "symbol" only when a ticker is visibly shown; otherwise null. Do not look tickers up.
- "currency": ISO code of the price/value as displayed (GBP, USD, EUR, ...). Use "GBp" when prices are shown in pence.
- "value" = current market value of the position; "price" = current price per unit; "avgCost" = average cost per unit; "costTotal" = total invested / book cost, if shown.
- "broker": the app or broker name only if visible (logo or title). "account": account type if visible (ISA, SIPP, GIA, ...).
- "confidence": 0 to 1 for how sure you are this row is read correctly. "uncertain": names of fields that are blurry, cut off or ambiguous (use the field names above).
- If the same holding appears in more than one screenshot (overlapping scroll captures), include it once.
- Ignore cash balances, portfolio totals, watchlists, news, ads and charts. Describe anything you could not read in "unreadable".
- "image": 1-based index of the screenshot the row came from.`;
  function visionMessages(provider, imgs) {
    const text = `${imgs.length} screenshot${imgs.length > 1 ? "s" : ""} of my portfolio. Extract the holdings as JSON.`;
    const url = (i) => "data:image/jpeg;base64," + i.data;
    if (provider === "anthropic") return [{ role: "user", content: [...imgs.map((i) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: i.data } })), { type: "text", text }] }];
    if (provider === "xai") return [{ role: "user", content: [...imgs.map((i) => ({ type: "input_image", image_url: url(i), detail: "high" })), { type: "input_text", text }] }];
    return [{ role: "user", content: [...imgs.map((i) => ({ type: "image_url", image_url: { url: url(i), detail: "high" } })), { type: "text", text }] }];
  }
  function parseJsonLoose(t) {
    t = String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a < 0 || b < a) throw new Error("The AI didn't return holdings data. Try clearer screenshots or another model.");
    try { return JSON.parse(t.slice(a, b + 1)); } catch { throw new Error("The AI's answer wasn't valid JSON. Try again."); }
  }
  const NUMF = [["qty", "quantity", "Quantity"], ["avg", "avgCost", "Avg cost"], ["price", "price", "Price"], ["value", "value", "Value"], ["book", "costTotal", "Book cost"]];
  const toNum = (v) => (v == null || v === "" ? null : typeof v === "number" ? (isFinite(v) ? v : null) : num(String(v)));
  function shotRows(j) {
    const rows = (Array.isArray(j.holdings) ? j.holdings : []).map((h) => {
      const r = { sym: String(h.symbol || "").trim(), name: String(h.name || "").trim(), ccy: normCcy(h.currency) || "", acct: String(h.account || "").trim(),
        conf: Math.max(0, Math.min(1, Number(h.confidence) >= 0 ? Number(h.confidence) : 0.5)), img: [h.image].filter(Boolean), flags: [] };
      const unc = new Set((Array.isArray(h.uncertain) ? h.uncertain : []).map(String));
      r.unc = []; for (const [k, src] of NUMF) { r[k] = toNum(h[src]); if (unc.has(src)) r.unc.push(k); }
      if (unc.has("symbol")) r.unc.push("sym"); if (unc.has("name")) r.unc.push("name"); if (unc.has("currency")) r.unc.push("ccy");
      return r;
    }).filter((r) => r.sym || r.name);
    // merge duplicates across screenshots (same symbol/name and account)
    const key = (r) => (normSym(r.sym) || r.name.toLowerCase().replace(/\b(plc|inc|corp|corporation|ltd|limited|ag|sa|nv|se|group|holdings|the|ordinary|shares?|adr|class [a-z])\b|[^a-z0-9]/g, "")) + "|" + r.acct.toLowerCase();
    const out = [];
    for (const r of rows) {
      const e = out.find((x) => x._k === key(r)); if (!e) { out.push({ ...r, _k: key(r) }); continue; }
      for (const [k, , lbl] of NUMF) {
        if (e[k] == null && r[k] != null) e[k] = r[k];
        else if (e[k] != null && r[k] != null && Math.abs(e[k] - r[k]) > 1e-9 * Math.max(1, Math.abs(e[k]))) { e.flags.push(`${lbl} differs between screenshots (${e[k]} vs ${r[k]})`); if (!e.unc.includes(k)) e.unc.push(k); if (r.conf > e.conf) e[k] = r[k]; }
      }
      for (const k of ["sym", "name", "ccy"]) if (!e[k] && r[k]) e[k] = r[k];
      e.conf = Math.min(e.conf, r.conf); e.img = [...new Set([...e.img, ...r.img])];
    }
    for (const r of out) {
      if (r.qty == null) r.flags.push("Quantity not visible: add it, or the holding is valued from the screenshot value only");
      if (r.value == null && r.price == null) r.flags.push("No price or value visible (the dashboard price is used if it matches an idea)");
      delete r._k;
    }
    return out;
  }
  async function readShots() {
    if (SHOTS.busy || !SHOTS.imgs.length || !aiReady()) return;
    const base = curCfg(); SHOTS.busy = true; SHOTS.err = ""; SHOTS.ctl = new AbortController(); paintSheet();
    const n = SHOTS.imgs.length; let used = base.model, text = "";
    const run = async (cfg) => { text = ""; for await (const t of streamChat(cfg, SHOT_PROMPT, visionMessages(cfg.provider, SHOTS.imgs), SHOTS.ctl.signal, 16000)) text += t; };
    try {
      try { await run(base); }
      catch (e) {
        const fb = VISION_FALLBACK[base.provider];
        if (e.name !== "AbortError" && (e.status === 400 || e.status === 404 || e.status === 422) && base.model !== fb && /image|vision|multimodal|modalit|model|input/i.test(e.message)) { used = fb; await run({ ...base, model: fb }); }
        else throw e;
      }
      const j = parseJsonLoose(text), rows = shotRows(j);
      dropShots(); // images are discarded as soon as they have been read
      if (!rows.length) throw new Error("No holdings were found in those screenshots." + (j.unreadable && j.unreadable.length ? " Unreadable: " + j.unreadable.slice(0, 3).join("; ") : ""));
      const broker = String(j.broker || "").trim().slice(0, 40);
      IMP = { kind: "shots", fileName: `${n} screenshot${n > 1 ? "s" : ""}`, rows, unreadable: (Array.isArray(j.unreadable) ? j.unreadable : []).map(String).slice(0, 10), notes: j.notes ? String(j.notes).slice(0, 300) : "",
        fmt: `Read by ${PROVIDERS[base.provider].label} · ${used}${used !== base.model ? " (vision fallback)" : ""}`, defCcy: P.base === "GBP" ? "GBP" : P.base, mode: P.holdings.length ? "add" : "replace",
        acct: (broker || "Screenshots") + (rows[0].acct && rows.every((r) => r.acct === rows[0].acct) ? " " + rows[0].acct : ""), headers: [], data: [], map: {} };
      SHOTS.busy = false; SHOTS.ctl = null; sheetKind = "import"; paintSheet();
    } catch (e) {
      SHOTS.busy = false; SHOTS.ctl = null;
      SHOTS.err = e.name === "AbortError" ? "" : e.status || e instanceof TypeError ? errText(e, { ...base, model: used }) : e.message;
      if (sheetKind === "shots") paintSheet();
    }
  }
  function shotsSheet() {
    const head = sheetHead("Import from screenshots", "Read holdings from your broker or tracker app");
    if (!VS.ready || !A) return head + `<div class="shb">${vaultGate()}</div>`;
    if (!aiReady()) return head + `<div class="shb"><div class="card gate"><div class="sgl" aria-hidden="true">✦</div><h3>Set up the AI analyst first</h3>
      <p class="muted">Screenshots are read by the AI provider you choose (Anthropic, OpenAI or xAI) using your own API key, saved encrypted on this device.</p>
      <button class="btn primary" data-sheet-act="goAI">Open AI settings</button></div>
      <div class="privnote">Images are sent only to the provider you choose, are never stored, and are discarded after reading.</div>
      <div class="shf"><button class="btn" data-close>Close</button></div></div>`;
    const cc = curCfg(), pv = PROVIDERS[cc.provider], n = SHOTS.imgs.length, coarse = matchMedia("(pointer: coarse)").matches;
    if (SHOTS.busy) return head + `<div class="shb"><div class="reading"><div class="spin" aria-hidden="true"></div><b>Reading ${n} screenshot${n > 1 ? "s" : ""} with ${esc(pv.label)}…</b>
      <div class="tk">${esc(cc.model)} · usually 10–40 seconds</div></div><div class="thumbs">${SHOTS.imgs.map((i) => `<div class="thumb dim" data-thumb="${i.id}"></div>`).join("")}</div>
      <div class="shf"><button class="btn" data-sheet-act="cancelRead">Cancel</button></div></div>`;
    return head + `<div class="shb">
      <div class="dropz${SHOTS.drag ? " over" : ""}" data-dropz><div class="dzi" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 9"/></svg></div>
        <b>${n ? "Add more screenshots" : "Add screenshots of your holdings"}</b>
        <div class="tk">${coarse ? "From Photos or Files. Scroll captures are fine; overlaps are merged." : "Choose files, drag them here, or paste (⌘V). Overlapping scroll captures are merged."}</div>
        <button class="btn primary" data-sheet-act="pickShots">${coarse ? "Choose photos" : "Choose images"}</button></div>
      ${n ? `<div class="slbl">${n} of ${MAX_SHOTS} · ${SHOTS.imgs.reduce((a, i) => a + i.kb, 0)} KB after downscaling</div><div class="thumbs">${SHOTS.imgs.map((i, k) => `<div class="thumb" data-thumb="${i.id}"><span class="tn">${k + 1}</span><button class="tx" data-sheet-act="rmShot" data-id="${i.id}" aria-label="Remove screenshot ${k + 1}">✕</button></div>`).join("")}</div>` : ""}
      <div class="privnote">🔒 Images are downscaled on this device and sent only to ${esc(pv.long)} (${esc(cc.model)}) to read the holdings. They are never saved (not on this device, not to GitHub) and are discarded as soon as they're read. Nothing is imported until you review and confirm.</div>
      <p class="err" role="alert">${esc(SHOTS.err)}</p>
      <div class="shf"><button class="btn" data-close>Cancel</button><button class="btn primary" data-sheet-act="readShots"${n ? "" : " disabled"}>Read ${n || ""} screenshot${n === 1 ? "" : "s"}</button></div></div>`;
  }
  function importChooser() {
    return sheetHead("Import holdings", "Choose a source") + `<div class="shb">
      <button class="srcopt" data-sheet-act="chooseCsv"><span class="soi">⇪</span><span><b>Broker CSV file</b><span class="tk">Trading 212, Freetrade, HL, AJ Bell, IBKR, Coinbase or any CSV</span></span><span class="chev">›</span></button>
      <button class="srcopt" data-sheet-act="chooseShots"><span class="soi ai">✦</span><span><b>Screenshots</b><span class="tk">Photos of your app's holdings screen, read by your AI analyst. You review every row.</span></span><span class="chev">›</span></button>
      <div class="privnote">🔒 Holdings are encrypted with your passcode on this device and never uploaded.</div></div>`;
  }
  // editable rows for screenshot imports (shown inside the normal import sheet)
  function shotsPreview() {
    const I = IMP, lc = (r, k) => (r.unc.includes(k) ? " lowc" : "");
    const fld = (r, n, k, lbl) => { const v = r[k]; const miss = v == null || v === ""; return `<label class="ef${lc(r, k)}${miss && (k === "qty" || (k === "value" && r.price == null)) ? " miss" : ""}"><span>${lbl}</span><input data-ef="${k}" data-n="${n}" inputmode="decimal" value="${esc(v ?? "")}" placeholder="${miss ? "not visible" : ""}" autocomplete="off"></label>`; };
    const cbadge = (c) => `<span class="conf ${c >= 0.85 ? "c-hi" : c >= 0.6 ? "c-mid" : "c-lo"}" title="AI confidence">${Math.round(c * 100)}%</span>`;
    return `<datalist id="ideaSyms">${D.ideas.map((i) => `<option value="${esc(i.ticker.split(" / ")[0])}">${esc(i.name)}</option>`).join("")}</datalist>
      <div class="erows">${I.rows.map((r, n) => { const mt = matchIdea(rowHolding(r));
        return `<div class="erow${r.conf < 0.6 ? " lowr" : ""}" data-row="${n}"><div class="er1">
          <label class="ef sym${lc(r, "sym")}"><span>Symbol</span><input data-ef="sym" data-n="${n}" value="${esc(r.sym)}" list="ideaSyms" placeholder="ticker" autocapitalize="characters" spellcheck="false" autocomplete="off"></label>
          <label class="ef nm${lc(r, "name")}"><span>Name</span><input data-ef="name" data-n="${n}" value="${esc(r.name)}" autocomplete="off"></label>
          <div class="erm">${cbadge(r.conf)}<span data-match="${n}">${mt ? pill(mt.i.ticker, ACTION_TONE[mt.i.action]) : `<span class="tk">no match</span>`}</span><button class="iconBtn sm" data-sheet-act="delRow" data-n="${n}" aria-label="Remove row">✕</button></div></div>
          <div class="er2">${fld(r, n, "qty", "Quantity")}${fld(r, n, "avg", "Avg cost")}${fld(r, n, "price", "Price")}${fld(r, n, "value", "Value")}
          <label class="ef${lc(r, "ccy")}"><span>Currency</span><select data-ef="ccy" data-n="${n}">${CCYS.map((c) => `<option${(r.ccy || I.defCcy) === c ? " selected" : ""}>${c}</option>`).join("")}</select></label></div>
          ${r.flags.length ? `<div class="eflag">${r.flags.map((f) => `<div>⚠ ${esc(f)}</div>`).join("")}</div>` : ""}${r.img.length ? `<div class="tk">From screenshot ${r.img.map(esc).join(", ")}</div>` : ""}</div>`; }).join("")}</div>
      <button class="btn sm addrow" data-sheet-act="addRow">＋ Add a row</button>
      ${I.unreadable.length ? `<div class="unread"><b>Couldn't read</b>${I.unreadable.map((u) => `<div>· ${esc(u)}</div>`).join("")}</div>` : ""}`;
  }
  const rowHolding = (r) => ({ sym: String(r.sym || "").trim(), name: String(r.name || "").trim(), ccy: normCcy(r.ccy) || (IMP && IMP.defCcy) || "GBP" });
  function updateShotRow(n) {
    const r = IMP.rows[n], mt = matchIdea(rowHolding(r)), el = $(`#sheet [data-match="${n}"]`);
    if (el) el.innerHTML = mt ? pill(mt.i.ticker, ACTION_TONE[mt.i.action]) : `<span class="tk">no match</span>`;
    const res = computeImport(), b = $("#sheet [data-sheet-act=commitImport]"); if (b) { b.textContent = `Import ${res.holdings.length || ""}`; b.disabled = !res.holdings.length; }
  }
  function initShotEvents() {
    document.addEventListener("paste", (e) => {
      if (sheetKind !== "shots" || !e.clipboardData) return;
      const fs = [...e.clipboardData.items].filter((i) => i.kind === "file" && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
      if (fs.length) { e.preventDefault(); addShots(fs); }
    });
    const w = $("#sheet"), on = (v) => { if (SHOTS.drag !== v) { SHOTS.drag = v; const z = $("#sheet [data-dropz]"); if (z) z.classList.toggle("over", v); } };
    w.addEventListener("dragover", (e) => { if (sheetKind !== "shots" || SHOTS.busy) return; e.preventDefault(); on(true); });
    w.addEventListener("dragleave", (e) => { if (e.target === w || !w.contains(e.relatedTarget)) on(false); });
    w.addEventListener("drop", (e) => { if (sheetKind !== "shots") return; e.preventDefault(); on(false); const fs = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (fs.length) addShots(fs); });
  }

  // ---------- import sheet ----------
  function importSheet() {
    const I = IMP; let res; let err = "";
    if (I.kind === "shots") {
      res = computeImport();
      return sheetHead("Review holdings", `${esc(I.fileName)} · ${I.rows.length} row${I.rows.length === 1 ? "" : "s"} found`) + `<div class="shb">
        <div class="detect"><span class="pill t-accent">AI read</span> <b>${esc(I.fmt)}</b></div>
        <div class="legend2"><span><i class="lg lowc"></i>Hard to read: check it</span><span><i class="lg miss"></i>Not visible: left blank, never guessed</span></div>
        ${shotsPreview()}
        ${I.notes ? `<div class="tk">AI note: ${esc(I.notes)}</div>` : ""}
        <label class="fld"><span>Account label</span><input type="text" data-imp-set="acct" value="${esc(I.acct)}" maxlength="40" placeholder="e.g. Trading 212 ISA"></label>
        ${P.holdings.length ? `<div class="slbl">Existing holdings</div><div class="chips">${[["add", "Add / update this account"], ["replace", "Replace everything"]].map(([v, l]) => `<button data-imp-mode="${v}" class="${I.mode === v ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
        <div class="privnote">🔒 The screenshots have already been discarded. Nothing is saved until you tap Import; holdings are then encrypted on this device only.</div>
        <div class="err" data-err></div>
        <div class="shf"><button class="btn" data-close>Cancel</button><button class="btn primary" data-sheet-act="commitImport"${res.holdings.length ? "" : " disabled"}>Import ${res.holdings.length || ""}</button></div></div>`;
    }
    try { res = computeImport(); } catch (e) { err = e.message; res = { holdings: [], used: 0, ignored: 0 }; }
    const opt = (f) => `<select data-imp-map="${f}" aria-label="${esc(f)}"><option value="-1">—</option>${I.headers.map((h, n) => `<option value="${n}"${I.map[f] === n ? " selected" : ""}>${esc(h || "(column " + (n + 1) + ")")}</option>`).join("")}</select>`;
    const prev = res.holdings.slice(0, 8);
    return sheetHead("Import holdings", `${esc(I.fileName)} · ${I.data.length} rows`) + `<div class="shb">
      <div class="detect"><span class="pill t-accent">Detected</span> <b>${esc(I.fmt)}</b></div>
      ${res.isTx ? `<div class="tk">Transactions are added up into current positions (buys minus sells, average cost). Dividends, deposits and fees are ignored.</div>` : ""}
      <div class="slbl">Preview · ${res.holdings.length} position${res.holdings.length === 1 ? "" : "s"}${res.ignored ? ` · ${res.ignored} row${res.ignored === 1 ? "" : "s"} skipped` : ""}</div>
      ${prev.length ? `<div class="tblw"><table class="simple prev"><tr><th>Holding</th><th>Qty</th><th>Cost</th><th>Value</th><th>Match</th></tr>${prev.map((h) => { const mt = matchIdea(h);
        return `<tr><td><b>${esc(h.sym || "—")}</b><div class="tk">${esc(h.name)}</div></td><td>${esc(qtyFmt(h.qty))}</td><td>${h.book != null ? esc(money(h.book, h.bookCcy)) : h.avg != null ? esc(money(h.avg, h.ccy)) + "<div class='tk'>avg</div>" : "—"}</td><td>${h.value != null ? esc(money(h.value, h.valueCcy)) : "—"}</td><td>${mt ? pill(mt.i.ticker, ACTION_TONE[mt.i.action]) : `<span class="tk">—</span>`}</td></tr>`; }).join("")}</table></div>
        ${res.holdings.length > prev.length ? `<div class="tk">…and ${res.holdings.length - prev.length} more</div>` : ""}` : `<div class="card muted small">${esc(err || "No positions found. Check the Quantity and Symbol/Name columns above.")}</div>`}
      <details class="mapd"${I.fmt === "Generic CSV" ? " open" : ""}><summary>Column mapping <span class="tk">(check or change)</span></summary>
      <div class="mapg">${FIELDS.map(([f, l]) => `<label><span>${esc(l)}</span>${opt(f)}</label>`).join("")}
      <label><span>Default currency</span><select data-imp-set="defCcy">${CCYS.map((c) => `<option${I.defCcy === c ? " selected" : ""}>${c}</option>`).join("")}</select></label></div></details>
      <label class="fld"><span>Account label</span><input type="text" data-imp-set="acct" value="${esc(I.acct)}" maxlength="40" placeholder="e.g. Trading 212 ISA"></label>
      ${P.holdings.length ? `<div class="slbl">Existing holdings</div><div class="chips">${[["add", "Add / update this account"], ["replace", "Replace everything"]].map(([v, l]) => `<button data-imp-mode="${v}" class="${I.mode === v ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
      <div class="privnote">🔒 Parsed on this device. Holdings are encrypted with your passcode and never uploaded.</div>
      <div class="err" data-err></div>
      <div class="shf"><button class="btn" data-close>Cancel</button><button class="btn primary" data-sheet-act="commitImport"${res.holdings.length ? "" : " disabled"}>Import ${res.holdings.length || ""}</button></div></div>`;
  }
  // ---------- add / edit holding ----------
  function editSheet() {
    const h = sheetData.h, isNew = !sheetData.id;
    const ideaOpts = [["", "Auto-match"], ["none", "Not on dashboard"], ...ranked.map((i) => [keyOf(i), `${i.name} (${i.ticker})`])];
    const f = (name, label, val, attrs = "") => `<label class="fld"><span>${label}</span><input name="${name}" value="${esc(val ?? "")}" ${attrs}></label>`;
    return sheetHead(isNew ? "Add holding" : "Edit holding", isNew ? "Search the dashboard's ideas or type any symbol" : esc(h.src || "")) + `<form class="shb" data-form="holding" autocomplete="off">
      <label class="fld"><span>Symbol or name</span><input name="sym" value="${esc(h.sym)}" placeholder="e.g. AAPL, or start typing a dashboard idea" required autofocus autocapitalize="characters" spellcheck="false"></label>
      <div class="sugg" data-sugg></div>
      ${f("name", "Name", h.name, 'placeholder="Optional"')}
      <div class="fgrid">${f("qty", "Quantity", h.qty, 'inputmode="decimal" placeholder="0" required')}
        <label class="fld"><span>Currency</span><select name="ccy">${CCYS.map((c) => `<option${(h.ccy || "GBP") === c ? " selected" : ""}>${c}</option>`).join("")}</select></label>
        ${f("avg", "Avg cost / unit", h.avg, 'inputmode="decimal" placeholder="Optional"')}
        ${f("book", "Book cost (total)", h.book, 'inputmode="decimal" placeholder="Optional"')}</div>
      ${f("manualPx", "Manual price / unit", h.manualPx, 'inputmode="decimal" placeholder="Only used if the dashboard has no price"')}
      <label class="fld"><span>Dashboard idea</span><select name="link">${ideaOpts.map(([v, l]) => `<option value="${esc(v)}"${(h.link || "") === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      ${f("src", "Account", h.src, 'placeholder="e.g. ISA, SIPP, Coinbase" maxlength="40"')}
      <div class="tk">Book cost and avg cost are in the selected currency (GBp = pence). Prices come from the dashboard when the holding matches an idea.</div>
      <p class="err" data-err></p>
      <div class="shf">${isNew ? "" : `<button class="btn dangerT" type="button" data-sheet-act="delHolding">Delete</button>`}<span class="sp"></span><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">${isNew ? "Add" : "Save"}</button></div></form>`;
  }
  function suggestions(q) {
    const t = q.trim().toLowerCase(); if (!t) return "";
    const hits = D.ideas.filter((i) => i.ticker.toLowerCase().includes(t) || i.name.toLowerCase().includes(t) || normSym(i.ticker).toLowerCase() === normSym(q).toLowerCase()).slice(0, 5);
    return hits.map((i) => `<button type="button" class="sg" data-pick="${esc(keyOf(i))}"><b>${esc(i.ticker)}</b> ${esc(i.name)} <span class="tk">${esc(i.listing)}</span>${pill(i.action, ACTION_TONE[i.action])}</button>`).join("")
      + (hits.length ? "" : `<div class="tk sgn">Not a dashboard idea: it will be tracked as “${esc(q.trim())}”. Add a manual price to value it.</div>`);
  }
  // ---------- backup ----------
  function backupSheet() {
    return sheetHead("Backup and sync", "Move your holdings between iPhone, iPad and Mac") + `<div class="shb">
      <div class="bk"><div class="bki">⇪</div><div><b>Export encrypted backup</b><div class="tk">A small .json file encrypted with your passcode (AES-256-GCM). ${isIOS() ? "Save it to Files or AirDrop it to your other device." : "It downloads to this Mac."}</div></div>
        <button class="btn primary" data-sheet-act="export"${P.holdings.length ? "" : " disabled"}>Export</button></div>
      <div class="bk"><div class="bki">⇩</div><div><b>Restore from backup</b><div class="tk">Pick a backup file. You can merge or replace.</div></div>
        <button class="btn" data-sheet-act="pickBackup">Choose file</button></div>
      <div class="privnote">The backup contains holdings only, not your AI key or chat. Anyone with the file still needs your passcode.</div>
      <p class="err" data-err></p><p class="ok" data-ok></p></div>`;
  }
  function restoreSheet() {
    const o = sheetData.o, n = o.portfolio.holdings.length;
    return sheetHead("Restore backup", `Exported ${esc(dLabel(o.exportedAt || ""))} · ${n} holding${n === 1 ? "" : "s"}`) + `<div class="shb">
      <div class="tblw"><table class="simple prev"><tr><th>Holding</th><th>Qty</th><th>Account</th></tr>${o.portfolio.holdings.slice(0, 8).map((h) => `<tr><td><b>${esc(h.sym || "—")}</b><div class="tk">${esc(h.name)}</div></td><td>${esc(qtyFmt(h.qty))}</td><td class="tk">${esc(h.src || "")}</td></tr>`).join("")}</table></div>
      <div class="shf"><button class="btn" data-close>Cancel</button><button class="btn" data-sheet-act="restoreMerge">Merge</button><button class="btn primary" data-sheet-act="restoreReplace">Replace</button></div></div>`;
  }
  const sheetErr = (m) => { const e = $("#sheet [data-err]"); if (e) e.textContent = m || ""; };
  const filePick = (accept, multi) => new Promise((res) => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = accept; inp.multiple = !!multi; inp.style.display = "none";
    inp.onchange = () => { const fs = [...(inp.files || [])]; inp.remove(); res(multi ? fs : fs[0] || null); }; document.body.appendChild(inp); inp.click();
  });
  const readFile = (f) => new Promise((res, rej) => { if (f.size > 8e6) { rej(new Error("File is larger than 8 MB.")); return; } const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });
  async function pickCsv() {
    const f = await filePick(".csv,.tsv,.txt,text/csv,text/plain,text/comma-separated-values,text/tab-separated-values,application/vnd.ms-excel"); if (!f) return;
    try { startImport(await readFile(f), f.name); openSheet("import"); } catch (e) { toast(e.message || "Couldn't read that file", "bad"); }
  }
  let restoreText = null;
  async function onSheetClick(e) {
    const go = e.target.closest("[data-tab-go]"); if (go) { goTab(go.dataset.tabGo); return; }
    // review sheets reuse main-view controls: open an idea, edit a holding, or run a main action
    if (!e.target.closest("[data-sheet-act]")) {
      const op = e.target.closest("[data-open]"); if (op) { closeSheet(true); openDetail(op.dataset.open); return; }
      const ed = e.target.closest("[data-edit]"); if (ed) { const h = P && P.holdings.find((x) => x.id === ed.dataset.edit); if (h) { sheetKind = "edit"; sheetData = { id: h.id, h: { ...h } }; paintSheet(); } return; }
      const xa = e.target.closest("[data-act]"); if (xa && EXTRA_ACTS[xa.dataset.act]) { if (!["aiReview", "aiOpen", "posSheet", "weekList", "sizingRules"].includes(xa.dataset.act)) closeSheet(true); EXTRA_ACTS[xa.dataset.act](xa, e); return; }
    }
    const mode = e.target.closest("[data-imp-mode]"); if (mode) { IMP.mode = mode.dataset.impMode; paintSheet(); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick) { const i = D.ideas.find((x) => keyOf(x) === pick.dataset.pick); const fm = $("#sheet form"); if (i && fm) { fm.sym.value = i.ticker.split(" / ")[0]; fm.name.value = i.name; fm.link.value = keyOf(i); const pc = mkt(i) && mkt(i).price && normCcy(mkt(i).price.currency); if (pc && !isCryptoIdea(i)) fm.ccy.value = pc; $("#sheet [data-sugg]").innerHTML = ""; fm.qty.focus(); } return; }
    const b = e.target.closest("[data-sheet-act]"); if (!b) return; const a = b.dataset.sheetAct;
    if (reviewSheetClick(b)) return;
    try {
      if (a === "chooseCsv") { closeSheet(true); pickCsv(); return; }
      if (a === "chooseShots") { sheetKind = "shots"; dropShots(); paintSheet(); return; }
      if (a === "pickShots") { await pickShots(); return; }
      if (a === "rmShot") { const k = SHOTS.imgs.findIndex((i) => i.id === b.dataset.id); if (k >= 0) { const [x] = SHOTS.imgs.splice(k, 1); x.data = null; } paintSheet(); return; }
      if (a === "readShots") { await readShots(); return; }
      if (a === "cancelRead") { if (SHOTS.ctl) SHOTS.ctl.abort(); return; }
      if (a === "goAI") { closeSheet(true); goTab("Settings"); setTimeout(() => { const el = document.getElementById("ai-settings"); if (el) el.scrollIntoView({ block: "start" }); }, 60); return; }
      if (a === "delRow") { IMP.rows.splice(+b.dataset.n, 1); paintSheet(); return; }
      if (a === "addRow") { IMP.rows.push({ sym: "", name: "", qty: null, avg: null, price: null, value: null, book: null, ccy: IMP.defCcy, acct: "", conf: 1, unc: [], flags: [], img: [] }); paintSheet(); const ins = $$("#sheet .erow:last-child input"); if (ins[0]) ins[0].focus(); return; }
      if (a === "commitImport") { b.disabled = true; const n = await commitImport(); closeSheet(); render(); toast(`Imported ${n} holding${n === 1 ? "" : "s"}`); }
      if (a === "delHolding") { if (!confirm("Delete this holding from this device?")) return; P.holdings = P.holdings.filter((h) => h.id !== sheetData.id); await savePortfolio(); closeSheet(); render(); toast("Holding deleted"); }
      if (a === "export") { const r = await exportBackup(); const ok = $("#sheet [data-ok]"); if (ok && r !== "cancelled") ok.textContent = r === "shared" ? "Backup ready to save." : "Backup downloaded."; }
      if (a === "pickBackup") { const f = await filePick(".json,application/json,text/plain"); if (!f) return; restoreText = await readFile(f); await tryRestore(null); }
      if (a === "restoreMerge" || a === "restoreReplace") {
        const hs = sheetData.o.portfolio.holdings;
        if (a === "restoreReplace") P.holdings = hs; else { const ids = new Set(P.holdings.map((h) => h.id)); P.holdings = [...P.holdings, ...hs.filter((h) => !ids.has(h.id))]; }
        if (sheetData.o.portfolio.base) P.base = sheetData.o.portfolio.base;
        await savePortfolio(); closeSheet(); render(); toast("Backup restored");
      }
    } catch (err) { b.disabled = false; sheetErr(err.message || "Something went wrong"); }
  }
  async function tryRestore(pass) {
    try { const o = await readBackup(restoreText, pass); restoreText = null; sheetKind = "restore"; sheetData = { o }; paintSheet(); }
    catch (e) { if (e.needPass) { sheetKind = "restorepass"; paintSheet(); } else sheetErr(e.message); }
  }
  function onSheetChange(e) {
    const ef = e.target.closest("select[data-ef]"); if (ef && IMP && IMP.kind === "shots") { IMP.rows[+ef.dataset.n][ef.dataset.ef] = ef.value; updateShotRow(+ef.dataset.n); return; }
    const m = e.target.closest("[data-imp-map]"); if (m) { IMP.map[m.dataset.impMap] = +m.value; paintSheet(); const d = $("#sheet details"); if (d) d.open = true; return; }
    const s = e.target.closest("[data-imp-set]"); if (s && s.tagName === "SELECT") { IMP[s.dataset.impSet] = s.value; paintSheet(); const d = $("#sheet details"); if (d) d.open = true; }
  }
  function onSheetInput(e) {
    const ef = e.target.closest("input[data-ef]");
    if (ef && IMP && IMP.kind === "shots") { const r = IMP.rows[+ef.dataset.n], k = ef.dataset.ef; r[k] = ["sym", "name"].includes(k) ? ef.value : ef.value.trim() === "" ? null : ef.value; ef.closest(".ef").classList.remove("miss"); updateShotRow(+ef.dataset.n); return; }
    const s = e.target.closest("[data-imp-set]"); if (s && s.tagName === "INPUT") { IMP[s.dataset.impSet] = s.value; return; }
    if (e.target.name === "sym" && sheetKind === "edit") $("#sheet [data-sugg]").innerHTML = suggestions(e.target.value);
  }
  async function onSheetSubmit(form) {
    if (!form) return; const k = form.dataset.form;
    try {
      if (k === "holding") {
        const n = (x) => (x.trim() === "" ? null : num(x));
        const h = { sym: form.sym.value.trim(), name: form.name.value.trim() || form.sym.value.trim(), qty: n(form.qty.value), ccy: form.ccy.value, avg: n(form.avg.value), book: n(form.book.value), manualPx: n(form.manualPx.value), link: form.link.value || undefined, src: form.src.value.trim() || "Manual" };
        if (!h.sym) throw new Error("Add a symbol or name."); if (h.qty == null || h.qty <= 0) throw new Error("Quantity must be more than zero.");
        h.bookCcy = h.ccy;
        if (sheetData.id) { const o = P.holdings.find((x) => x.id === sheetData.id); const keepVal = o.value != null && o.qty === h.qty ? { value: o.value, valueCcy: o.valueCcy, valueAsOf: o.valueAsOf } : {}; Object.assign(o, { value: undefined, valueCcy: undefined, valueAsOf: undefined }, h, keepVal); }
        else P.holdings.push({ id: uid(), ...h, added: new Date().toISOString() });
        await savePortfolio(); const isNew = !sheetData.id; closeSheet(); render(); toast(isNew ? "Holding added" : "Holding saved");
      }
      if (k === "restorepass") await tryRestore(form.pass.value);
    } catch (e) { sheetErr(e.message); }
  }

  // ---------- toast ----------
  let toastT = null;
  function toast(msg, tone) {
    let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.className = "toast show" + (tone ? " " + tone : ""); t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => { t.className = "toast"; }, 2600);
  }

  // =====================================================================================
  // Portfolio view
  // =====================================================================================
  const EXP_TONE = (k) => ACTION_TONE[k] || (THEMES.includes(k) ? "accent" : "neutral");
  function expBars(rows, kind) {
    if (!rows.length) return `<div class="muted small">No priced holdings yet.</div>`;
    return `<div class="xbars">${rows.map((r) => `<div class="xb"><div class="xl">${kind === "action" && ACTION_TONE[r.k] ? pill(r.k, ACTION_TONE[r.k]) : `<span class="xn">${kind === "theme" && THEMES.includes(r.k) ? `<i class="l${THEMES.indexOf(r.k)}"></i>` : ""}${esc(r.k)}</span>`}</div>
      <div class="track"><div class="fill x-${kind === "action" ? EXP_TONE(r.k) : kind === "theme" ? "t" + THEMES.indexOf(r.k) : "accent"}" data-w="${r.w.toFixed(1)}"></div></div><div class="xv"><b>${r.w.toFixed(1)}%</b><span class="tk">${esc(bm(r.v, 0))}</span></div></div>`).join("")}</div>`;
  }
  function stackBar(rows) {
    if (!rows.length) return "";
    return `<div class="stack" role="img" aria-label="Exposure by theme">${rows.map((r) => `<span class="seg x-${THEMES.includes(r.k) ? "t" + THEMES.indexOf(r.k) : "neutral"}" data-w="${r.w.toFixed(2)}" title="${esc(r.k)} ${r.w.toFixed(1)}%"></span>`).join("")}</div>`;
  }
  function portfolioSide(c) {
    c = c || (P && VS.ready ? pfCalc() : null);
    if (!c || !P.holdings.length) return `<div class="card pside-empty"><div class="gic">◔</div><h3>Exposure appears here</h3><p class="muted small">Once you add holdings you'll see exposure by theme and by dashboard action, concentration and the top ideas you don't hold.</p></div>`;
    return `<h3>Exposure by theme</h3><div class="card">${stackBar(c.byTheme)}${expBars(c.byTheme, "theme")}</div>
      <h3>Exposure by dashboard action</h3><div class="card">${expBars(c.byAction, "action")}</div>
      <h3>Largest positions</h3><div class="card">${expBars(c.rows.filter((r) => r.w != null).slice(0, 8).map((r) => ({ k: r.h.name || r.h.sym, v: r.v, w: r.w })), "pos")}
        <div class="tk">Top 3 = ${c.top3.toFixed(0)}% of priced holdings</div></div>
      ${c.byCcy.length > 1 ? `<h3>Currency exposure</h3><div class="card">${expBars(c.byCcy, "ccy")}<div class="tk">FX: ${esc((D.market && D.market.fx && D.market.fx.source) || "n/a")}${D.market && D.market.fx ? ", " + esc(dLabel(D.market.fx.date)) : ""}</div></div>` : ""}
      ${c.gaps.length ? `<h3>Top-rated ideas you don't hold</h3><div class="card list">${c.gaps.map((i) => `<button class="item gap" data-open="${esc(keyOf(i))}"><div class="body"><div class="ttl"><b>${esc(i.name)}</b> <span class="tk">${esc(i.ticker)}</span></div><div class="det">${esc(i.trigger)}</div></div><div class="gs">${pill(i.action, ACTION_TONE[i.action])}<b>${fmt(score10(i))}</b></div></button>`).join("")}</div>` : ""}`;
  }
  function holdingRow(r, R, scale) {
    const h = r.h, i = r.mt && r.mt.i, k = i ? keyOf(i) : null, g = R ? R.byId.get(h.id) : null;
    const plp = r.pl != null && r.cost ? r.pl / r.cost * 100 : null;
    const open = k ? `data-open="${esc(k)}"` : g ? `data-act="posSheet" data-g="${esc(g.k)}"` : `data-edit="${esc(h.id)}"`;
    const chg = !g ? "" : g.dec === "Review" ? (g.unrated ? "Not on the dashboard: review it" : "No price: add one to size it") : g.dec === "Hold" ? `Hold · range ${pct1(g.lo)}–${pct1(g.hi)}` : g.short || g.change;
    return `<div class="hrow${st.detail && st.detail === k ? " sel" : ""}">
      <button class="hold hmain" ${open} aria-label="${esc((h.name || h.sym) + (g ? ", " + g.dec : "") + (i ? ", open idea" : g ? ", open position" : ", edit"))}">
        <div class="hn"><span class="hsym">${esc(h.sym || "—")}</span><span class="hname">${esc(h.name && h.name !== h.sym ? h.name : "")}</span></div>
        <div class="hmeta">${g ? decPill(g.dec) : ""}${i ? `${pill(i.action, ACTION_TONE[i.action])}<span class="hsc">${fmt(score10(i))}</span>` : `<span class="pill t-neutral">Not on dashboard</span>`}<span class="tk">${esc(qtyFmt(h.qty))}${r.px != null ? " × " + esc(money(r.px, r.pxCcy)) : ""}</span></div>
        ${g ? `<div class="hw2">${targetBar(g, scale)}<span class="hchg c-${g.dec.toLowerCase()}">${esc(chg)}</span></div>` : `<div class="hw"><span class="track"><span class="fill" data-w="${r.w != null ? r.w.toFixed(1) : 0}"></span></span></div>`}
      </button>
      <div class="hval">${r.v != null ? `<b>${esc(bm(r.v))}</b>` : `<span class="nopx">No price</span>`}
        ${r.pl != null ? `<span class="${r.pl > 0 ? "pos" : r.pl < 0 ? "neg" : "tk"}">${esc(bmS(r.pl))}${plp != null ? ` · ${pct(plp)}` : ""}</span>` : r.v != null ? `<span class="tk">No cost</span>` : ""}
        <span class="tk">${r.v == null ? (r.src === "nofx" ? `<span class="src s-nofx">No FX rate</span>` : "Tap ✎ to add a price") : `${r.w != null ? r.w.toFixed(1) + "% · " : ""}<span class="src s-${r.src}">${esc(SRC_LABEL[r.src])}</span>`}</span></div>
      <button class="iconBtn sm" data-edit="${esc(h.id)}" aria-label="Edit ${esc(h.sym || h.name)}">✎</button></div>`;
  }
  function portfolioMain() {
    const gate = vaultGate(); if (gate) return `<div class="phead"><h2>Portfolio</h2></div>${gate}`;
    const n = P.holdings.length;
    const tools = `<div class="ptools"><button class="btn primary" data-act="importChoose"><span aria-hidden="true">⇪</span> Import</button><button class="btn" data-act="addHolding">＋ Add</button><button class="btn" data-act="backup" aria-label="Backup and sync">⇅ Backup</button></div>`;
    if (!n) return `<div class="phead"><h2>Portfolio</h2></div>
      <div class="card pempty"><div class="gic big">◔</div><h3>Bring in your holdings</h3>
        <p class="muted">See your value, P/L and exposure next to the dashboard's ratings, with flags like “you hold X, rated Trim”.</p>
        <div class="pemptyb"><button class="btn primary" data-act="importCsv">⇪ Import broker CSV</button><button class="btn primary" data-act="importShots">✦ Import from screenshots</button><button class="btn" data-act="addHolding">＋ Add manually</button><button class="btn" data-act="restoreFile">⇩ Restore backup</button></div>
        <div class="brokers"><span>Screenshots of any app</span><span>Trading 212</span><span>Freetrade</span><span>Hargreaves Lansdown</span><span>AJ Bell</span><span>Interactive Brokers</span><span>Coinbase</span><span>Any CSV</span></div>
        <div class="privnote">🔒 Stored only on this device, encrypted with your passcode. Never uploaded or published.</div></div>
      <h3>Where to get the CSV</h3><div class="card list small howto">
        <div class="item"><div class="lead">Trading 212</div><div class="body">Menu → History → Export (CSV). Transactions are added up into positions.</div></div>
        <div class="item"><div class="lead">Freetrade</div><div class="body">Activity → Export (CSV).</div></div>
        <div class="item"><div class="lead">HL</div><div class="body">Portfolio overview → Download (CSV).</div></div>
        <div class="item"><div class="lead">AJ Bell</div><div class="body">Portfolio → Valuation → Export to CSV.</div></div>
        <div class="item"><div class="lead">IBKR</div><div class="body">Reports → Activity statement → CSV (uses the Open Positions section).</div></div>
        <div class="item"><div class="lead">Coinbase</div><div class="body">Profile → Statements → Transaction history (CSV).</div></div>
        <div class="item"><div class="lead">Trackers</div><div class="body">Sharesight, Snowball, Delta and similar: export holdings to CSV, then map the columns.</div></div></div>`;
    const c = pfCalc(), wide = isWide(), R = reviewCalc(c), scale = barScale(R), shown = sortRows(c.rows, R);
    const plp = c.costTot ? c.plTot / c.costTot * 100 : null;
    const kpis = `<div class="kpis pk">
      <div class="kpi"><div class="kl">Value</div><div class="kv1 big">${esc(bm(c.total, 0))}</div><div class="ks">${c.priced.length}/${n} priced · ${esc(P.base)}</div></div>
      <div class="kpi"><div class="kl">Unrealised P/L</div><div class="kv1 big ${c.plTot > 0 ? "pos" : c.plTot < 0 ? "neg" : ""}">${c.costTot ? esc(bmS(c.plTot, 0)) : "—"}</div><div class="ks">${plp != null ? pct(plp) + " on cost" : "Add cost to see P/L"}</div></div>
      <div class="kpi"><div class="kl">Day move</div><div class="kv1 big ${c.day > 0 ? "pos" : c.day < 0 ? "neg" : ""}">${esc(bmS(c.day, 0))}</div><div class="ks">Dashboard-priced lines</div></div>
      <div class="kpi"><div class="kl">On the dashboard</div><div class="kv1 big">${c.held.size}<span class="tk"> of ${D.ideas.length} ideas</span></div><div class="ks">${c.flags.filter((f) => f.tone === "danger" || f.tone === "warning").length} flags to review</div></div></div>`;
    const flags = c.flags.length ? `<h3>Decision flags</h3><div class="card list flags">${c.flags.map((f) => `<${f.k ? `button data-open="${esc(f.k)}"` : "div"} class="item fl f-${f.tone}"><span class="fdot" aria-hidden="true"></span><div class="body"><div class="ttl">${esc(f.t)}</div>${f.d ? `<div class="det">${esc(f.d)}</div>` : ""}</div>${f.k ? `<span class="chev">›</span>` : ""}</${f.k ? "button" : "div"}>`).join("")}</div>` : "";
    const good = c.good.length ? `<h3>Held and rated well</h3><div class="card list">${c.good.map((r) => `<button class="item" data-open="${esc(keyOf(r.mt.i))}"><div class="body"><div class="ttl">You hold <b>${esc(r.mt.i.name)}</b>${r.w != null ? ` (${r.w.toFixed(1)}%)` : ""}, rated ${esc(r.mt.i.action)} ${fmt(score10(r.mt.i))}</div><div class="det">${esc(r.mt.i.trigger)}</div></div><span class="chev">›</span></button>`).join("")}</div>` : "";
    const base = `<div class="chips basec">${["GBP", "USD", "EUR"].map((b) => `<button data-act="base" data-val="${b}" class="${P.base === b ? "on" : ""}">${b}</button>`).join("")}</div>`;
    return `<div class="phead"><div><h2>Portfolio</h2><div class="tk">🔒 This device only · prices as of ${esc(D.asOf.replace(/^[A-Z][a-z]{2} /, ""))}</div></div>${base}</div>${tools}${kpis}${reviewSummary(c, R)}
      <h3 id="holdings">Holdings <span class="tk">(${shown.length === n ? n : shown.length + " of " + n})</span></h3>${holdingsToolbar()}<div class="card hlist">${shown.length ? shown.map((r) => holdingRow(r, R, scale)).join("") : `<div class="muted small pad">No holdings with this decision.</div>`}</div>
      <div class="tk pnote">Bars: <span class="lgk cur"></span> current weight, <span class="lgk band"></span> target range, <span class="lgk tgt"></span> target after the change, on one scale. <button class="lnk" data-act="sizingRules">How sizing works</button></div>${flags}
      <div class="tk pnote">Values use dashboard prices where a holding matches an idea, otherwise a manual price or the value in your broker file (dated). Holdings without either are marked <span class="nopx">No price</span> and left out of totals. FX: ECB reference rates.</div>
      ${good}${wide ? "" : portfolioSide(c)}
      <div class="note mt12"><b>Research, not regulated financial advice.</b> Flags compare your holdings with the dashboard's ratings as of ${esc(D.asOf)}.</div>`;
  }

  // ---------- actions wired from the main click handler ----------
  const EXTRA_ACTS = {
    importCsv: () => pickCsv(),
    importChoose: () => openSheet("importChoose"),
    importShots: () => { dropShots(); openSheet("shots"); },
    addHolding: () => openSheet("edit", { h: { sym: "", name: "", qty: null, ccy: "GBP" } }),
    backup: () => openSheet("backup"),
    restoreFile: async () => { const f = await filePick(".json,application/json,text/plain"); if (!f) return; restoreText = await readFile(f); openSheet("backup"); await tryRestore(null); },
    base: async (b) => { P.base = b.dataset.val; await savePortfolio(); render(); },
    discardStale: async () => { if (!confirm("Discard the data saved under your previous passcode?")) return; for (const n of Object.keys(VS.stale)) await vdel(n); await openVault(); },
    ask: (b) => { const i = D.ideas.find((x) => keyOf(x) === b.dataset.k); if (!i) return; AU.focus = keyOf(i);
      AU.draft = `Decision brief on ${i.name} (${i.ticker}): is the ${i.action} rating (${fmt(score10(i))}) still right, what would change it, and how should it fit my portfolio?`; goTab("Analyst"); setTimeout(() => { const t = $("#chatIn"); if (t && !matchMedia("(pointer: coarse)").matches) t.focus(); }, 50); },
    ...{}, // analyst actions are merged below
  };

  // =====================================================================================
  // Analyst (AI chat). Provider-pluggable; calls go straight from this device to the chosen
  // provider with the user's own key. CSP connect-src allows only these three hosts.
  // =====================================================================================
  const PROVIDERS = {
    anthropic: { label: "Anthropic", long: "Anthropic (Claude)", url: "https://api.anthropic.com/v1/messages", keyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-…",
      models: [["claude-sonnet-5-5", "Claude Sonnet 5.5 (fast, recommended)"], ["claude-opus-5-5", "Claude Opus 5.5 (deeper)"], ["claude-haiku-5-5", "Claude Haiku 5.5 (cheapest)"]] },
    openai: { label: "OpenAI", long: "OpenAI (GPT)", url: "https://api.openai.com/v1/chat/completions", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-…",
      models: [["gpt-6.1-sol", "GPT-6.1 Sol (recommended)"], ["gpt-6-astra", "GPT-6 Astra (deeper)"], ["gpt-6-luna", "GPT-6 Luna (cheapest)"]] },
    xai: { label: "xAI", long: "xAI (Grok)", url: "https://api.x.ai/v1/responses", keyUrl: "https://console.x.ai/", keyHint: "xai-…",
      models: [["grok-4.7", "Grok 4.7 (recommended)"], ["grok-4.6", "Grok 4.6"]] },
  };
  function suggestions0() {
    const ai = ranked.filter((i) => i.theme === "AI supply chain").slice(0, 2), def = THEMES[0].toLowerCase();
    const cmp = ai.length === 2 ? [`Compare ${ai[0].name} vs ${ai[1].name}`, `Compare ${ai[0].name} vs ${ai[1].name} on fundamentals, valuation, catalysts and risk. Which is the better buy now and at what entry trigger?`]
      : ["Compare my two largest holdings", "Compare my two largest holdings on fundamentals, valuation, catalysts and risk."];
    return [
      ["What should I trim?", "Based on my holdings and the dashboard ratings, what should I trim or exit, in what order, and why?"],
      [`Stress-test my ${def} exposure`, `Stress-test my ${def} exposure: what happens to my portfolio in a ceasefire, a European budget cut, or a US procurement delay? Which holdings are most exposed?`],
      cmp,
      ["What matters this week?", "Which catalysts in the next 7 days matter most for my holdings and the top ideas, and what would I do before and after each?"],
      ["Where am I concentrated?", "Where am I over-concentrated by name, theme and currency, and what would a cleaner allocation look like using the dashboard's ideas?"],
      ["Best second-order plays", "Which second-order plays (suppliers, partners, customers of the leaders) look best right now, and why?"],
    ];
  }
  // one key and model per provider, so switching provider keeps each saved key
  const curCfg = () => { const c = A.cfg, pv = PROVIDERS[c.provider] ? c.provider : "anthropic"; return { provider: pv, model: (c.models && c.models[pv]) || PROVIDERS[pv].models[0][0], key: (c.keys && c.keys[pv]) || "" }; };
  const aiReady = () => !!(A && A.cfg && curCfg().key);
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  function chgOver(m, days) {
    if (!m || !m.price || !m.price.pts || m.price.pts.length < 2) return null; const pts = m.price.pts, last = pts[pts.length - 1];
    const from = new Date(last[0]); from.setDate(from.getDate() - days); const p0 = pts.find((p) => new Date(p[0]) >= from); return p0 ? r1((last[1] / p0[1] - 1) * 100) : null;
  }
  function ideaCtx(i, full) {
    const m = mkt(i) || {}, o = { name: i.name, ticker: i.ticker, listing: i.listing, theme: i.theme, role: i.role, action: i.action, score: +fmt(score10(i)),
      factors: Object.fromEntries(FACTORS.map((f) => [f.short, i.s[f.key]])), trigger: i.trigger, nextCatalyst: `${i.catalystDate}: ${i.catalyst}`, risk: i.risk, thesis: i.thesis };
    if (i.link) o.linkToLeader = i.link;
    if (m.price) o.price = { last: m.price.last, ccy: m.price.currency, asOf: m.price.asOf, chg1dPct: m.price.change1d, chg1mPct: chgOver(m, 31), chg3mPct: chgOver(m, 92), chg1yPct: chgOver(m, 366) };
    if (full) {
      if (m.stats) o.keyStats = Object.fromEntries(Object.entries(m.stats).filter(([k]) => !/url|source/.test(k)));
      if (m.financials) { const f = m.financials; o.annualUSDm = { periods: f.periods, revenue: f.revenue, grossProfit: f.grossProfit, operatingIncome: f.operatingIncome, netIncome: f.netIncome, fcf: f.fcf, cash: f.cash, debt: f.debt }; }
      if (m.crypto) { const c = m.crypto; o.crypto = { marketCapUSD: c.marketCap, rank: c.rank, circulating: c.circulating, max: c.max, ath: c.ath, athDate: c.athDate, vol24hUSD: c.volume24h }; }
      if (i.uk) o.buyingFromUK = i.uk;
    }
    return o;
  }
  function portCtx() {
    if (!P || !P.holdings.length) return { note: "No holdings saved on this device yet." };
    const c = pfCalc(), r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
    return { baseCurrency: P.base, totalValue: r2(c.total), unrealisedPL: c.costTot ? r2(c.plTot) : null, costBasis: c.costTot ? r2(c.costTot) : null,
      holdings: c.rows.map((r) => ({ symbol: r.h.sym, name: r.h.name, account: r.h.src, qty: r.h.qty, value: r2(r.v), weightPct: r1(r.w), plPct: r.pl != null && r.cost ? r1(r.pl / r.cost * 100) : null,
        priceSource: SRC_LABEL[r.src], dashboardIdea: r.mt ? `${r.mt.i.name} (${r.mt.i.action} ${fmt(score10(r.mt.i))})` : "not on dashboard" })),
      exposureByThemePct: Object.fromEntries(c.byTheme.map((x) => [x.k, r1(x.w)])), exposureByActionPct: Object.fromEntries(c.byAction.map((x) => [x.k, r1(x.w)])),
      exposureByCurrencyPct: Object.fromEntries(c.byCcy.map((x) => [x.k, r1(x.w)])), flags: c.flags.map((f) => f.t), unpriced: c.rows.filter((r) => r.v == null).map((r) => r.h.sym || r.h.name) };
  }
  function systemPrompt() {
    const focus = AU.focus ? D.ideas.find((i) => keyOf(i) === AU.focus) : null;
    let s = `You are "Analyst", the AI research assistant inside Invest Intel, a private investing dashboard used by a UK-based, finance-qualified individual investor.
The investor is risk-tolerant and wants "intelligent buys, not specific buys": clear, decisive views graded on evidence, timed around catalysts. Themes they follow: defence/intelligence spending driven by war, the AI supply chain (chips, memory, power, minerals), and crypto (legislation and institutional adoption). They like second-order plays: suppliers, partners or customers of high-growth leaders that may themselves be near peak.

How to answer:
- Lead with the answer (a clear view and action: Buy / Accumulate on dips / Watch / Trim / Avoid), then the reasons, then risks and what would change your mind, then concrete triggers (price levels, dates, events).
- Use the dashboard data below as your primary facts. It is dated; say so when timing matters. Never invent prices, figures or events; if something isn't in the data or your knowledge, say what's missing and how to check it.
- Score-based reasoning should reference the dashboard's factor scores (1-10; Risk: higher = lower risk) and its overall score.
- When the portfolio is included, tie advice to position sizes, weights, concentration and P/L, and think about UK practicalities (GBP, ISA/SIPP wrappers, stamp duty on UK shares, FX).
- Be concise. Use short markdown headings, bullet points and compact tables for comparisons. No long preambles.
- End with one short line noting this is analysis, not regulated financial advice.`;
    if (AU.ctxDash) {
      const ctx = { asOf: D.asOf, scoring: { weightsPct: Object.fromEntries(FACTORS.map((f) => [f.short, W[f.key]])), factorMeanings: Object.fromEntries(FACTORS.map((f) => [f.short, f.what])) },
        themeStances: D.themeStances, ideas: ranked.map((i) => ideaCtx(i, focus && keyOf(i) === keyOf(focus))),
        whatChanged: D.changes, catalysts: D.catalysts.map((c) => ({ date: c.date, event: c.event, type: c.type, why: c.why })),
        cryptoRegulation: D.cryptoRegs, marketBackdrop: D.marketBackdrop, notes: D.notes,
        newsHeadlines: Object.fromEntries(THEMES.map((t) => [t, (D.news[t] || []).map((n) => `${n.date || ""} ${n.title} (${n.site})`.trim())])) };
      if (D.market && D.market.fx) ctx.fxPerGBP = { date: D.market.fx.date, ...D.market.fx.rates };
      s += `\n\n<dashboard_data>\n${JSON.stringify(ctx)}\n</dashboard_data>`;
    } else s += `\n\n(The investor has switched off sharing dashboard data for this message.)`;
    if (AU.ctxPort) s += `\n\n<portfolio>\n${JSON.stringify(portCtx())}\n</portfolio>`;
    else s += `\n\n(The investor has not shared their portfolio for this message.)`;
    if (focus) s += `\n\nThe investor opened this chat from the ${focus.name} (${focus.ticker}) page: treat it as the focus unless they ask about something else. Full fundamentals for it are included above.`;
    s += `\n\nToday is ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.`;
    return s;
  }
  async function* streamChat(cfg, sys, msgs, signal, maxTokens) {
    const pv = PROVIDERS[cfg.provider]; let headers, body;
    if (cfg.provider === "anthropic") {
      headers = { "content-type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
      body = { model: cfg.model, max_tokens: maxTokens || 4096, system: sys, messages: msgs, stream: true };
    } else if (cfg.provider === "xai") {
      // xAI's current Grok models are served on the Responses API
      headers = { "content-type": "application/json", authorization: "Bearer " + cfg.key };
      body = { model: cfg.model, stream: true, store: false, input: [{ role: "system", content: sys }, ...msgs] };
      if (maxTokens) body.max_output_tokens = maxTokens;
    } else {
      headers = { "content-type": "application/json", authorization: "Bearer " + cfg.key };
      body = { model: cfg.model, stream: true, messages: [{ role: "system", content: sys }, ...msgs] };
      if (maxTokens) body.max_completion_tokens = maxTokens;
    }
    const r = await fetch(pv.url, { method: "POST", headers, body: JSON.stringify(body), signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    if (!r.ok) { let m = ""; try { const j = await r.json(); m = (j.error && (j.error.message || (typeof j.error === "string" ? j.error : ""))) || j.message || ""; } catch {} const e = new Error(m || "HTTP " + r.status); e.status = r.status; throw e; }
    if (!r.body || !r.body.getReader) { const t = await r.text(); yield* parseSSE(cfg, t); return; }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let n; while ((n = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); const t = sseText(cfg, line); if (t) yield t; }
    }
    if (buf) { const t = sseText(cfg, buf); if (t) yield t; }
  }
  function* parseSSE(cfg, text) { for (const line of text.split("\n")) { const t = sseText(cfg, line); if (t) yield t; } }
  function sseText(cfg, line) {
    line = line.trim(); if (!line.startsWith("data:")) return ""; const d = line.slice(5).trim(); if (!d || d === "[DONE]") return "";
    let j; try { j = JSON.parse(d); } catch { return ""; }
    if (j.type === "error" || (j.error && !j.choices)) throw new Error((j.error && j.error.message) || "The provider returned an error");
    if (cfg.provider === "anthropic") return j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta" ? j.delta.text : "";
    if (cfg.provider === "xai") { if (j.type === "response.failed" || j.type === "response.error") throw new Error((j.response && j.response.error && j.response.error.message) || "The provider returned an error"); return j.type === "response.output_text.delta" && typeof j.delta === "string" ? j.delta : ""; }
    return (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || "";
  }
  function errText(e, cfg) {
    const L = PROVIDERS[cfg.provider].label;
    if (e.status === 401 || e.status === 403) return `${L} rejected the API key. Check it under Settings → AI analyst.`;
    if (e.status === 429) return `${L} says you're rate-limited or out of credit. Wait a moment or check billing.`;
    if (e.status === 404 || (e.status === 400 && /model/i.test(e.message))) return `${L} doesn't recognise the model “${cfg.model}”. Pick another in Settings → AI analyst. (${e.message})`;
    if (e.status) return `${L} returned an error (${e.status}): ${e.message}`;
    if (e instanceof TypeError) return `Couldn't reach ${L}. Check your connection. If it keeps failing, ${L} may not allow direct requests from a browser; try another provider.`;
    return e.message || "Something went wrong.";
  }
  let paintQ = false;
  function paintLast(m) {
    if (paintQ) return; paintQ = true;
    requestAnimationFrame(() => { paintQ = false; const b = document.querySelector(".msg.streaming .bubble"); if (!b) return; const near = chatNearBottom(); b.innerHTML = md(m.content) + `<span class="caret"></span>`; if (near) scrollChat(); });
  }
  const chatBox = () => $("#msgs");
  function chatNearBottom() { const c = chatBox(); return !c || c.scrollHeight - c.scrollTop - c.clientHeight < 120; }
  function scrollChat(force) { requestAnimationFrame(() => { const c = chatBox(); if (c && (force || true)) c.scrollTop = c.scrollHeight; }); }
  async function sendChat(text) {
    text = String(text || "").trim(); if (!text || AU.busy || !aiReady()) return;
    const cfg = curCfg(), focus = AU.focus ? D.ideas.find((i) => keyOf(i) === AU.focus) : null;
    A.msgs.push({ role: "user", content: text, ts: Date.now(), focus: focus ? focus.name : null, ctx: [AU.ctxDash && "dashboard", AU.ctxPort && "portfolio"].filter(Boolean) });
    const reply = { role: "assistant", content: "", ts: Date.now(), provider: cfg.provider, model: cfg.model };
    // history: previous turns that completed, merged so roles alternate
    const hist = [];
    for (const m of A.msgs) { if (m.error || (!m.content && m.role === "assistant")) continue; const last = hist[hist.length - 1]; if (last && last.role === m.role) last.content += "\n\n" + m.content; else hist.push({ role: m.role, content: m.content }); }
    while (hist.length && hist[0].role !== "user") hist.shift();
    const sys = systemPrompt(); A.msgs.push(reply); AU.draft = ""; AU.busy = true; AU.ctl = new AbortController(); render(); scrollChat(true);
    try {
      for await (const t of streamChat(cfg, sys, hist.slice(-24), AU.ctl.signal)) { reply.content += t; paintLast(reply); }
      if (!reply.content) reply.content = "_No text came back. Try again or pick another model._";
    } catch (e) { if (e.name === "AbortError") reply.stopped = true; else reply.error = errText(e, cfg); }
    AU.busy = false; AU.ctl = null;
    try { if (A) await saveChat(); } catch {}
    if (A && st.view === "Analyst") { render(); scrollChat(true); }
  }
  // ---------- tiny, safe markdown (escape first, then format) ----------
  function inl(s) {
    const codes = []; let t = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    t = t.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+?)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[+n]}</code>`);
  }
  function md(src) {
    const L = String(src || "").replace(/\r/g, "").split("\n"); let out = "", i = 0;
    const isBlock = (l) => /^```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*>/.test(l) || /^\s*\|/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    while (i < L.length) {
      const l = L[i]; let m;
      if (/^```/.test(l)) { const b = []; i++; while (i < L.length && !/^```/.test(L[i])) b.push(L[i++]); i++; out += `<pre><code>${esc(b.join("\n"))}</code></pre>`; continue; }
      if (!l.trim()) { i++; continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { const lv = Math.min(6, m[1].length + 2); out += `<h${lv}>${inl(m[2].replace(/#+\s*$/, ""))}</h${lv}>`; i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out += "<hr>"; i++; continue; }
      if (/^\s*\|/.test(l) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
        const head = cells(l), al = cells(L[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : "")); i += 2; const rows = [];
        while (i < L.length && /^\s*\|/.test(L[i])) rows.push(cells(L[i++]));
        const td = (c, n, tag) => `<${tag}${al[n] ? ` class="al-${al[n]}"` : ""}>${inl(c)}</${tag}>`;
        out += `<div class="mdt"><table><thead><tr>${head.map((c, n) => td(c, n, "th")).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, n) => td(r[n] || "", n, "td")).join("")}</tr>`).join("")}</tbody></table></div>`; continue;
      }
      if (/^\s*>/.test(l)) { const b = []; while (i < L.length && /^\s*>/.test(L[i])) b.push(L[i++].replace(/^\s*>\s?/, "")); out += `<blockquote>${md(b.join("\n"))}</blockquote>`; continue; }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(l))) {
        const ol = /\d/.test(m[2]), items = [];
        while (i < L.length && (m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(L[i]))) { const lvl = m[1].length >= 2 ? 1 : 0; items.push([lvl, m[3]]); i++;
          while (i < L.length && L[i].trim() && !isBlock(L[i]) && /^\s{2,}/.test(L[i])) items[items.length - 1][1] += " " + L[i++].trim(); }
        out += `<${ol ? "ol" : "ul"}>${items.map(([lv, t]) => `<li${lv ? ' class="sub"' : ""}>${inl(t)}</li>`).join("")}</${ol ? "ol" : "ul"}>`; continue;
      }
      const p = []; while (i < L.length && L[i].trim() && !isBlock(L[i])) p.push(L[i++]);
      if (!p.length) { out += `<p>${inl(L[i++])}</p>`; continue; }
      out += `<p>${p.map(inl).join("<br>")}</p>`;
    }
    return out;
  }
  // ---------- AI settings form (setup card + Settings section) ----------
  function aiForm(where) {
    const c = curCfg(), pv = PROVIDERS[c.provider], known = pv.models.some(([id]) => id === c.model);
    const masked = c.key ? "••••••••" + c.key.slice(-4) : "";
    return `<form class="aiform" data-form="ai" data-where="${where}" autocomplete="off">
      <div class="slbl">Provider</div><div class="seg3" role="radiogroup" aria-label="Provider">${Object.entries(PROVIDERS).map(([id, p]) => `<button type="button" role="radio" aria-checked="${c.provider === id}" data-ai-prov="${id}" class="${c.provider === id ? "on" : ""}">${esc(p.label)}</button>`).join("")}</div>
      <label class="fld"><span>Model</span><select name="model">${pv.models.map(([id, l]) => `<option value="${esc(id)}"${c.model === id ? " selected" : ""}>${esc(l)}</option>`).join("")}<option value="__custom"${known ? "" : " selected"}>Other model ID…</option></select></label>
      <label class="fld${known && !AU.showCustom ? " hide" : ""}" data-custom><span>Model ID</span><input name="custom" value="${known ? "" : esc(c.model)}" placeholder="e.g. ${esc(pv.models[0][0])}" spellcheck="false" autocapitalize="off"></label>
      <label class="fld"><span>API key${c.key ? ` <span class="tk">saved ${esc(masked)}</span>` : ""}</span><input name="key" type="password" placeholder="${c.key ? "Leave blank to keep the saved key" : "Paste your " + esc(pv.label) + " key (" + esc(pv.keyHint) + ")"}" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
      <div class="tk">No key? <a href="${esc(pv.keyUrl)}" target="_blank" rel="noopener noreferrer">Create one at ${esc(pv.label)} ↗</a> · usage is billed to your own API account.</div>
      <div class="srow mt12"><button class="btn primary" type="submit">${where === "setup" ? "Save and start" : "Save"}</button>${c.key ? `<button class="btn" type="button" data-act="aiTest">Test</button><button class="btn dangerT" type="button" data-act="aiRemove">Remove key</button>` : ""}<span class="tk" data-ai-msg></span></div>
      <div class="privnote">🔒 The key is encrypted with your passcode and kept on this device only. It is sent only to ${esc(pv.long)}, never to GitHub or anyone else.</div></form>`;
  }
  function setupCard() {
    return `<div class="setup"><div class="card setupc"><div class="sgl" aria-hidden="true">✦</div><h2>Set up your AI analyst</h2>
      <p class="muted">Ask about any idea, stress-test your holdings, compare names or plan around catalysts. Choose a provider and paste your own API key.</p>
      <ul class="setupl"><li>Sees the dashboard's ideas, scores, catalysts, news and crypto regulation</li><li>Optionally sees your on-device portfolio</li><li>Streams answers with tables and clear actions</li></ul>
      ${aiForm("setup")}</div>
      <div class="disc">AI analysis, not financial advice. Only the context you switch on is sent to the provider you choose.</div></div>`;
  }
  function msgHtml(m, n, last) {
    if (m.role === "user") return `<div class="msg u"><div class="bubble">${esc(m.content).replace(/\n/g, "<br>")}</div>${m.focus ? `<div class="mmeta">Focus: ${esc(m.focus)}</div>` : ""}</div>`;
    const streaming = last && AU.busy;
    const meta = `${esc(PROVIDERS[m.provider] ? PROVIDERS[m.provider].label : "")} · ${esc(m.model || "")}${m.stopped ? " · stopped" : ""}`;
    return `<div class="msg a${streaming ? " streaming" : ""}"><div class="av" aria-hidden="true">✦</div><div class="mcol">
      <div class="bubble md">${m.content ? md(m.content) : streaming ? `<span class="typing"><i></i><i></i><i></i></span>` : ""}${streaming && m.content ? `<span class="caret"></span>` : ""}</div>
      ${m.error ? `<div class="merr" role="alert">${esc(m.error)} <button class="lnk" data-act="retry">Retry</button></div>` : ""}
      ${streaming ? "" : `<div class="mmeta">${meta}${m.content ? ` · <button class="lnk" data-act="copy" data-n="${n}">Copy</button>` : ""}</div>`}</div></div>`;
  }
  function analystView() {
    const gate = vaultGate();
    if (gate) return `<div class="chatwrap"><div class="chathead"><div><h2>Analyst</h2></div></div>${gate}</div>`;
    if (!aiReady()) return `<div class="chatwrap setupwrap">${setupCard()}</div>`;
    const cc = curCfg(), pv = PROVIDERS[cc.provider], focus = AU.focus ? D.ideas.find((i) => keyOf(i) === AU.focus) : null;
    const nh = P ? P.holdings.length : 0, empty = !A.msgs.length;
    const SUG = suggestions0(); const sugg = `<div class="sugs">${SUG.map(([t, q], n) => `<button class="sug" data-sug="${n}"><span>${esc(t)}</span><span class="chev">›</span></button>`).join("")}</div>`;
    const hero = `<div class="hero"><div class="sgl" aria-hidden="true">✦</div><h2>Ask your analyst</h2><p class="muted">Grounded in today's dashboard${nh ? " and your " + nh + " holdings" : ""}. Try one of these:</p>${sugg}</div>`;
    const ctxChips = `<div class="ctxr"><button class="cchip${AU.ctxDash ? " on" : ""}" data-act="ctxDash" aria-pressed="${AU.ctxDash}"><span class="cdot"></span>Dashboard data</button>
      <button class="cchip${AU.ctxPort ? " on" : ""}" data-act="ctxPort" aria-pressed="${AU.ctxPort}"><span class="cdot"></span>Portfolio${nh ? ` (${nh})` : " (empty)"}</button>
      ${focus ? `<span class="cchip on focus"><span class="cdot"></span>Focus: ${esc(focus.ticker)}<button class="x" data-act="clearFocus" aria-label="Remove focus">✕</button></span>` : ""}
      <button class="lnk ctxv" data-act="showCtx">What's sent?</button></div>`;
    const side = `<aside class="chatside"><h3>Context</h3><div class="card small"><dl class="kv">
      <dt>Provider</dt><dd>${esc(pv.long)}</dd><dt>Model</dt><dd>${esc(cc.model)}</dd><dt>Dashboard</dt><dd>${AU.ctxDash ? `${D.ideas.length} ideas, ${D.catalysts.length} catalysts, news, crypto regs (as of ${esc(D.asOf)})` : "Off"}</dd>
      <dt>Portfolio</dt><dd>${AU.ctxPort ? (nh ? nh + " holdings, values and weights" : "No holdings yet") : "Off"}</dd>${focus ? `<dt>Focus</dt><dd>${esc(focus.name)}</dd>` : ""}</dl>
      <div class="srow mt6"><button class="btn sm" data-act="showCtx">Preview what's sent</button><button class="btn sm" data-goto="Settings">AI settings</button></div></div>
      <h3>Suggested</h3>${sugg}
      <div class="disc">AI analysis, not financial advice. Only the context switched on is sent to ${esc(pv.label)}.</div></aside>`;
    return `<div class="chatwrap"><div class="chatmain">
      <div class="chathead"><div><h2>Analyst</h2><div class="tk">${esc(pv.label)} · ${esc(cc.model)}</div></div>
        <div class="srow">${A.msgs.length ? `<button class="btn sm" data-act="clearChat"${AU.busy ? " disabled" : ""}>Clear</button>` : ""}<button class="iconBtn" data-goto="Settings" aria-label="AI settings">⚙</button></div></div>
      <div class="msgs" id="msgs" aria-live="polite">${empty ? hero : A.msgs.map((m, n) => msgHtml(m, n, n === A.msgs.length - 1)).join("")}</div>
      <form class="composer" data-form="chat">${ctxChips}
        <div class="cbox"><textarea id="chatIn" rows="1" placeholder="Ask about an idea, your holdings, a catalyst…" aria-label="Message the analyst" enterkeyhint="send">${esc(AU.draft)}</textarea>
          ${AU.busy ? `<button class="sendb stop" type="button" data-act="stop" aria-label="Stop">■</button>` : `<button class="sendb" type="submit" aria-label="Send"${AU.draft.trim() ? "" : " disabled"}>↑</button>`}</div>
        <div class="disc">AI analysis, not financial advice · only switched-on context is sent to ${esc(pv.label)}</div></form>
      </div>${side}</div>`;
  }
  function sizeChat() {
    const w = document.querySelector(".chatwrap"); if (!w || st.view !== "Analyst") return;
    const vh = window.visualViewport ? visualViewport.height : innerHeight;
    const tabs = $("#tabs"), tabsFixed = tabs && getComputedStyle(tabs).position === "fixed" && !document.body.classList.contains("kb");
    const reserve = tabsFixed ? tabs.getBoundingClientRect().height : 0;
    const top = w.getBoundingClientRect().top + (window.visualViewport ? visualViewport.offsetTop * 0 : 0);
    const bottomPad = isWide() ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sab")) || 0 : 0;
    w.style.height = Math.max(320, vh - Math.max(0, top) - reserve - bottomPad - (isWide() ? 12 : 6)) + "px";
  }
  function afterChatRender() {
    sizeChat(); const t = $("#chatIn"); if (t) { autoGrow(t); } scrollChat(true);
  }
  const autoGrow = (t) => { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; };
  function onInput(e) {
    if (e.target.id === "chatIn") { AU.draft = e.target.value; autoGrow(e.target); const b = $(".sendb:not(.stop)"); if (b) b.disabled = !AU.draft.trim(); }
  }
  function onViewKey(e) {
    if (e.target.id === "chatIn" && e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); sendChat(AU.draft); }
  }
  async function onSubmit(e) {
    const f = e.target.closest("form"); if (!f) return; e.preventDefault(); const k = f.dataset.form, errEl = f.querySelector("[data-err]");
    try {
      if (k === "chat") { sendChat(AU.draft); return; }
      if (k === "vaultpass") {
        const key = await deriveKey(f.pass.value, payload); try { await decrypt(key, payload); } catch { throw new Error("Wrong passcode"); }
        currentKey = key; if (S.remember) await saveKey(key, payload.salt).catch(() => {}); await openVault(); return;
      }
      if (k === "stalepass") {
        for (const [n, rec] of Object.entries(VS.stale)) { const old = await keyFrom(f.pass.value, rec.salt, rec.iterations || payload.iterations); let o; try { o = await openWith(old, rec); } catch { throw new Error("That isn't the previous passcode."); } delete VS.stale[n]; await vaultSave(n, o); }
        await openVault(); toast("Saved data restored"); return;
      }
      if (k === "revcap") {
        const v = parseFloat(f.cap.value); if (!(v >= 2 && v <= 40)) throw new Error("Enter a cap between 2% and 40%.");
        P.review = { ...(P.review || {}), customCap: half(v) }; await savePortfolio(); render(); toast(`Top cap set to ${pct1(half(v))}`); return;
      }
      if (k === "ai") {
        const pvId = curCfg().provider, model = f.model.value === "__custom" ? f.custom.value.trim() : f.model.value, key = f.key.value.trim();
        if (!model) throw new Error("Enter a model ID.");
        if (!key && !curCfg().key) throw new Error("Paste an API key.");
        if (key && (key.length < 12 || /\s/.test(key))) throw new Error("That doesn't look like an API key.");
        A.cfg.models = { ...(A.cfg.models || {}), [pvId]: model }; if (key) A.cfg.keys = { ...(A.cfg.keys || {}), [pvId]: key };
        AU.showCustom = false; await saveAI(); f.key.value = "";
        render(); toast(f.dataset.where === "setup" ? "Analyst ready" : "AI settings saved");
      }
    } catch (err) { if (errEl) errEl.textContent = err.message; else { const m = f.querySelector("[data-ai-msg]"); if (m) { m.textContent = err.message; m.className = "err"; } else toast(err.message, "bad"); } }
  }
  Object.assign(EXTRA_ACTS, {
    ctxDash: () => { AU.ctxDash = !AU.ctxDash; render(); },
    ctxPort: () => { AU.ctxPort = !AU.ctxPort; render(); },
    clearFocus: () => { AU.focus = null; render(); },
    showCtx: () => openSheet("context", systemPrompt()),
    stop: () => { if (AU.ctl) AU.ctl.abort(); },
    retry: () => { const lastU = [...A.msgs].reverse().find((m) => m.role === "user"); if (!lastU) return; A.msgs = A.msgs.slice(0, A.msgs.lastIndexOf(lastU)); sendChat(lastU.content); },
    copy: async (b) => { const m = A.msgs[+b.dataset.n]; try { await navigator.clipboard.writeText(m.content); toast("Copied"); } catch { toast("Couldn't copy", "bad"); } },
    clearChat: async () => { if (!confirm("Clear the analyst chat history on this device?")) return; A.msgs = []; AU.focus = null; await saveChat(); render(); },
    aiTest: async (b) => {
      const msg = b.parentElement.querySelector("[data-ai-msg]"); msg.className = "tk"; msg.textContent = "Testing…"; b.disabled = true;
      try { let t = ""; const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
        for await (const x of streamChat(curCfg(), "Reply with the single word OK.", [{ role: "user", content: "Connection test" }], ctl.signal, 64)) t += x; clearTimeout(to);
        msg.className = "ok"; msg.textContent = "Connected ✓"; }
      catch (e) { msg.className = "err"; msg.textContent = e.name === "AbortError" ? "Timed out" : errText(e, curCfg()); } finally { b.disabled = false; }
    },
    aiRemove: async () => { if (!confirm("Remove the saved API key from this device?")) return; delete A.cfg.keys[curCfg().provider]; await saveAI(); render(); toast("Key removed"); },
    wipeLocal: async () => { if (!confirm("Delete your holdings, chat history, AI review and AI key from this device? This can't be undone (export a backup first).")) return; for (const n of ["portfolio", "ai", "chat", "review"]) await vdel(n); REV = null; AU.focus = null; await openVault(); toast("On-device data deleted"); },
  });
  // =====================================================================================
  // Holdings review: a transparent, on-device decision engine (no AI key needed) that turns the
  // dashboard's scores and ratings plus each position's size, P/L and concentration into one
  // decision per holding, with a target weight and the concrete change. Optional AI deep dive
  // sends the engine output to the user's own provider; the last AI review is cached encrypted.
  // =====================================================================================
  const DECS = ["Add", "Hold", "Trim", "Sell", "Review"];
  const DEC_TONE = { Add: "success", Hold: "neutral", Trim: "warning", Sell: "danger", Review: "accent" };
  const DEC_ORDER = { Sell: 0, Trim: 1, Add: 2, Review: 3, Hold: 4 };
  const PROFILES = {
    Cautious: { mult: 2 / 3, theme: 30, ccy: 50, gain: 30, blurb: "Smaller caps, earlier profit-taking" },
    Balanced: { mult: 1, theme: 35, ccy: 60, gain: 50, blurb: "The reference caps" },
    Aggressive: { mult: 1.25, theme: 35, ccy: 70, gain: 50, blurb: "Larger caps for high scorers" },
  };
  const BANDS = [[8, 12, "8+"], [7, 8, "7–8"], [6, 5, "6–7"]]; // [min score, Balanced cap %, label]; below 6 = exit
  const half = (x) => Math.round(x * 2) / 2;
  const revPrefs = () => { const r = (P && P.review) || {}; return { profile: PROFILES[r.profile] ? r.profile : "Aggressive", customCap: r.customCap > 0 ? +r.customCap : null }; };
  function capTable() {
    const pr = revPrefs(), p = PROFILES[pr.profile], top = pr.customCap || 12 * p.mult;
    return BANDS.map(([s, c, l]) => ({ min: s, label: l, cap: half(c / 12 * top) }));
  }
  const capFor = (s) => { const b = capTable().find((x) => s >= x.min); return b ? b.cap : 0; };
  const pct1 = (v) => (v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, "") + "%");
  function catDate(t) {
    const m = /(\d{1,2})(?:\s*[–-]\s*\d{1,2})?\s+([A-Z][a-z]{2})/.exec(t || ""); if (!m || MONTHS.indexOf(m[2]) < 0) return null;
    const b = asOfDate(); let d = new Date(b.getFullYear(), MONTHS.indexOf(m[2]), +m[1]); if (d - b < -180 * 864e5) d = new Date(b.getFullYear() + 1, MONTHS.indexOf(m[2]), +m[1]); return d;
  }
  // upcoming catalysts for a name (its own next catalyst plus calendar events naming it; crypto-wide events for crypto ideas)
  function upcoming(i, days = 21) {
    const b = asOfDate(), e = new Date(b); e.setDate(e.getDate() + days); const out = [];
    const d0 = catDate(i.catalystDate); if (d0 && d0 >= b && d0 <= e) out.push({ d: d0, label: i.catalystDate, t: i.catalyst });
    const keys = [i.name, ...i.ticker.split(/\s*\/\s*/)].map((x) => x.trim()).filter((x) => x.length >= 3);
    for (const c of D.catalysts) {
      const d = new Date(c.date + "T00:00:00"); if (d < b || d > e) continue;
      const txt = c.event + " " + c.why, named = keys.some((k) => new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(txt));
      if (named || (c.type === "Crypto" && i.theme === "Crypto")) if (!out.some((o) => o.t === c.event)) out.push({ d, label: c.label || dLabel(c.date), t: c.event });
    }
    return out.sort((a, b2) => a.d - b2.d);
  }
  const unitWord = (g) => (g.i && isCryptoIdea(g.i) ? "units" : "shares");
  function shareText(g, money) {
    if (!g.pxBase || !g.qty) return "";
    const n = Math.abs(money) / g.pxBase, intish = Math.abs(g.qty - Math.round(g.qty)) < 1e-6 && g.qty >= 1;
    if (intish) return n < 1 ? ` / under 1 ${unitWord(g).replace(/s$/, "")}` : ` / ${Math.round(n).toLocaleString("en-GB")} ${unitWord(g)}`;
    return ` / ${qtyFmt(+n.toPrecision(3))} ${unitWord(g)}`;
  }
  function reviewCalc(c) {
    c = c || pfCalc(); const pr = revPrefs(), prof = PROFILES[pr.profile], total = c.total;
    const themeW = Object.fromEntries(c.byTheme.map((x) => [x.k, x.w])), hotThemes = c.byTheme.filter((x) => x.k !== "Not on dashboard" && x.w > prof.theme && c.priced.length > 1);
    const hotCcy = c.byCcy.filter((x) => x.k !== P.base && x.k !== "?" && x.w > prof.ccy && c.priced.length > 1);
    const G = new Map();
    for (const r of c.rows) { const k = r.mt ? "i:" + keyOf(r.mt.i) : "h:" + r.h.id; if (!G.has(k)) G.set(k, { k, i: r.mt ? r.mt.i : null, rows: [] }); G.get(k).rows.push(r); }
    const out = [];
    for (const g of G.values()) {
      const pr0 = g.rows.filter((r) => r.v != null); g.v = pr0.length ? pr0.reduce((a, r) => a + r.v, 0) : null; g.partial = pr0.length > 0 && pr0.length < g.rows.length;
      g.w = g.v != null && total > 0 ? g.v / total * 100 : null;
      g.cost = g.rows.every((r) => r.cost != null) ? g.rows.reduce((a, r) => a + r.cost, 0) : null; g.pl = g.v != null && g.cost != null && !g.partial ? g.v - g.cost : null; g.plp = g.pl != null && g.cost ? g.pl / g.cost * 100 : null;
      g.qty = g.rows.every((r) => r.h.qty != null) ? g.rows.reduce((a, r) => a + r.h.qty, 0) : null; g.pxBase = g.v != null && g.qty && !g.partial ? g.v / g.qty : null;
      g.src = g.rows[0].src; g.dash = g.rows.every((r) => r.src === "dash");
      g.name = g.i ? g.i.name : g.rows[0].h.name || g.rows[0].h.sym || "Holding"; g.sym = g.i ? g.i.ticker.split(" / ")[0] : g.rows[0].h.sym || ""; g.ids = g.rows.map((r) => r.h.id);
      g.day = g.i && g.dash && mkt(g.i) && mkt(g.i).price ? mkt(g.i).price.change1d : null;
      g.notes = []; g.rules = [];
      decide(g, { prof, pr, themeW, hotThemes, hotCcy, total });
      out.push(g);
    }
    const acts = out.filter((g) => g.money);
    const big3 = [...acts].sort((a, b) => Math.abs(b.money) - Math.abs(a.money)).slice(0, 3);
    const counts = Object.fromEntries(DECS.map((d) => [d, out.filter((g) => g.dec === d).length]));
    const week = [...out].filter((g) => g.dec !== "Hold").sort((a, b) => DEC_ORDER[a.dec] - DEC_ORDER[b.dec] || Math.abs(b.money || 0) - Math.abs(a.money || 0));
    const byK = new Map(); for (const g of out) for (const id of g.ids) byK.set(id, g);
    return { groups: out, big3, counts, week, hotThemes, hotCcy, byId: byK, prof, pr, caps: capTable(), total };
  }
  function decide(g, X) {
    const i = g.i; g.to = null; g.lo = null; g.hi = null; g.money = 0; g.dw = null;
    if (!i) { g.dec = "Review"; g.reason = g.v == null ? "Not on the dashboard and no price: nothing to size against" : "Not on the dashboard: no score or rating to size against"; g.rules.push("Unrated holdings get Review"); g.conv = null; g.unrated = true; return; }
    const s = score10(i) / 10, cap = capFor(s), act = i.action; g.score = s; g.cap = cap; g.act = act;
    const cats = upcoming(i); g.cats = cats;
    if (g.v == null) { g.dec = "Review"; g.reason = `Rated ${act} ${s.toFixed(1)}, but no price or value: can't size it`; g.rules.push("Unpriced holdings get Review"); g.conv = null; g.unpriced = true; return; }
    const w = g.w, topR = (act === "Buy" || act === "Accumulate on dips") && s >= 7, lo = topR ? half(cap * 0.6) : 0, tw = X.themeW[i.theme] || 0;
    const hotT = X.hotThemes.some((t) => t.k === i.theme);
    let dec = "Hold", to = null, conv = "Medium";
    g.lo = lo; g.hi = cap;
    if (act === "Avoid") { dec = "Sell"; to = 0; conv = "High"; g.rules.push("Avoid-rated holdings get sold"); g.reason = `Rated Avoid (${s.toFixed(1)}/10) at ${pct1(w)} of the portfolio`; }
    else if (s < 6) { dec = "Sell"; to = 0; conv = s < 5 ? "High" : "Medium"; g.rules.push("Score below 6 aims to exit"); g.reason = `Score ${s.toFixed(1)}/10 is below 6, the level the sizing rules exit at`; }
    else if (act === "Trim") { dec = "Trim"; to = half(Math.min(cap, w / 2)); conv = w > cap ? "High" : "Medium"; g.rules.push(`Trim-rated holdings are halved, and never left above the ${pct1(cap)} cap`); g.reason = `Rated Trim (${s.toFixed(1)}/10) at ${pct1(w)}`; }
    else if (w > cap + Math.max(0.5, cap * 0.1)) { dec = "Trim"; to = cap; conv = w > cap * 1.5 ? "High" : "Medium"; g.rules.push(`A ${s.toFixed(1)} score caps the position at ${pct1(cap)}`); g.reason = `${pct1(w)} of the portfolio vs a ${pct1(cap)} cap for a ${s.toFixed(1)} score (${act})`; }
    else if (topR && w < lo) {
      if (hotT) { dec = "Hold"; conv = "Medium"; g.rules.push(`No adds while a theme is above ${X.prof.theme}%`); g.reason = `Rated ${act} ${s.toFixed(1)} and under target, but ${i.theme} is already ${pct1(tw)} of the portfolio`; }
      else { dec = "Add"; to = half(cap * 0.8); conv = s >= 8 && i.s.t >= 7 ? "High" : "Medium"; g.rules.push("Top scorers below 60% of their cap get added to"); g.reason = `Rated ${act} ${s.toFixed(1)}/10 at only ${pct1(w)} vs a ${pct1(lo)}–${pct1(cap)} range`; }
    } else { dec = "Hold"; conv = s >= 8 ? "High" : "Medium"; g.rules.push("Inside the range for its score"); g.reason = `Rated ${act} ${s.toFixed(1)}/10 at ${pct1(w)}, inside the ${pct1(lo)}–${pct1(cap)} range`; }
    // profit-taking on low scorers with big unrealised gains
    if (s < 7 && g.plp != null && g.plp >= X.prof.gain) {
      g.gainFlag = true;
      if (dec === "Hold") { dec = "Trim"; to = half(w * 0.75); g.rules.push(`Scores below 7 with gains of ${X.prof.gain}%+ take a quarter off`); g.reason = `${pct(g.plp, 0)} unrealised on a ${s.toFixed(1)} score (${act}): bank some of the gain`; }
      else g.notes.push(`Locks in part of a ${pct(g.plp, 0)} unrealised gain`);
    }
    if (dec === "Trim" && to != null && w - to < 0.25) { dec = "Hold"; to = null; g.rules.push("Changes under 0.25% of the portfolio are ignored"); }
    if (hotT) g.notes.push(`${i.theme} is ${pct1(tw)} of the portfolio (flag above ${X.prof.theme}%)`);
    const cc = g.rows[0].src === "dash" ? normCcy(g.rows[0].pxCcy) : normCcy(g.rows[0].h.valueCcy || g.rows[0].h.ccy), hc = X.hotCcy.find((x) => x.k === (cc === "GBp" ? "GBP" : cc));
    if (hc && dec === "Add") g.notes.push(`Adds to ${hc.k}, already ${pct1(hc.w)} of the portfolio`);
    if (act === "Accumulate on dips" && dec === "Add") g.notes.push(`Rated Accumulate on dips: stage it. Trigger: ${i.trigger}`);
    if (g.day != null && Math.abs(g.day) >= 5) g.notes.push(`${pct(g.day, 1)} on the day: ${dec === "Add" ? "consider staging the add" : dec === "Sell" || dec === "Trim" ? "consider staging the sale" : "watch the move"}`);
    if (cats.length) g.notes.push(`Next: ${cats[0].label}, ${cats[0].t}${cats.length > 1 ? ` (+${cats.length - 1} more within 3 weeks)` : ""}`);
    if (!g.dash || g.partial) { conv = conv === "High" ? "Medium" : "Low"; g.notes.push(g.partial ? "Some lines have no price and are left out of the weight" : `Sized on a ${SRC_LABEL[g.src].toLowerCase()}, not today's dashboard price`); }
    if (g.rows.length > 1) g.notes.push(`Combined across ${g.rows.length} lines`);
    g.dec = dec; g.to = to; g.conv = conv;
    if (to != null) {
      g.dw = to - w; g.money = g.dw / 100 * X.total;
      const m = Math.abs(g.money), amt = `about ${bm(m, 0)}${shareText(g, m)}`;
      g.change = dec === "Sell" ? `Sell all (${amt})` : dec === "Add" ? `Add ~${pct1(Math.abs(g.dw))} of portfolio (${amt}) to reach ${pct1(to)}` : `Trim ~${pct1(Math.abs(g.dw))} of portfolio (${amt}) to reach ${pct1(to)}`;
      if (dec === "Sell") { g.money = -g.v; g.dw = -w; }
      g.short = dec === "Sell" ? `Sell all · ${bm(m, 0)}` : `${dec} ~${pct1(Math.abs(g.dw))} · ${bm(m, 0)} → ${pct1(to)}`;
      if (dec === "Trim") g.lo = Math.min(g.lo, to), g.hi = to;
      if (dec === "Sell") { g.lo = 0; g.hi = 0; }
    } else g.change = dec === "Hold" ? "No change" : "";
  }
  const decPill = (d, extra) => `<span class="dec d-${d.toLowerCase()}${extra ? " " + extra : ""}">${esc(d)}</span>`;
  // current weight vs target range on one shared scale
  function targetBar(g, scale) {
    if (g.w == null) return `<span class="tbar empty"><span class="tnone">No weight</span></span>`;
    const L = (x) => Math.max(0, Math.min(100, x / scale * 100)).toFixed(1);
    const band = g.dec === "Review" ? "" : `<span class="tband b-${g.dec.toLowerCase()}" data-l="${L(g.lo || 0)}" data-w="${Math.max(0.8, L(g.hi) - L(g.lo || 0)).toFixed(1)}"></span>`;
    const tgt = g.to != null ? `<span class="ttgt" data-l="${L(g.to)}"></span>` : "";
    return `<span class="tbar" role="img" aria-label="Weight ${pct1(g.w)}${g.hi != null ? `, target ${pct1(g.lo)} to ${pct1(g.hi)}` : ""}">${band}<span class="tcur" data-w="${L(g.w)}"></span>${tgt}</span>`;
  }
  const barScale = (R) => Math.max(10, ...R.groups.map((g) => Math.max(g.w || 0, g.cap || 0))) * 1.08;
  function moneyChip(g) { return g.money ? `<span class="mv ${g.money > 0 ? "pos" : "neg"}">${g.money > 0 ? "+" : "−"}${esc(bm(Math.abs(g.money), 0))}</span>` : ""; }
  const openAttr = (g) => (g.i ? `data-open="${esc(keyOf(g.i))}"` : `data-act="posSheet" data-g="${esc(g.k)}"`);
  function reviewSummary(c, R) {
    const n = R.groups.length, cap = R.caps.map((b) => pct1(b.cap)).join(" / ");
    const counts = DECS.map((d) => `<button class="rc${st.pfDec === d ? " on" : ""}" data-set="pfDec" data-val="${st.pfDec === d ? "All" : d}" aria-pressed="${st.pfDec === d}">${decPill(d)}<b>${R.counts[d]}</b></button>`).join("");
    const big = R.big3.length ? R.big3.map((g) => `<button class="rbig" ${openAttr(g)}>${decPill(g.dec)}<span class="rbn"><b>${esc(g.name)}</b><span class="tk">${esc(g.change)}</span></span>${moneyChip(g)}</button>`).join("") : `<div class="muted small">No trades suggested: every priced holding is inside its range.</div>`;
    const flags = [...R.hotThemes.map((t) => `${t.k} is ${pct1(t.w)} of the portfolio (above ${R.prof.theme}%)`), ...R.hotCcy.map((x) => `${pct1(x.w)} in ${x.k} (above ${R.prof.ccy}%)`)];
    const ai = REV && REV.summary != null ? `<button class="railine" data-act="aiOpen"><span class="sgl sm" aria-hidden="true">✦</span><span><b>AI review</b><span class="tk">${esc(PROVIDERS[REV.provider] ? PROVIDERS[REV.provider].label : "")} · ${esc(new Date(REV.ts).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}</span></span><span class="chev">›</span></button>` : "";
    return `<div class="card revsum"><div class="rsh"><div><div class="kl">Holdings review</div><div class="tk">${n} position${n === 1 ? "" : "s"} · ${esc(R.pr.profile)}${R.pr.customCap ? " (custom cap)" : ""} · caps ${esc(cap)} · on this device</div></div>
      <button class="btn sm aib" data-act="aiReview"><span aria-hidden="true">✦</span> Get AI review</button></div>
      <div class="rcounts" role="group" aria-label="Filter holdings by decision">${counts}</div>
      ${flags.length ? `<div class="rflags">${flags.map((f) => `<span class="rfl">⚠ ${esc(f)}</span>`).join("")}</div>` : ""}
      <div class="kl mt6">Biggest moves</div><div class="rbigs">${big}</div>
      <div class="srow rfoot"><button class="btn primary" data-act="weekList">What to do this week <span class="cnt">${R.week.length}</span></button><button class="lnk" data-act="sizingRules">How sizing works</button></div>${ai}</div>`;
  }
  function holdingsToolbar() {
    const sorts = [["value", "Value"], ["decision", "Decision"], ["move", "Money to move"], ["gap", "Off target"]];
    return `<div class="htools"><div class="chips decf" role="group" aria-label="Filter by decision">${["All", ...DECS].map((d) => `<button data-set="pfDec" data-val="${d}" class="${(st.pfDec || "All") === d ? "on" : ""}">${esc(d)}</button>`).join("")}</div>
      <label class="hsort"><span class="tk">Sort</span><select data-set="pfSort" aria-label="Sort holdings">${sorts.map(([v, l]) => `<option value="${v}"${(st.pfSort || "value") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>`;
  }
  function sortRows(rows, R) {
    const g = (r) => R.byId.get(r.h.id) || {}, s = st.pfSort || "value";
    const f = st.pfDec && st.pfDec !== "All" ? rows.filter((r) => g(r).dec === st.pfDec) : rows;
    const cmp = { value: (a, b) => (b.v ?? -1) - (a.v ?? -1), decision: (a, b) => DEC_ORDER[g(a).dec] - DEC_ORDER[g(b).dec] || (b.v ?? -1) - (a.v ?? -1),
      move: (a, b) => Math.abs(g(b).money || 0) - Math.abs(g(a).money || 0) || (b.v ?? -1) - (a.v ?? -1), gap: (a, b) => Math.abs(g(b).dw || 0) - Math.abs(g(a).dw || 0) || (b.v ?? -1) - (a.v ?? -1) }[s];
    return [...f].sort(cmp);
  }
  // decision block used in the idea detail ("Your position") and the position sheet for unrated holdings
  function decisionBlock(g, R) {
    const ai = REV && REV.holdings && REV.holdings[g.k];
    const rng = g.dec === "Review" || g.hi == null ? "—" : g.dec === "Sell" ? "0% (exit)" : g.to != null && g.dec !== "Add" ? `${pct1(g.to)}` : `${pct1(g.lo)}–${pct1(g.hi)}`;
    const ask = g.i ? `<button class="btn sm" data-act="ask" data-k="${esc(keyOf(g.i))}">✦ Ask the analyst</button>` : `<button class="btn sm" data-act="askHolding" data-g="${esc(g.k)}">✦ Ask the analyst</button>`;
    return `<div class="decb"><div class="decr">${decPill(g.dec, "dlg")}<div class="decc"><b>${esc(g.change || (g.dec === "Review" ? "Needs your review" : ""))}</b><div class="tk">${esc(g.reason)}</div></div></div>
      <div class="decbar">${targetBar(g, Math.max(10, (g.w || 0), g.cap || 0) * 1.15)}<div class="declg"><span><i class="lgc"></i>Now ${pct1(g.w)}</span>${g.dec !== "Review" ? `<span><i class="lgt b-${g.dec.toLowerCase()}"></i>Target ${esc(rng)}</span>` : ""}${g.cap != null ? `<span class="tk">Cap ${pct1(g.cap)} for ${g.score.toFixed(1)}</span>` : ""}</div></div>
      <dl class="kv deck">${g.conv ? `<dt>Conviction</dt><dd><span class="conv cv-${g.conv.toLowerCase()}">${esc(g.conv)}</span></dd>` : ""}${g.plp != null ? `<dt>Unrealised</dt><dd class="${g.pl > 0 ? "pos" : g.pl < 0 ? "neg" : ""}">${esc(bmS(g.pl, 0))} (${pct(g.plp)})</dd>` : ""}${g.day != null ? `<dt>Day</dt><dd class="${g.day > 0 ? "pos" : g.day < 0 ? "neg" : ""}">${pct(g.day, 2)}</dd>` : ""}<dt>Rule</dt><dd>${esc(g.rules.join(" · "))}</dd></dl>
      ${g.notes.length ? `<ul class="decn">${g.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${g.dec === "Review" ? `<div class="tk">${g.unrated ? "The dashboard doesn't cover this holding, so there's no score to size it against. Link it to an idea (✎) if it is one, or ask the analyst." : "Add a manual price or import a value (✎) so it can be sized."}</div>` : ""}
      ${ai ? aiVerdictCard(g, ai, true) : ""}
      <div class="srow mt6">${ask}<button class="btn sm aib" data-act="aiReview" data-g="${esc(g.k)}">✦ ${ai ? "Refresh AI review" : "Get AI review"}</button>${g.i ? "" : `<button class="btn sm" data-edit="${esc(g.ids[0])}">✎ Edit</button>`}</div></div>`;
  }
  function reviewPosition(i) {
    if (!P || !VS.ready || !P.holdings.length) return "";
    const R = reviewCalc(), g = R.groups.find((x) => x.i && keyOf(x.i) === keyOf(i)); return g ? decisionBlock(g, R) : "";
  }
  function rulesSheet() {
    const R = { caps: capTable(), pr: revPrefs() }, p = PROFILES[R.pr.profile];
    return sheetHead("How sizing works", `Profile: ${esc(R.pr.profile)}${R.pr.customCap ? `, custom top cap ${pct1(R.pr.customCap)}` : ""} · change it in Settings`) + `<div class="shb rules">
      <h3>Maximum position by score</h3><table class="captab"><thead><tr><th>Overall score</th>${Object.keys(PROFILES).map((k) => `<th class="${k === R.pr.profile ? "on" : ""}">${k}</th>`).join("")}</tr></thead><tbody>
      ${BANDS.map(([s, c, l]) => `<tr><td>${l}</td>${Object.entries(PROFILES).map(([k, pp]) => `<td class="${k === R.pr.profile ? "on" : ""}">${pct1(k === R.pr.profile && R.pr.customCap ? half(c / 12 * R.pr.customCap) : half(c * pp.mult))}</td>`).join("")}</tr>`).join("")}
      <tr><td>Below 6</td>${Object.keys(PROFILES).map((k) => `<td class="${k === R.pr.profile ? "on" : ""}">Exit</td>`).join("")}</tr></tbody></table>
      <h3>Decisions, in order</h3><ol class="rl">
        <li><b>Review</b>: holdings the dashboard doesn't rate, or with no price or value. Nothing is guessed; ask the analyst instead.</li>
        <li><b>Sell</b>: anything rated <i>Avoid</i>, or scoring below 6. Target 0%.</li>
        <li><b>Trim</b> (rated Trim): halve the position, and never leave it above its cap.</li>
        <li><b>Trim</b> (overweight): above the cap for its score by more than 10% of the cap (at least 0.5 points), trim back to the cap.</li>
        <li><b>Add</b>: rated Buy or Accumulate on dips, scoring 7+, and below 60% of its cap. Add to 80% of the cap. Not while its theme is above ${p.theme}% of the portfolio.</li>
        <li><b>Take profits</b>: scoring below 7 with an unrealised gain of ${p.gain}%+ and otherwise a Hold, trim a quarter.</li>
        <li><b>Hold</b>: everything else, inside the range for its score. Changes under 0.25% of the portfolio are ignored.</li></ol>
      <h3>Flags</h3><ul class="rl"><li>Theme above ${p.theme}% of priced holdings (blocks adds in that theme).</li><li>One non-${esc(P ? P.base : "GBP")} currency above ${p.ccy}%.</li><li>Upcoming catalysts in the next 3 weeks, day moves of 5%+, and holdings sized on a broker or manual price rather than today's dashboard price.</li></ul>
      <h3>Conviction</h3><p class="muted small"><b>High</b>: Avoid-rated sells, scores below 5, positions 1.5× their cap, scores of 8+ (with a timing score of 7+ for adds). <b>Medium</b>: the rest. Dropped one level when the size relies on a broker or manual price, or part of the position has no price.</p>
      <h3>What it uses</h3><p class="muted small">The dashboard's overall score, action and factor scores (as of ${esc(D.asOf)}), your weights, P/L and cost from this device, theme and currency exposure, and the calendar. Weights are of priced holdings only. Money and share amounts use today's value per share. It never estimates a price or fundamental.</p>
      <div class="note"><b>Rules-based research, not regulated financial advice.</b> Check costs, tax (CGT, ISA/SIPP) and liquidity before trading.</div></div>`;
  }
  function weekSheet() {
    const R = reviewCalc(), b = asOfDate(), e = new Date(b); e.setDate(e.getDate() + 7);
    const item = (g, n) => { const soon = (g.cats || []).filter((c) => c.d <= e);
      return `<button class="wk" ${openAttr(g)}><span class="wkn">${n + 1}</span>${decPill(g.dec)}<span class="wkb"><b>${esc(g.name)}</b><span class="wkc">${esc(g.change || "Needs your review")}</span><span class="tk">${esc(g.reason)}</span>${soon.length ? `<span class="wkcat">📅 ${esc(soon[0].label)}: ${esc(soon[0].t)}</span>` : ""}</span>${moneyChip(g)}</button>`; };
    const sells = R.week.filter((g) => g.money < 0).reduce((a, g) => a - g.money, 0), adds = R.week.filter((g) => g.money > 0).reduce((a, g) => a + g.money, 0);
    return sheetHead("What to do this week", `${R.week.length} action${R.week.length === 1 ? "" : "s"} · sells and trims first, then adds, then reviews`) + `<div class="shb">
      ${R.week.length ? `<div class="wkt"><div><div class="tk">Raise</div><b class="neg">${esc(bm(sells, 0))}</b></div><div><div class="tk">Deploy</div><b class="pos">${esc(bm(adds, 0))}</b></div><div><div class="tk">Net</div><b>${esc(bmS(sells - adds, 0))}</b></div></div>
      <div class="wks">${R.week.map(item).join("")}</div>` : `<div class="card muted">Nothing to do: every holding is inside its range.</div>`}
      <div class="disc">Rules-based, from the dashboard as of ${esc(D.asOf)} and the holdings on this device. Not financial advice.</div></div>`;
  }
  function posSheet() {
    const R = reviewCalc(), g = R.groups.find((x) => x.k === sheetData.g); if (!g) return sheetHead("Holding") + `<div class="shb muted">This holding is no longer on the device.</div>`;
    return sheetHead(g.name, `${esc(g.sym)}${g.v != null ? ` · ${esc(bm(g.v))}` : " · no price"} · not on the dashboard`) + `<div class="shb">${decisionBlock(g, R)}</div>`;
  }

  // ---------- AI deep dive ----------
  let REV = null; const RV = { busy: false, ctl: null, err: "", got: 0, scope: null };
  const saveRev = () => vaultSave("review", REV);
  function reviewPayload(R, scopeK) {
    const ids = new Map(); let n = 0; for (const g of R.groups) ids.set(g.k, "H" + ++n);
    const hold = (g) => ({ id: ids.get(g.k), symbol: g.sym || null, name: g.name, onDashboard: !!g.i,
      ...(g.i ? { dashboardIdea: g.i.name, dashboardAction: g.i.action, dashboardScore: +g.score.toFixed(1), factorScores: Object.fromEntries(FACTORS.map((f) => [f.short, g.i.s[f.key]])), theme: g.i.theme, role: g.i.role } : {}),
      valueBase: g.v == null ? null : Math.round(g.v), weightPct: r1(g.w), unrealisedPLPct: r1(g.plp), costBase: g.cost == null ? null : Math.round(g.cost), quantity: g.qty, dayMovePct: g.day, priceSource: SRC_LABEL[g.src],
      engine: { decision: g.dec, targetPct: g.to, rangePct: g.hi != null ? [g.lo, g.hi] : null, capPct: g.cap ?? null, change: g.change || null, conviction: g.conv, reason: g.reason, rules: g.rules, notes: g.notes },
      upcomingCatalysts: (g.cats || []).map((c) => `${c.label}: ${c.t}`) });
    const scope = scopeK ? R.groups.filter((g) => g.k === scopeK) : R.groups;
    const ctx = { asOf: D.asOf, baseCurrency: P.base, riskProfile: R.pr.profile, capsByScore: R.caps.map((b) => ({ minScore: b.min, maxPct: b.cap })), exitBelowScore: 6,
      themeFlagPct: R.prof.theme, totalPricedValue: Math.round(R.total), exposureByThemePct: Object.fromEntries(pfCalc().byTheme.map((x) => [x.k, r1(x.w)])), exposureByCurrencyPct: Object.fromEntries(pfCalc().byCcy.map((x) => [x.k, r1(x.w)])),
      holdingsToReview: scope.map(hold), otherHoldings: scopeK ? R.groups.filter((g) => g.k !== scopeK).map((g) => ({ name: g.name, weightPct: r1(g.w), engineDecision: g.dec })) : undefined,
      ideas: ranked.map((i) => ({ name: i.name, ticker: i.ticker, theme: i.theme, role: i.role, action: i.action, score: +fmt(score10(i)), trigger: i.trigger, nextCatalyst: `${i.catalystDate}: ${i.catalyst}`, risk: i.risk, linkToLeader: i.link || undefined })),
      themeStances: D.themeStances, catalysts: D.catalysts.map((c) => ({ date: c.date, event: c.event, type: c.type })) };
    return { ids, ctx, scope };
  }
  const REVIEW_SYS = `You are "Analyst" inside Invest Intel, a private investing dashboard for a UK-based, finance-qualified, risk-tolerant investor. This is a holdings review.
You receive the dashboard's ratings, a rules-based engine's decision for each holding, and the investor's position sizes. Give a structured verdict per holding in "holdingsToReview".
Rules:
- Decision must be one of Add, Hold, Trim, Sell, Review. You may disagree with the engine; if you do, say why in reasons.
- Use only the figures provided. Never invent prices, fundamentals, dates or events. If something matters but isn't provided, say it's missing.
- For holdings with onDashboard=false: say in dataNote that the dashboard has no data on it, reason only from what is provided (size, P/L, price source), and prefer Review unless sizing alone justifies a call.
- targetWeightPct is a single % of the portfolio (or null if you can't say). Respect the caps unless you explain why not.
- alternative: a better or second-order play taken ONLY from the "ideas" list (use its exact name), or null.
- Be concise: 1-3 short reasons and 1-2 risks per holding.
Reply with ONLY this JSON, no prose, no code fences:
{"summary":"2-3 sentences on the portfolio","portfolio":["up to 4 portfolio-level points"],"holdings":[{"id":"H1","decision":"Hold","targetWeightPct":8,"reasons":["..."],"risks":["..."],"changeMyMind":"what would change the call","alternative":{"name":"exact idea name","why":"..."},"dataNote":null}]}`;
  async function runAiReview(scopeK) {
    if (!aiReady()) { openSheet("aiReview", { need: true }); return; }
    const R = reviewCalc(); if (!R.groups.length) return;
    const { ids, ctx, scope } = reviewPayload(R, scopeK); const back = new Map([...ids].map(([k, v]) => [v, k]));
    const cfg = curCfg(); RV.busy = true; RV.err = ""; RV.got = 0; RV.scope = scopeK || null; RV.ctl = new AbortController();
    openSheet("aiReview", { scope: scopeK || null });
    let txt = "";
    try {
      const msgs = [{ role: "user", content: `<review_input>\n${JSON.stringify(ctx)}\n</review_input>\n\nReview ${scopeK ? "this holding" : "every holding in holdingsToReview"} and reply with the JSON only.` }];
      for await (const t of streamChat(cfg, REVIEW_SYS, msgs, RV.ctl.signal, scopeK ? 3000 : 12000)) { txt += t; RV.got = txt.length; const pg = $("#sheet [data-prog]"); if (pg) pg.textContent = `Receiving… ${(txt.length / 1000).toFixed(1)}k characters`; }
      const j = parseJsonLoose(txt); if (!j || !Array.isArray(j.holdings)) throw new Error("The reply wasn't in the expected format. Try again or pick another model.");
      const names = new Set(D.ideas.map((i) => i.name)), now = Date.now();
      const clean = (h) => { const k = back.get(String(h.id)); if (!k) return null; const g = R.groups.find((x) => x.k === k);
        const alt = h.alternative && names.has(String(h.alternative.name)) ? { name: String(h.alternative.name), why: String(h.alternative.why || "") } : null;
        const tw = typeof h.targetWeightPct === "number" && h.targetWeightPct >= 0 && h.targetWeightPct <= 100 ? h.targetWeightPct : null;
        return [k, { ts: now, decision: DECS.includes(h.decision) ? h.decision : "Review", target: tw, reasons: (h.reasons || []).slice(0, 4).map(String), risks: (h.risks || []).slice(0, 3).map(String),
          change: h.changeMyMind ? String(h.changeMyMind) : "", alt, altDropped: !!(h.alternative && h.alternative.name && !alt), note: h.dataNote ? String(h.dataNote) : (g && !g.i ? "Not on the dashboard: no dashboard data was available for this holding." : ""), engine: g ? g.dec : null }]; };
      const got = j.holdings.map(clean).filter(Boolean);
      if (!got.length) throw new Error("The reply didn't include any of your holdings. Try again.");
      if (!scopeK) REV = { ts: now, provider: cfg.provider, model: cfg.model, profile: R.pr.profile, summary: String(j.summary || ""), portfolio: (Array.isArray(j.portfolio) ? j.portfolio : []).slice(0, 5).map(String), holdings: {} };
      else if (!REV) REV = { ts: now, provider: cfg.provider, model: cfg.model, profile: R.pr.profile, summary: null, portfolio: [], holdings: {} };
      for (const [k, v] of got) REV.holdings[k] = { ...v, provider: cfg.provider, model: cfg.model };
      await saveRev();
    } catch (e) { RV.err = e.name === "AbortError" ? "Stopped." : e.status || e instanceof TypeError ? errText(e, cfg) : e.message; }
    RV.busy = false; RV.ctl = null; txt = "";
    if (sheetKind === "aiReview") paintSheet(); render();
  }
  function aiVerdictCard(g, v, compact) {
    const agree = v.engine && v.engine === v.decision;
    return `<div class="aiv${compact ? " compact" : ""}"><div class="aivh"><span class="sgl sm" aria-hidden="true">✦</span>${compact ? "<b>AI view</b>" : `<b>${esc(g ? g.name : "")}</b>`}${decPill(v.decision)}${v.target != null ? `<span class="tk">target ${pct1(v.target)}</span>` : ""}
      ${v.engine ? `<span class="agr ${agree ? "ok" : "df"}">${agree ? "agrees with rules" : `rules say ${esc(v.engine)}`}</span>` : ""}</div>
      ${v.note ? `<div class="aivnote">${esc(v.note)}</div>` : ""}
      ${v.reasons.length ? `<div class="aivs"><div class="kl">Why</div><ul>${v.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
      ${v.risks.length ? `<div class="aivs"><div class="kl">Risks</div><ul>${v.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
      ${v.change ? `<div class="aivs"><div class="kl">What would change the call</div><p>${esc(v.change)}</p></div>` : ""}
      ${v.alt ? (() => { const i = D.ideas.find((x) => x.name === v.alt.name); return `<div class="aivs"><div class="kl">Alternative from your ideas</div>${i ? `<button class="aialt" data-open="${esc(keyOf(i))}">${pill(i.action, ACTION_TONE[i.action])}<b>${esc(i.name)}</b><span class="tk">${fmt(score10(i))}</span><span class="chev">›</span></button>` : ""}<p class="tk">${esc(v.alt.why)}</p></div>`; })() : v.altDropped ? `<div class="tk">The suggested alternative isn't on your ideas list, so it was left out.</div>` : ""}
      <div class="tk">${esc(PROVIDERS[v.provider] ? PROVIDERS[v.provider].label : "")} · ${esc(v.model || "")} · ${esc(new Date(v.ts).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))} · AI analysis, not financial advice</div></div>`;
  }
  function aiReviewSheet() {
    const d = sheetData || {};
    if (d.need || !aiReady()) return sheetHead("AI review") + `<div class="shb"><div class="card setupc sm"><div class="sgl" aria-hidden="true">✦</div><h3>Connect your AI analyst</h3>
      <p class="muted small">The AI review sends the rules engine's output and the dashboard's ratings to the provider you choose, using your own API key. Add a key in Settings to use it. The rules-based review above works without one.</p>
      <button class="btn primary" data-sheet-act="goAI">Open AI settings</button></div><div class="disc">AI analysis, not financial advice.</div></div>`;
    const cfg = curCfg(), lbl = PROVIDERS[cfg.provider].label;
    if (RV.busy) return sheetHead(d.scope ? "AI review: holding" : "AI review", `${esc(lbl)} · ${esc(cfg.model)}`) + `<div class="shb"><div class="reading"><div class="spin" aria-hidden="true"></div><b>Reviewing ${d.scope ? "this holding" : "your holdings"}…</b><span class="tk" data-prog>Sending the rules output and dashboard ratings to ${esc(lbl)}</span></div>
      <div class="privnote">Sent: holdings names, sizes, weights, P/L and the engine's decisions, plus the dashboard ideas and calendar. Your API key goes only to ${esc(lbl)}.</div>
      <div class="shf"><button class="btn" data-sheet-act="aiStop">Stop</button></div></div>`;
    const R = reviewCalc(), list = d.scope ? R.groups.filter((g) => g.k === d.scope) : [...R.groups].sort((a, b) => DEC_ORDER[a.dec] - DEC_ORDER[b.dec]);
    const have = REV ? list.filter((g) => REV.holdings[g.k]) : [];
    const head = sheetHead(d.scope ? (list[0] ? list[0].name : "AI review") : "AI review", REV ? `${esc(PROVIDERS[REV.provider] ? PROVIDERS[REV.provider].label : "")} · ${esc(REV.model)} · ${esc(new Date(REV.ts).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}` : "");
    return head + `<div class="shb">${RV.err ? `<p class="err">${esc(RV.err)}</p>` : ""}
      ${!d.scope && REV && REV.summary ? `<div class="card aisum"><p>${esc(REV.summary)}</p>${REV.portfolio.length ? `<ul>${REV.portfolio.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}</div>` : ""}
      ${have.length ? have.map((g) => aiVerdictCard(g, REV.holdings[g.k], false)).join("") : `<div class="card muted">No AI review yet${d.scope ? " for this holding" : ""}.</div>`}
      ${!d.scope && REV && have.length < list.length ? `<div class="tk">${list.length - have.length} holding${list.length - have.length === 1 ? "" : "s"} added since this review.</div>` : ""}
      <div class="disc">AI analysis of the rules output and the dashboard (as of ${esc(D.asOf)}). Not financial advice. Saved encrypted on this device only.</div>
      <div class="shf"><button class="btn" data-close>Close</button><button class="btn primary" data-sheet-act="aiRun" data-g="${esc(d.scope || "")}">✦ ${have.length ? "Run again" : "Run AI review"}</button></div></div>`;
  }
  function reviewSheetClick(b) {
    const a = b.dataset.sheetAct;
    if (a === "aiStop") { if (RV.ctl) RV.ctl.abort(); return true; }
    if (a === "aiRun") { runAiReview(b.dataset.g || null); return true; }
    return false;
  }
  Object.assign(EXTRA_ACTS, {
    aiReview: (b) => { const k = b.dataset.g || null; if (REV && (k ? REV.holdings[k] : REV.summary != null) && aiReady()) openSheet("aiReview", { scope: k }); else runAiReview(k); },
    aiOpen: () => openSheet("aiReview", { scope: null }),
    weekList: () => openSheet("week"),
    sizingRules: () => openSheet("rules"),
    posSheet: (b) => openSheet("pos", { g: b.dataset.g }),
    askHolding: (b) => { const R = reviewCalc(), g = R.groups.find((x) => x.k === b.dataset.g); if (!g) return; AU.focus = null;
      AU.draft = `Review my holding ${g.name}${g.sym && g.sym !== g.name ? ` (${g.sym})` : ""}${g.w != null ? `, ${pct1(g.w)} of my portfolio` : ", which has no price"}. It isn't on the dashboard: say so, use only what you know and what's in my portfolio data, and tell me whether to add, hold, trim or sell and what size fits.`;
      goTab("Analyst"); },
    revProfile: async (b) => { P.review = { ...(P.review || {}), profile: b.dataset.val }; await savePortfolio(); render(); toast(`Risk profile: ${b.dataset.val}`); },
    revCapClear: async () => { P.review = { ...(P.review || {}), customCap: null }; await savePortfolio(); render(); toast("Using the profile's caps"); },
    revClearAI: async () => { if (!confirm("Delete the saved AI review from this device?")) return; REV = null; await vdel("review"); render(); toast("AI review deleted"); },
  });
  function reviewSettings() {
    if (!VS.ready || !P) return "";
    const pr = revPrefs(), caps = capTable();
    return `<h3 id="review-settings">Holdings review</h3><div class="card"><div class="slbl">Risk profile</div>
      <div class="seg3 prof" role="radiogroup" aria-label="Risk profile">${Object.entries(PROFILES).map(([k, p]) => `<button type="button" role="radio" aria-checked="${pr.profile === k}" data-act="revProfile" data-val="${k}" class="${pr.profile === k ? "on" : ""}">${k}</button>`).join("")}</div>
      <div class="tk">${esc(PROFILES[pr.profile].blurb)}. Caps by score: ${caps.map((b) => `${b.label} up to ${pct1(b.cap)}`).join(", ")}; below 6 exits.</div>
      <form class="capf" data-form="revcap"><label class="fld"><span>Custom top cap (score 8+), optional</span><input name="cap" type="number" inputmode="decimal" min="2" max="40" step="0.5" value="${pr.customCap || ""}" placeholder="${pct1(half(12 * PROFILES[pr.profile].mult))} (profile)"></label>
        <button class="btn" type="submit">Set</button>${pr.customCap ? `<button class="btn" type="button" data-act="revCapClear">Use profile</button>` : ""}</form>
      <div class="tk">A custom cap replaces the 8+ cap; the lower bands scale with it.</div>
      <div class="srow mt12"><button class="btn" data-act="sizingRules">How sizing works</button>${REV ? `<button class="btn dangerT" data-act="revClearAI">Delete saved AI review</button>` : ""}</div></div>`;
  }
  function extraClick(e) {
    const pv = e.target.closest("[data-ai-prov]");
    if (pv) { const id = pv.dataset.aiProv; if (A.cfg.provider !== id) { A.cfg.provider = id; AU.showCustom = false; saveAI().catch(() => {}); render(); } return true; }
    const sg = e.target.closest("[data-sug]"); if (sg) { sendChat(suggestions0()[+sg.dataset.sug][1]); return true; }
    const ed = e.target.closest("[data-edit]"); if (ed) { const h = P.holdings.find((x) => x.id === ed.dataset.edit); if (h) openSheet("edit", { id: h.id, h: { ...h } }); return true; }
    return false;
  }
  function extraChange(e) {
    if (e.target.name === "model" && e.target.closest("form[data-form=ai]")) { const c = e.target.closest("form").querySelector("[data-custom]"); AU.showCustom = e.target.value === "__custom"; c.classList.toggle("hide", !AU.showCustom); return true; }
    return false;
  }
  function extraSettings() {
    const ai = VS.ready && A ? `<h3 id="ai-settings">AI analyst</h3><div class="card">${aiForm("settings")}
        <div class="srow mt12"><button class="btn" data-act="clearChat"${A.msgs.length ? "" : " disabled"}>Clear chat history (${A.msgs.length})</button></div></div>` : `<h3>AI analyst</h3>${vaultGate()}`;
    const pf = VS.ready && P ? `<h3>Portfolio data</h3><div class="card"><div class="slbl">Base currency</div><div class="chips">${["GBP", "USD", "EUR"].map((b) => `<button data-act="base" data-val="${b}" class="${P.base === b ? "on" : ""}">${b}</button>`).join("")}</div>
        <div class="srow"><button class="btn" data-act="backup">⇅ Backup and sync</button><span class="tk">${P.holdings.length} holdings on this device${P.updatedAt ? " · saved " + esc(new Date(P.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })) : ""}</span></div>
        <button class="btn danger" data-act="wipeLocal">Delete holdings, chat and AI key from this device</button>
        <div class="tk mt6">Holdings, chat and the AI key are AES-256-GCM encrypted with your passcode in this browser's storage. 🔒 Lock now clears them from memory.</div></div>` : "";
    return reviewSettings() + ai + pf;
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

  V.Portfolio = portfolioMain;
  V.Analyst = analystView;
  const baseSettingsView = V.Settings;
  V.Settings = () => { const h = baseSettingsView(); const i = h.indexOf("<h3>Security</h3>"); return i < 0 ? h + extraSettings() : h.slice(0, i) + extraSettings() + h.slice(i); };

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
    document.body.classList.toggle("v-analyst", st.view === "Analyst" && !q);
    if (st.view === "Analyst" && !q) {
      $("#view").innerHTML = V.Analyst(); document.body.classList.remove("split-mode");
      document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === st.view));
      $("#tabs [data-more]").classList.toggle("on", OVERFLOW.includes(st.view)); afterChatRender(); return;
    }
    const head = (st.view === "Settings" || st.view === "Portfolio") && !q ? "" : `<div class="note"><b>Research, not regulated financial advice.</b> As of ${esc(D.asOf)}. Overall score (1–10) = ${esc(wl)}. Risk: higher = lower risk.</div>`;
    const foot = `<div class="foot">${isWide() ? "Select an idea to see its chart and fundamentals alongside · 1–9 switch views · / search · Esc close" : "Tap any idea for price chart, fundamentals and scores · 🔒 locks this device"}</div>`;
    const body = () => (q ? searchView(q) : V[st.view]());
    document.body.classList.toggle("split-mode", splitOn());
    const prevPane = $(".detailpane"), prevTop = prevPane ? prevPane.scrollTop : 0, prevKey = prevPane ? prevPane.dataset.k : null;
    if (splitOn()) {
      const pfMode = st.view === "Portfolio" && !q;
      const listHtml = head + body() + foot;
      $("#view").innerHTML = `<div class="split${pfMode ? " pfsplit" : ""}"><div class="listpane">${listHtml}</div><aside class="detailpane" aria-label="${pfMode && !st.detail ? "Portfolio exposure" : "Idea detail"}"></aside></div>`;
      const k = selKey(); det = k ? D.ideas.find((i) => keyOf(i) === k) : null;
      if (det && !st.detail) document.querySelectorAll(`.listpane .idea[data-open="${CSS.escape(k)}"]`).forEach((x) => x.classList.add("sel"));
      if (pfMode && det) document.querySelectorAll(`.listpane .hold[data-open="${CSS.escape(k)}"]`).forEach((x) => x.classList.add("sel"));
      $(".detailpane").innerHTML = pfMode ? (det ? `<button class="back" data-act="closeDetail">‹ Portfolio overview</button>` + detail(det) : portfolioSide())
        : det ? detail(det) : `<div class="card muted">No idea selected. Pick one from the list.</div>`;
      const pane = $(".detailpane"); pane.dataset.k = det ? keyOf(det) : ""; if (det && prevKey === keyOf(det)) pane.scrollTop = prevTop;
    } else {
      $("#view").innerHTML = det ? detail(det) + `<div class="note mt12"><b>Research, not regulated financial advice.</b> As of ${esc(D.asOf)}.</div>`
        : head + body() + (st.view === "Settings" ? "" : foot);
    }
    document.querySelectorAll("[data-w]").forEach((el) => { el.style.width = el.dataset.w + "%"; });
    document.querySelectorAll("#view [data-l]").forEach((el) => { el.style.left = el.dataset.l + "%"; });
    if (sheetKind === "pos" || sheetKind === "week" || (sheetKind === "aiReview" && !RV.busy)) paintSheet();
    document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === st.view));
    $("#tabs [data-more]").classList.toggle("on", OVERFLOW.includes(st.view));
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  tryRemembered().then((ok) => { if (!ok) $("#pass").focus(); });
})();
