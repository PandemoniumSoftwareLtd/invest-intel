# Invest Intel (private PWA)

Mobile-first, installable dashboard. The published site contains **only an encrypted payload** (`data.enc.json`):
AES-256-GCM, key derived in the browser with PBKDF2-SHA256 (600,000 iterations, random 16-byte salt, fresh 12-byte IV each build).
Without the passcode the site shows only a lock screen. `noindex` meta + `robots.txt` disallow all. Strict CSP: no runtime external fetches;
price history and fundamentals are fetched at build time and stored inside the encrypted payload.

## Layout
- Repo root = the published app shell (no data): `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, `icons/`, `robots.txt`, plus `data.enc.json`.
  `tooling/sw.template.js` is `sw.js` before the build stamps its cache version. The build machine keeps these under `src/`.
- `tooling/scripts/extract-data.mjs`: canvas source → `data.json` (plaintext, **gitignored**)
- `tooling/scripts/fetch-market-data.mjs`: `market-symbols.json` → `market.json` (both **gitignored**; the symbol map reveals the watchlist).
  Sources: FT Markets (≈1y daily prices + key stats for shares/ETFs), Nasdaq (annual statements for US listings/ADRs), CoinGecko (crypto).
  Anything unavailable is recorded in `market.json.missing` and shown as "Not available", never estimated.
- `tooling/build.mjs`: `data.json` + `market.json` + `publish.json` (`{"schedule": "Weekdays ~7:00 UK"}`) → `site/` (encrypted). Reads the passcode only from `$DASHBOARD_PASSCODE`.
- GitHub Pages serves the **`gh-pages`** branch root; `main` mirrors it plus tooling.

## Daily refresh (routine)
1. Save the canvas source (ReadCanvas) to `canvas-source.txt`
2. `node scripts/extract-data.mjs canvas-source.txt data.json`
3. `node scripts/fetch-market-data.mjs market-symbols.json market.json`
4. `node build.mjs data.json` (needs `DASHBOARD_PASSCODE` in the environment; never pass it on the command line)
5. Push `site/data.enc.json` and `site/sw.js` to `gh-pages` (and `main`). Push the other shell files only when the app code changes.

The salt is reused across builds so remembered devices stay unlocked; run `node build.mjs data.json --new-salt` after changing the passcode.
Open apps pick up new data via Settings → "Check for new data" (on open / 15 min / 1 h / 4 h) with a prompt or auto-refresh.

PNG icons are stored as `icons/*.png.b64` (the deploy connector only accepts text); the `Decode icons` workflow turns them into `icons/*.png` on push.
