"use strict";
// Invest Intel — the app shell holds NO dashboard data. data.enc.json is AES-GCM encrypted;
// the key is derived in-browser from the passcode with PBKDF2-SHA256.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();

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
  let payload = null;
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
    const saved = await loadKey();
    if (!saved || !saved.key) return false;
    try {
      payload = payload || await getPayload();
      if (saved.salt !== payload.salt) { await clearKey(); return false; }
      start(await decrypt(saved.key, payload)); return true;
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
      if ($("#remember").checked) await saveKey(key, payload.salt).catch(() => {});
      $("#pass").value = ""; start(data);
    } catch (err) { msg.textContent = err.message || "Could not unlock"; }
    finally { btn.disabled = false; btn.textContent = "Unlock"; }
  });
  $("#lockBtn").addEventListener("click", async () => { await clearKey(); location.reload(); });
  $("#themeBtn").addEventListener("click", () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const cur = document.documentElement.dataset.theme || (dark ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next; localStorage.setItem("theme", next);
  });
  const th = localStorage.getItem("theme"); if (th) document.documentElement.dataset.theme = th;

  // ---------- app ----------
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
  const TABS = [["Focus", "◎"], ["Scoreboard", "≡"], ["Themes", "◇"], ["Crypto", "₿"], ["Calendar", "▦"], ["Sources", "↗"]];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let D, W, ranked, st;
  const pill = (t, tone) => `<span class="pill t-${tone}">${esc(t)}</span>`;
  const score10 = (i) => Math.round(FACTORS.reduce((a, f) => a + i.s[f.key] * W[f.key], 0) / 10);
  const fmt = (t) => (t / 10).toFixed(1);
  const byScore = (a, b) => score10(b) - score10(a);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function asOfDate() {
    const m = /(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})/.exec(D.asOf);
    return m ? new Date(+m[3], MONTHS.indexOf(m[2]), +m[1]) : new Date();
  }

  function start(data) {
    D = data; W = data.weights; ranked = [...D.ideas].sort(byScore);
    const base = asOfDate();
    st = { view: sessionStorage.getItem("view") || "Focus", group: "All", action: "All", sort: "overall", cols: "Decision",
      theme: "Defence", cal: "All", month: iso(base).slice(0, 7), open: new Set() };
    $("#lock").hidden = true; $("#app").hidden = false;
    $("#asof").textContent = "As of " + D.asOf;
    $("#tabs").innerHTML = TABS.map(([v, ic]) => `<button data-tab="${v}"><span class="ic">${ic}</span>${v}</button>`).join("");
    $("#tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) { st.view = b.dataset.tab; sessionStorage.setItem("view", st.view); render(); scrollTo(0, 0); } };
    $("#view").onclick = onClick; $("#view").onchange = onChange;
    render();
  }

  function onClick(e) {
    const c = e.target.closest("[data-set]");
    if (c) { st[c.dataset.set] = c.dataset.val; render(); return; }
    const card = e.target.closest(".idea");
    if (card && !e.target.closest("a")) { card.classList.toggle("open"); const k = card.dataset.k; st.open.has(k) ? st.open.delete(k) : st.open.add(k); }
  }
  function onChange(e) { const s = e.target.closest("select[data-set]"); if (s) { st[s.dataset.set] = s.value; render(); } }

  const chips = (key, opts) => `<div class="chips">${opts.map((o) => {
    const [v, l, n] = Array.isArray(o) ? o : [o, o];
    return `<button data-set="${key}" data-val="${esc(v)}" class="${st[key] === v ? "on" : ""}">${esc(l)}${n != null ? `<span class="cnt">${n}</span>` : ""}</button>`;
  }).join("")}</div>`;
  const select = (key, label, opts) => `<select data-set="${key}" aria-label="${esc(label)}">${opts.map(([v, l]) =>
    `<option value="${esc(v)}"${st[key] === v ? " selected" : ""}>${esc(label)}: ${esc(l)}</option>`).join("")}</select>`;
  const list = (rows) => `<div class="card list">${rows.map((r) => `<div class="item"><div class="lead">${esc(r.lead)}</div><div class="body">
    <div class="ttl">${r.href ? `<a href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>` : esc(r.title)}</div>
    ${r.detail ? `<div class="det">${esc(r.detail)}</div>` : ""}</div>${r.pill || ""}</div>`).join("")}</div>`;
  const linkList = (links) => `<div class="card list links">${links.map((l) => `<a class="item" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">
    <div class="body"><div class="ttl">${esc(l.title)}</div><div class="det">${esc(l.site)}${l.date ? " · " + esc(l.date) : ""}</div></div></a>`).join("")}</div>`;

  function ideaCard(i, opts = {}) {
    const k = i.ticker + i.name;
    const scores = FACTORS.map((f) => `${f.short} ${i.s[f.key]}`).join(" · ");
    const body = opts.body ?? i.trigger;
    return `<div class="card idea${st.open.has(k) ? " open" : ""}" data-k="${esc(k)}">
      <div class="row1"><div><div class="nm">${esc(i.name)} <span class="tk">${esc(i.ticker)} · ${esc(i.listing)}</span></div>
      <div>${pill(i.action, ACTION_TONE[i.action])} <span class="tk">${esc(i.theme)} · ${esc(i.role)}</span></div></div>
      <div class="score">${fmt(score10(i))}</div></div>
      ${opts.link && i.link ? `<div class="cat">${esc(i.link)}</div>` : ""}
      <div class="trig">${esc(body)}</div>
      <div class="cat">Next: ${esc(i.catalystDate)} · ${esc(i.catalyst)}</div>
      <div class="more"><dl class="kv">
        <dt>Thesis</dt><dd>${esc(i.thesis)}</dd><dt>Key risk</dt><dd>${esc(i.risk)}</dd>
        ${i.link ? `<dt>Link to leader</dt><dd>${esc(i.link)}</dd>` : ""}
        <dt>Trigger</dt><dd>${esc(i.trigger)}</dd><dt>Buying from UK</dt><dd>${esc(i.uk)}</dd><dt>Scores</dt><dd>${esc(scores)}</dd>
      </dl></div></div>`;
  }

  function bars(items) {
    return `<div class="card bars">${items.map((i) => `<div class="b"><div class="lbl">${esc(i.name)}</div>
      <div class="track"><div class="fill" data-w="${score10(i)}"></div></div><div class="v">${fmt(score10(i))}</div></div>`).join("")}</div>`;
  }

  function scatter(pts, xName, yName, x0, x1, y0, y1, sized) {
    const Wd = 340, H = 250, L = 30, R = 10, T = 10, B = 30;
    const sx = (v) => L + (v - x0) / (x1 - x0) * (Wd - L - R), sy = (v) => H - B - (v - y0) / (y1 - y0) * (H - T - B);
    let g = "";
    for (let v = x0; v <= x1; v += (x1 - x0) / 5) g += `<line class="ax" x1="${sx(v)}" x2="${sx(v)}" y1="${T}" y2="${H - B}"/><text x="${sx(v)}" y="${H - B + 12}" text-anchor="middle">${+v.toFixed(1)}</text>`;
    for (let v = y0; v <= y1; v += (y1 - y0) / 6) g += `<line class="ax" x1="${L}" x2="${Wd - R}" y1="${sy(v)}" y2="${sy(v)}"/><text x="${L - 4}" y="${sy(v) + 3}" text-anchor="end">${+v.toFixed(1)}</text>`;
    const dots = pts.map((p) => {
      const r = sized ? 2 + p.size * 0.7 : 4.5;
      return `<circle class="d${THEMES.indexOf(p.series)}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${r.toFixed(1)}" fill-opacity="0.8"/>
      <text class="lab" x="${(sx(p.x) + r + 1.5).toFixed(1)}" y="${(sy(p.y) + 3).toFixed(1)}">${esc(p.label)}</text>`;
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

  const V = {
    Focus() {
      const act = [...ranked.filter((i) => i.action === "Buy" || i.action === "Accumulate on dips").slice(0, 6),
        ...ranked.filter((i) => i.action === "Trim" || i.action === "Avoid")];
      const b = asOfDate(), e = new Date(b); e.setDate(e.getDate() + 7);
      const n7 = D.catalysts.filter((c) => c.date >= iso(b) && c.date <= iso(e));
      return `<h2>Act now</h2>${act.map((i) => ideaCard(i)).join("")}
      <div class="grid2"><div><h2>What changed</h2>${list(D.changes.map((c) => ({ lead: c.date, title: c.what, detail: c.soWhat, pill: pill(c.impact, IMPACT_TONE[c.impact]) })))}</div>
      <div><h2>Next 7 days</h2>${list(n7.map((c) => ({ lead: c.label, title: c.event, detail: `${c.type} · ${c.why}` })))}</div></div>
      <h2>Conviction and risk-reward</h2><h3>Top 10 by overall score</h3>${bars(ranked.slice(0, 10))}
      <h3>Overall score vs safety</h3>${scatter(D.ideas.map((i) => ({ x: i.s.r, y: score10(i) / 10, label: i.ticker, series: i.theme })), "Risk score (higher = safer)", "Overall score", 0, 10, 3, 9)}
      ${D.notes.conviction ? `<div class="note">${esc(D.notes.conviction)}</div>` : ""}
      <h2>Market backdrop</h2><div class="card"><dl class="kv">${D.marketBackdrop.map((m) => `<dt>${esc(m.label)}</dt><dd>${esc(m.value)}</dd>`).join("")}</dl></div>`;
    },
    Scoreboard() {
      const groups = ["All", ...THEMES, "Second-order", "Near peak"].map((g) => [g, g, g === "All" ? D.ideas.length : D.ideas.filter((i) => i.theme === g || i.role === g).length]);
      const board = D.ideas.filter((i) => (st.group === "All" || i.theme === st.group || i.role === st.group) && (st.action === "All" || i.action === st.action))
        .sort((a, b) => { const av = st.sort === "overall" ? score10(a) : a.s[st.sort] * 10, bv = st.sort === "overall" ? score10(b) : b.s[st.sort] * 10; return bv - av || byScore(a, b); });
      let rows;
      if (st.cols === "Scores") rows = `<div class="card"><table class="simple"><tr><th>Idea</th><th>All</th>${FACTORS.map((f) => `<th>${f.short}</th>`).join("")}</tr>
        ${board.map((i) => `<tr><td>${esc(i.name)}</td><td><b>${fmt(score10(i))}</b></td>${FACTORS.map((f) => `<td>${i.s[f.key]}</td>`).join("")}</tr>`).join("")}</table></div>`;
      else if (st.cols === "Thesis") rows = board.map((i) => ideaCard(i, { body: i.thesis })).join("");
      else if (st.cols === "How to buy") rows = board.map((i) => ideaCard(i, { body: i.uk })).join("");
      else rows = board.map((i) => ideaCard(i, { link: true })).join("");
      return `<h2>Idea scoreboard</h2>${chips("group", groups)}
        <div class="selects">${select("action", "Action", [["All", "All"], ...ACTIONS.map((a) => [a, a])])}
        ${select("sort", "Sort", [["overall", "Overall score"], ...FACTORS.map((f) => [f.key, f.label])])}</div>
        ${chips("cols", ["Decision", "Scores", "Thesis", "How to buy"])}
        ${board.length ? rows : `<div class="card muted">No ideas match these filters.</div>`}
        <h2>Momentum vs valuation</h2>${scatter(board.map((i) => ({ x: i.s.v, y: i.s.m, label: i.ticker, size: score10(i) / 10, series: i.theme })), "Valuation score (higher = cheaper)", "Momentum", 0, 10, 0, 10, true)}
        <h3>Factor heatmap (top 12 shown)</h3><div class="card"><table class="heat"><tr><th></th>${FACTORS.map((f) => `<th>${f.short}</th>`).join("")}</tr>
        ${board.slice(0, 12).map((i) => `<tr><td>${esc(i.name)}</td>${FACTORS.map((f) => `<td class="h h${i.s[f.key]}">${i.s[f.key]}</td>`).join("")}</tr>`).join("")}</table></div>
        <h2>How the score works</h2><div class="card"><table class="simple"><tr><th>Factor</th><th>Weight</th><th>High score means</th></tr>
        ${FACTORS.map((f) => `<tr><td>${esc(f.label)}</td><td>${W[f.key]}%</td><td>${esc(f.what)}</td></tr>`).join("")}</table></div>
        ${D.notes.actions ? `<div class="note">${esc(D.notes.actions)}</div>` : ""}`;
    },
    Themes() {
      const t = st.theme, s = D.themeStances[t]; const inT = (r) => ranked.filter((i) => i.theme === t && i.role === r);
      const sec = (h, r, o) => inT(r).length ? `<h2>${h}</h2>${inT(r).map((i) => ideaCard(i, o)).join("")}` : "";
      return `${chips("theme", THEMES.map((x) => [x, x, D.ideas.filter((i) => i.theme === x).length]))}
        <h2>Theme stance</h2><div class="card"><dl class="kv"><dt>Stance</dt><dd>${pill(s.stance, STANCE_TONE[s.stance])}</dd>
        <dt>Why</dt><dd>${esc(s.line)}</dd><dt>What would flip it</dt><dd>${esc(s.flip)}</dd></dl></div>
        ${sec("Core ideas", "Core")}${sec("Second-order plays", "Second-order", { link: true })}${sec("Leaders near peak", "Near peak")}
        <h2>What moved</h2>${linkList(D.news[t] || [])}`;
    },
    Crypto() {
      return `<h2>Regulation tracker</h2>${D.cryptoRegs.map((r) => `<div class="card"><div class="row1"><b>${esc(r.j)} · ${esc(r.measure)}</b></div>
        <div class="cat">${pill(r.direction, DIR_TONE[r.direction])} <span class="tk">${esc(r.status)}</span></div>
        <div class="trig small">${esc(r.next)}</div><div class="det muted small">Moves: ${esc(r.impact)}</div></div>`).join("")}
        ${D.notes.cryptoNetRead ? `<div class="note">${esc(D.notes.cryptoNetRead)}</div>` : ""}
        <h2>Crypto ideas</h2>${ranked.filter((i) => i.theme === "Crypto").map((i) => ideaCard(i)).join("")}
        <h2>Crypto news</h2>${linkList(D.news.Crypto || [])}`;
    },
    Calendar() {
      const rows = D.catalysts.filter((c) => st.cal === "All" || c.type === st.cal);
      const months = [...new Set(D.catalysts.map((c) => c.date.slice(0, 7)))].sort();
      if (!months.includes(st.month)) months.unshift(st.month);
      return `<h2>Catalyst list</h2>${chips("cal", ["All", "Earnings", "Policy", "Central bank", "Crypto"])}
        ${D.notes.calendarCaption ? `<div class="muted small">${esc(D.notes.calendarCaption)}</div>` : ""}
        ${list(rows.map((c) => ({ lead: c.label, title: c.event, detail: `${c.type} · ${c.why}` })))}
        <h2>Month view</h2>${chips("month", months.sort().map((m) => [m, MONTHS[+m.slice(5) - 1] + " " + m.slice(0, 4)]))}${monthGrid(st.month)}`;
    },
    Sources() {
      const all = [...D.sources, ...THEMES.flatMap((t) => D.news[t] || [])];
      return `<h2>Sources (${all.length})</h2>${linkList(all)}`;
    },
  };

  function render() {
    const wl = FACTORS.map((f) => `${f.short} ${W[f.key]}%`).join(", ");
    $("#view").innerHTML = `<div class="note"><b>Research, not regulated financial advice.</b> As of ${esc(D.asOf)}. Overall score (1–10) = ${esc(wl)}. Risk: higher = lower risk.</div>`
      + V[st.view]() + `<div class="foot">Tap an idea for thesis, risk and how to buy · 🔒 locks this device</div>`;
    document.querySelectorAll(".fill[data-w]").forEach((el) => { el.style.width = el.dataset.w + "%"; });
    document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === st.view));
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  tryRemembered().then((ok) => { if (!ok) $("#pass").focus(); });
})();
