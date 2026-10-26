# Invest Intel (private PWA)

Mobile-first, installable dashboard. The published site contains **only an encrypted payload** (`data.enc.json`):
AES-256-GCM, key derived in the browser with PBKDF2-SHA256 (600,000 iterations, random 16-byte salt, fresh 12-byte IV each build).
Without the passcode the site shows only a lock screen. `noindex` meta + `robots.txt` disallow all. Strict CSP: the only runtime external
connections allowed are the three AI providers (`api.anthropic.com`, `api.openai.com`, `api.x.ai`), used only when the Analyst has a key;
price history, fundamentals and FX are fetched at build time and stored inside the encrypted payload.

## On-device data (never published)
- **Portfolio**: imported from broker CSVs (Trading 212, Freetrade, Hargreaves Lansdown, AJ Bell, Interactive Brokers, Coinbase, or any CSV
  via column mapping) or added by hand. **Analyst**: provider, model, API key and chat history.
- Stored in the browser's IndexedDB (`vault` store), each record AES-256-GCM encrypted with the same passcode-derived key. Records carry the
  salt they were sealed with; after a passcode change the app asks for the previous passcode once to re-encrypt them.
- Encrypted backup export/import (same passcode) moves holdings between iPhone, iPad and Mac. Backups never include the API key or chat.
- The Analyst sends the system prompt (dashboard data and/or portfolio, per the in-app toggles; "What's sent?" previews it) directly from
  the device to the chosen provider with the user's own key.

## Layout
- Repo root = the published app shell (no data): `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, `icons/`, `robots.txt`, plus `data.enc.json`.
  `tooling/sw.template.js` is `sw.js` before the build stamps its cache version. The build machine keeps these under `src/`.
- `scripts/extract-data.mjs`: canvas source → `data.json` (plaintext, **gitignored**)
- `scripts/fetch-market-data.mjs`: `market-symbols.json` → `market.json` (both **gitignored**; the symbol map reveals the watchlist).
  Sources: FT Markets (≈1y daily prices + key stats for shares/ETFs), Nasdaq (annual statements for US listings/ADRs), CoinGecko (crypto).
  FX: ECB reference rates via Frankfurter (`node scripts/fetch-market-data.mjs market-symbols.json market.json --fx-only` refreshes FX only).
  Anything unavailable is recorded in `market.json.missing` and shown as "Not available", never estimated.
- `build.mjs`: `data.json` + `market.json` (+ matching hints from `market-symbols.json`: `yahoo`, `alsoSymbols`, `aliases`) + `publish.json` (`{"schedule": "Weekdays ~7:00 UK"}`) → `site/` (encrypted). Reads the passcode only from `$DASHBOARD_PASSCODE`.
- GitHub Pages serves the **`gh-pages`** branch root; `main` mirrors it plus tooling.

## Daily refresh (routine)
1. Save the canvas source (ReadCanvas) to `canvas-source.txt`
2. `node scripts/extract-data.mjs canvas-source.txt data.json`
3. `node scripts/fetch-market-data.mjs market-symbols.json market.json`
4. `node build.mjs data.json` (needs `DASHBOARD_PASSCODE` in the environment; never pass it on the command line)
5. Push `site/data.enc.json` and `site/sw.js` to `gh-pages` (and `main`). Push the other shell files only when the app code changes
   (push `sw.js` last so the new service worker caches the new shell).

The build fails if any published file contains idea names, theses, matching aliases, listing symbols, something shaped like an API key,
or any file outside the app-shell allow-list.

The salt is reused across builds so remembered devices stay unlocked; run `node build.mjs data.json --new-salt` after changing the passcode.
Open apps pick up new data via Settings → "Check for new data" (on open / 15 min / 1 h / 4 h) with a prompt or auto-refresh.

PNG icons are stored as `icons/*.png.b64` (the deploy connector only accepts text); the `Decode icons` workflow turns them into `icons/*.png` on push.
