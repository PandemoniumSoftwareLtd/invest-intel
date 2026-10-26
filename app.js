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
    P = null; A = null; AU.draft = ""; IMP = null; D = null; pending = null;
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
        const ai = await vaultLoad("ai"), chat = await vaultLoad("chat");
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
      <p class="muted">Your ${esc(st0.map((n) => ({ portfolio: "portfolio", ai: "analyst settings", chat: "chat history" }[n])).join(", "))} on this device was encrypted with your previous passcode. Enter that passcode to re-encrypt it with the current one.</p>
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
      // a bare symbol can collide across exchanges (e.g. BA = Boeing in the US, BA. = BAE in London): require a matching currency or name
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
    w.onchange = onSheetChange; w.oninput = onSheetInput; w.onsubmit = (e) => { e.preventDefault(); onSheetSubmit(e.target.closest("form")); };
  }
  function openSheet(kind, data) {
    sheetKind = kind; sheetData = data || null; lastFocus = document.activeElement;
    const w = $("#sheet"); w.hidden = false; document.body.classList.add("sheet-open"); paintSheet();
    requestAnimationFrame(() => { w.classList.add("in"); const f = w.querySelector("[autofocus]") || w.querySelector(".sheet"); if (f && !matchMedia("(pointer: coarse)").matches) f.focus(); });
  }
  function closeSheet(instant) {
    const w = $("#sheet"); if (!w || w.hidden) return; w.classList.remove("in"); document.body.classList.remove("sheet-open");
    const done = () => { w.hidden = true; w.querySelector(".sheet").innerHTML = ""; sheetKind = null; sheetData = null; if (lastFocus && lastFocus.focus) try { lastFocus.focus({ preventScroll: true }); } catch {} };
    if (instant) done(); else setTimeout(done, 180);
  }
  const sheetHead = (t, sub) => `<div class="shh"><div class="grab" aria-hidden="true"></div><div class="shrow"><div><h2>${esc(t)}</h2>${sub ? `<div class="tk">${sub}</div>` : ""}</div><button class="iconBtn" data-close aria-label="Close">✕</button></div></div>`;
  function paintSheet() {
    const el = $("#sheet .sheet"); let h = "";
    if (sheetKind === "more") h = sheetHead("More") + `<div class="morelist">${OVERFLOW.map((v) => { const t = TABS.find((x) => x[0] === v); return `<button class="moreit${st.view === v ? " on" : ""}" data-tab-go="${v}"><span class="ic">${t[1]}</span>${esc(v)}<span class="chev">›</span></button>`; }).join("")}</div>`;
    else if (sheetKind === "import") h = importSheet();
    else if (sheetKind === "edit") h = editSheet();
    else if (sheetKind === "backup") h = backupSheet();
    else if (sheetKind === "restorepass") h = sheetHead("Backup passcode") + `<form class="shb" data-form="restorepass"><p class="muted small">This backup was encrypted with a different passcode (or before a passcode change). Enter the passcode it was made with.</p>
      <input type="password" name="pass" autocomplete="off" placeholder="Backup passcode" aria-label="Backup passcode" required autofocus><p class="err" data-err></p>
      <div class="shf"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Open backup</button></div></form>`;
    else if (sheetKind === "restore") h = restoreSheet();
    else if (sheetKind === "context") h = sheetHead("What the analyst sees", `Sent to ${esc(PROVIDERS[A.cfg.provider].label)} with your next message`) + `<div class="shb"><div class="tk">${(sheetData.length / 1000).toFixed(1)}k characters (≈${Math.round(sheetData.length / 3.8 / 1000)}k tokens)</div><pre class="ctxpre">${esc(sheetData)}</pre></div>`;
    el.innerHTML = h;
    el.querySelectorAll("[data-w]").forEach((x) => { x.style.width = x.dataset.w + "%"; });
  }
  function openMore() { openSheet("more"); }

  // ---------- import sheet ----------
  function importSheet() {
    const I = IMP; let res; let err = "";
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
  const filePick = (accept) => new Promise((res) => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = accept; inp.style.display = "none";
    inp.onchange = () => { const f = inp.files && inp.files[0]; inp.remove(); res(f || null); }; document.body.appendChild(inp); inp.click();
  });
  const readFile = (f) => new Promise((res, rej) => { if (f.size > 8e6) { rej(new Error("File is larger than 8 MB.")); return; } const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });
  async function pickCsv() {
    const f = await filePick(".csv,.tsv,.txt,text/csv,text/plain,text/comma-separated-values,text/tab-separated-values,application/vnd.ms-excel"); if (!f) return;
    try { startImport(await readFile(f), f.name); openSheet("import"); } catch (e) { toast(e.message || "Couldn't read that file", "bad"); }
  }
  let restoreText = null;
  async function onSheetClick(e) {
    const go = e.target.closest("[data-tab-go]"); if (go) { goTab(go.dataset.tabGo); return; }
    const mode = e.target.closest("[data-imp-mode]"); if (mode) { IMP.mode = mode.dataset.impMode; paintSheet(); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick) { const i = D.ideas.find((x) => keyOf(x) === pick.dataset.pick); const fm = $("#sheet form"); if (i && fm) { fm.sym.value = i.ticker.split(" / ")[0]; fm.name.value = i.name; fm.link.value = keyOf(i); const pc = mkt(i) && mkt(i).price && normCcy(mkt(i).price.currency); if (pc && !isCryptoIdea(i)) fm.ccy.value = pc; $("#sheet [data-sugg]").innerHTML = ""; fm.qty.focus(); } return; }
    const b = e.target.closest("[data-sheet-act]"); if (!b) return; const a = b.dataset.sheetAct;
    try {
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
    const m = e.target.closest("[data-imp-map]"); if (m) { IMP.map[m.dataset.impMap] = +m.value; paintSheet(); const d = $("#sheet details"); if (d) d.open = true; return; }
    const s = e.target.closest("[data-imp-set]"); if (s && s.tagName === "SELECT") { IMP[s.dataset.impSet] = s.value; paintSheet(); const d = $("#sheet details"); if (d) d.open = true; }
  }
  function onSheetInput(e) {
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
  function holdingRow(r) {
    const h = r.h, i = r.mt && r.mt.i, k = i ? keyOf(i) : null;
    const plp = r.pl != null && r.cost ? r.pl / r.cost * 100 : null;
    const open = k ? `data-open="${esc(k)}"` : `data-edit="${esc(h.id)}"`;
    return `<div class="hrow${st.detail && st.detail === k ? " sel" : ""}">
      <button class="hold hmain" ${open} aria-label="${esc((h.name || h.sym) + (i ? ", open idea" : ", edit"))}">
        <div class="hn"><span class="hsym">${esc(h.sym || "—")}</span><span class="hname">${esc(h.name && h.name !== h.sym ? h.name : "")}</span></div>
        <div class="hmeta">${i ? `${pill(i.action, ACTION_TONE[i.action])}<span class="hsc">${fmt(score10(i))}</span>` : `<span class="pill t-neutral">Not on dashboard</span>`}<span class="tk">${esc(qtyFmt(h.qty))}${r.px != null ? " × " + esc(money(r.px, r.pxCcy)) : ""}</span></div>
        <div class="hw"><span class="track"><span class="fill" data-w="${r.w != null ? r.w.toFixed(1) : 0}"></span></span></div>
      </button>
      <div class="hval">${r.v != null ? `<b>${esc(bm(r.v))}</b>` : `<span class="nopx">No price</span>`}
        ${r.pl != null ? `<span class="${r.pl > 0 ? "pos" : r.pl < 0 ? "neg" : "tk"}">${esc(bmS(r.pl))}${plp != null ? ` · ${pct(plp)}` : ""}</span>` : r.v != null ? `<span class="tk">No cost</span>` : ""}
        <span class="tk">${r.v == null ? (r.src === "nofx" ? `<span class="src s-nofx">No FX rate</span>` : "Tap ✎ to add a price") : `${r.w != null ? r.w.toFixed(1) + "% · " : ""}<span class="src s-${r.src}">${esc(SRC_LABEL[r.src])}</span>`}</span></div>
      <button class="iconBtn sm" data-edit="${esc(h.id)}" aria-label="Edit ${esc(h.sym || h.name)}">✎</button></div>`;
  }
  function portfolioMain() {
    const gate = vaultGate(); if (gate) return `<div class="phead"><h2>Portfolio</h2></div>${gate}`;
    const n = P.holdings.length;
    const tools = `<div class="ptools"><button class="btn primary" data-act="importCsv"><span aria-hidden="true">⇪</span> Import CSV</button><button class="btn" data-act="addHolding">＋ Add</button><button class="btn" data-act="backup" aria-label="Backup and sync">⇅ Backup</button></div>`;
    if (!n) return `<div class="phead"><h2>Portfolio</h2></div>
      <div class="card pempty"><div class="gic big">◔</div><h3>Bring in your holdings</h3>
        <p class="muted">See your value, P/L and exposure next to the dashboard's ratings, with flags like “you hold X, rated Trim”.</p>
        <div class="pemptyb"><button class="btn primary" data-act="importCsv">⇪ Import broker CSV</button><button class="btn" data-act="addHolding">＋ Add manually</button><button class="btn" data-act="restoreFile">⇩ Restore backup</button></div>
        <div class="brokers"><span>Trading 212</span><span>Freetrade</span><span>Hargreaves Lansdown</span><span>AJ Bell</span><span>Interactive Brokers</span><span>Coinbase</span><span>Any CSV</span></div>
        <div class="privnote">🔒 Stored only on this device, encrypted with your passcode. Never uploaded or published.</div></div>
      <h3>Where to get the CSV</h3><div class="card list small howto">
        <div class="item"><div class="lead">Trading 212</div><div class="body">Menu → History → Export (CSV). Transactions are added up into positions.</div></div>
        <div class="item"><div class="lead">Freetrade</div><div class="body">Activity → Export (CSV).</div></div>
        <div class="item"><div class="lead">HL</div><div class="body">Portfolio overview → Download (CSV).</div></div>
        <div class="item"><div class="lead">AJ Bell</div><div class="body">Portfolio → Valuation → Export to CSV.</div></div>
        <div class="item"><div class="lead">IBKR</div><div class="body">Reports → Activity statement → CSV (uses the Open Positions section).</div></div>
        <div class="item"><div class="lead">Coinbase</div><div class="body">Profile → Statements → Transaction history (CSV).</div></div>
        <div class="item"><div class="lead">Trackers</div><div class="body">Sharesight, Snowball, Delta and similar: export holdings to CSV, then map the columns.</div></div></div>`;
    const c = pfCalc(), wide = isWide();
    const plp = c.costTot ? c.plTot / c.costTot * 100 : null;
    const kpis = `<div class="kpis pk">
      <div class="kpi"><div class="kl">Value</div><div class="kv1 big">${esc(bm(c.total, 0))}</div><div class="ks">${c.priced.length}/${n} priced · ${esc(P.base)}</div></div>
      <div class="kpi"><div class="kl">Unrealised P/L</div><div class="kv1 big ${c.plTot > 0 ? "pos" : c.plTot < 0 ? "neg" : ""}">${c.costTot ? esc(bmS(c.plTot, 0)) : "—"}</div><div class="ks">${plp != null ? pct(plp) + " on cost" : "Add cost to see P/L"}</div></div>
      <div class="kpi"><div class="kl">Day move</div><div class="kv1 big ${c.day > 0 ? "pos" : c.day < 0 ? "neg" : ""}">${esc(bmS(c.day, 0))}</div><div class="ks">Dashboard-priced lines</div></div>
      <div class="kpi"><div class="kl">On the dashboard</div><div class="kv1 big">${c.held.size}<span class="tk"> of ${D.ideas.length} ideas</span></div><div class="ks">${c.flags.filter((f) => f.tone === "danger" || f.tone === "warning").length} flags to review</div></div></div>`;
    const flags = c.flags.length ? `<h3>Decision flags</h3><div class="card list flags">${c.flags.map((f) => `<${f.k ? `button data-open="${esc(f.k)}"` : "div"} class="item fl f-${f.tone}"><span class="fdot" aria-hidden="true"></span><div class="body"><div class="ttl">${esc(f.t)}</div>${f.d ? `<div class="det">${esc(f.d)}</div>` : ""}</div>${f.k ? `<span class="chev">›</span>` : ""}</${f.k ? "button" : "div"}>`).join("")}</div>` : "";
    const good = c.good.length ? `<h3>Held and rated well</h3><div class="card list">${c.good.map((r) => `<button class="item" data-open="${esc(keyOf(r.mt.i))}"><div class="body"><div class="ttl">You hold <b>${esc(r.mt.i.name)}</b>${r.w != null ? ` (${r.w.toFixed(1)}%)` : ""}, rated ${esc(r.mt.i.action)} ${fmt(score10(r.mt.i))}</div><div class="det">${esc(r.mt.i.trigger)}</div></div><span class="chev">›</span></button>`).join("")}</div>` : "";
    const base = `<div class="chips basec">${["GBP", "USD", "EUR"].map((b) => `<button data-act="base" data-val="${b}" class="${P.base === b ? "on" : ""}">${b}</button>`).join("")}</div>`;
    return `<div class="phead"><div><h2>Portfolio</h2><div class="tk">🔒 This device only · prices as of ${esc(D.asOf.replace(/^[A-Z][a-z]{2} /, ""))}</div></div>${base}</div>${tools}${kpis}${flags}
      <h3>Holdings <span class="tk">(${n})</span></h3><div class="card hlist">${c.rows.map(holdingRow).join("")}</div>
      <div class="tk pnote">Values use dashboard prices where a holding matches an idea, otherwise a manual price or the value in your broker file (dated). Holdings without either are marked <span class="nopx">No price</span> and left out of totals. FX: ECB reference rates.</div>
      ${good}${wide ? "" : portfolioSide(c)}
      <div class="note mt12"><b>Research, not regulated financial advice.</b> Flags compare your holdings with the dashboard's ratings as of ${esc(D.asOf)}.</div>`;
  }

  // ---------- actions wired from the main click handler ----------
  const EXTRA_ACTS = {
    importCsv: () => pickCsv(),
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
    xai: { label: "xAI", long: "xAI (Grok)", url: "https://api.x.ai/v1/chat/completions", keyUrl: "https://console.x.ai/", keyHint: "xai-…",
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
    wipeLocal: async () => { if (!confirm("Delete your holdings, chat history and AI key from this device? This can't be undone (export a backup first).")) return; for (const n of ["portfolio", "ai", "chat"]) await vdel(n); AU.focus = null; await openVault(); toast("On-device data deleted"); },
  });
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
    return ai + pf;
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
    document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === st.view));
    $("#tabs [data-more]").classList.toggle("on", OVERFLOW.includes(st.view));
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  tryRemembered().then((ok) => { if (!ok) $("#pass").focus(); });
})();
