# Invest Intel (private PWA)

Mobile-first, installable dashboard. The published site contains **only an encrypted payload** (`data.enc.json`):
AES-256-GCM, key derived in the browser with PBKDF2-SHA256 (600,000 iterations, random 16-byte salt, fresh 12-byte IV each build).
Without the passcode the site shows only a lock screen. `noindex` meta + `robots.txt` disallow all.

## Layout
- Repo root = the published app shell (no data): `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, `icons/`, `robots.txt`, plus `data.enc.json`.
  `tooling/sw.template.js` is `sw.js` before the build stamps its cache version. The build machine keeps these under `src/`.
- `tooling/scripts/extract-data.mjs` canvas source → `data.json` (plaintext, **gitignored**)
- `tooling/build.mjs` `data.json` → `site/` (encrypted, publishable). Reads the passcode only from `$DASHBOARD_PASSCODE`.
- Repo root = published site (GitHub Pages serves `/`), refreshed by copying `site/*`.

## Daily refresh
1. Save the canvas source (ReadCanvas) to `canvas-source.txt`
2. `node scripts/extract-data.mjs canvas-source.txt data.json`
3. `node build.mjs data.json` (needs `DASHBOARD_PASSCODE` in the environment; never pass it on the command line)
4. Push the files in `site/` to the repo root.

The salt is reused across builds so remembered devices stay unlocked; run `node build.mjs data.json --new-salt` after changing the passcode.

PNG icons are stored as `icons/*.png.b64` (the deploy connector only accepts text); the `Decode icons` workflow turns them into `icons/*.png` on push.
