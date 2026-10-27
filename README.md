# Invest Intel (private PWA)

Mobile-first, installable dashboard. The published site contains **only an encrypted payload** (`data.enc.json`):
AES-256-GCM, key derived in the browser with PBKDF2-SHA256 (600,000 iterations, random 16-byte salt, fresh 12-byte IV each build).
Without the passcode the site shows only a lock screen. `noindex` meta + `robots.txt` disallow all. Strict CSP: the only runtime external
connections allowed are the three AI providers (`api.anthropic.com`, `api.openai.com`, `api.x.ai`), used only when the Analyst has a key;
price history, fundamentals and FX are fetched at build time and stored inside the encrypted payload.

## On-device data (never published)
- **Portfolio**: imported from broker CSVs (Trading 212, Freetrade, Hargreaves Lansdown, AJ Bell, Interactive Brokers, Coinbase, or any CSV
  via column mapping) or added by hand. **Analyst**: provider, model, API key, chat history and the last AI review. Review settings (risk profile, cap) live in the portfolio record.
- Stored in the browser's IndexedDB (`vault` store), each record AES-256-GCM encrypted with the same passcode-derived key. Records carry the
  salt they were sealed with; after a passcode change the app asks for the previous passcode once to re-encrypt them.
- Encrypted backup export/import (same passcode) moves holdings between iPhone, iPad and Mac. Backups never include the API key or chat.
- The Analyst sends the system prompt (dashboard data and/or portfolio, per the in-app toggles; "What's sent?" previews it) directly from
  the device to the chosen provider with the user's own key.
- **Import from screenshots**: Portfolio → Import → Screenshots (or paste on Mac / drag-and-drop). Up to 8 images are decoded and
  downscaled on the device (long edge 1600px, JPEG), sent only to the Analyst's chosen provider with the saved key (vision fallback:
  Claude Sonnet / GPT-6.1 Sol / Grok 4.7), and parsed from strict JSON. Rows are merged across screenshots, low-confidence cells are
  highlighted and unseen numbers are left blank (never estimated). Nothing is saved until the review is confirmed. Images live only in
  memory and are dropped after reading, on close and on lock; they are never written to IndexedDB, Cache Storage or localStorage.
  `img-src` allows `blob:` only for the HEIC/decoder fallback; thumbnails are canvases. HEIC works where the browser decodes it (Safari).
- **Holdings review** (Portfolio): a rules engine running on the device (no AI key) gives each holding one decision (Add, Hold, Trim,
  Sell or Review) with a target weight, the concrete change in money and shares, a one-line reason and a conviction level. It uses the
  dashboard's score, action and factor scores, the position's weight, P/L and cost, theme and currency exposure, and upcoming catalysts.
  Caps by score (Balanced 12/8/5% for 8+/7-8/6-7, below 6 exits; Aggressive ×1.25 is the default; Cautious ×⅔; optional custom top cap).
  Overweight lines are trimmed to the cap, Trim-rated lines are halved, Avoid-rated lines are sold, top scorers below 60% of the cap are
  added to 80% of it (not while their theme is above 35%), and low scorers with large gains take a quarter off. Unrated or unpriced
  holdings get Review. The full rules are shown in the app under "How sizing works".
- **AI review**: optional; sends the engine output, holdings sizes and dashboard ideas to the Analyst provider with the user's key and
  asks for a structured verdict per holding. Alternatives must come from the ideas list. The last review is cached AES-GCM encrypted
  (`review` vault record) with a timestamp; it's excluded from backups and deleted with "Delete … from this device".
- xAI uses the Responses API (`/v1/responses`, `store:false`); Anthropic uses Messages; OpenAI uses Chat Completions.

## Layout
- Repo root = the published app shell (no data): `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, `icons/`, `robots.txt`, plus `data.enc.json`.
  `tooling/sw.template.js` is `sw.js` before the build stamps its cache version. The build machine keeps these under `src/`.
- `scripts/extract-data.mjs`: canvas source → `data.json` (plaintext, **gitignored**)
- `scripts/fetch-market-data.mjs`: `market-symbols.json` → `market.json` (both **gitignored**; the symbol map reveals the watchlist).
  Sources: FT Markets (≈1y daily prices + key stats for shares/ETFs), Nasdaq (annual statements for US listings/ADRs), CoinGecko (crypto).
  FX: ECB reference rates via Frankfurter (`node scripts/fetch-market-data.mjs market-symbols.json market.json --fx-only` refreshes FX only).
  Anything unavailable is recorded in `market.json.missing` and shown as "Not available", never estimated.
- `build.mjs`: `data.json` + `market.json` (+ matching hints from `market-symbols.json`: `yahoo`, `alsoSymbols`, `aliases`) + `publish.json` (`{"schedule": "Weekdays ~7:00 UK"}`) → `site/` (encrypted). Reads the passcode only from `$DASHBOARD_PASSCODE`.
- `briefs/YYYY-MM-DD.md`: the daily morning brief (plaintext markdown, **gitignored, never committed**). `build.mjs` encrypts the latest 60
  into `data.enc.json` for the in-app **Brief** view. Override the folder with `BRIEFS_DIR=…`.
- GitHub Pages serves the **`gh-pages`** branch root; `main` mirrors it plus tooling.

## Daily brief file format
```
---
date: 2026-10-27
title: Invest Intel, Tue 27 Oct
headline: One line shown big at the top of the Brief view
asOf: 07:00 UK
---
## Top line
Markdown body: `##`/`###` headings, **bold**, *italic*, `-`/`1.` lists, [links](https://…) and bare https URLs.
## Score changes
- Example Co: 7.4 → 7.9 (why)        <- "Name: old → new" lines (→, ->, or "to") become tappable chips
## Your holding
...
```
- The file name must equal `date`; `title` and `headline` are required, otherwise the build skips the file with a warning.
- Raw HTML is not rendered (shown as text); links open in a new tab with `rel="noopener noreferrer"`.
- Idea names, aliases (4+ chars) and tickers in the text link to the idea; the "Your holdings today" panel cross-references
  names in the brief with the on-device portfolio (holdings never leave the device).

## Daily refresh (routine)
1. Save the canvas source (ReadCanvas) to `canvas-source.txt`
2. `node scripts/extract-data.mjs canvas-source.txt data.json`
3. `node scripts/fetch-market-data.mjs market-symbols.json market.json`
4. Write today's brief to `briefs/YYYY-MM-DD.md` (format above) — the exact text sent to Ben, including source links.
5. `node build.mjs data.json` (needs `DASHBOARD_PASSCODE` in the environment; never pass it on the command line)
6. Push `site/data.enc.json` and `site/sw.js` to `gh-pages` (and `main`). Never push or commit `briefs/`. Push the other shell files only when the app code changes
   (push `sw.js` last so the new service worker caches the new shell).

The build fails if any published file contains idea names, theses, brief titles/headlines/lines, matching aliases, listing symbols, something shaped like an API key,
or any file outside the app-shell allow-list.

The salt is reused across builds so remembered devices stay unlocked; run `node build.mjs data.json --new-salt` after changing the passcode.
Open apps pick up new data via Settings → "Check for new data" (on open / 15 min / 1 h / 4 h) with a prompt or auto-refresh.

PNG icons are stored as `icons/*.png.b64` (the deploy connector only accepts text); the `Decode icons` workflow turns them into `icons/*.png` on push.
