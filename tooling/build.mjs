// Usage: DASHBOARD_PASSCODE=… node build.mjs [data.json] [--new-salt]
// Also merges market.json (from scripts/fetch-market-data.mjs) and publish.json ({"schedule": "..."}) if present.
// Encrypts data.json (AES-256-GCM, key = PBKDF2-SHA256 of the passcode) into site/data.enc.json
// and copies the static app shell into site/. The passcode is read ONLY from the environment
// and is never printed, logged or written to disk.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const { webcrypto } = crypto; const subtle = webcrypto.subtle;
const args = process.argv.slice(2);
const dataPath = args.find((a) => !a.startsWith("--")) || "data.json";
const OUT = "site", SRC = "src", ITER = 600000;

const pass = process.env.DASHBOARD_PASSCODE;
if (!pass) { console.error("DASHBOARD_PASSCODE is not set; refusing to build."); process.exit(1); }

const base0 = JSON.parse(fs.readFileSync(dataPath, "utf8"));
if (fs.existsSync("market.json")) base0.market = JSON.parse(fs.readFileSync("market.json", "utf8"));
else console.warn("market.json not found: building without price history/fundamentals");
base0.publish = fs.existsSync("publish.json") ? JSON.parse(fs.readFileSync("publish.json", "utf8")) : { schedule: "Weekdays ~7:00 UK" };
base0.builtAt = new Date().toISOString();
const plain = JSON.stringify(base0);

// Reuse the existing random salt (so remembered devices stay unlocked across daily rebuilds)
// unless --new-salt is passed or there is no previous build. A fresh random IV is used every build.
let salt;
const prevPath = path.join(OUT, "data.enc.json");
if (!args.includes("--new-salt") && fs.existsSync(prevPath)) {
  try { const p = JSON.parse(fs.readFileSync(prevPath, "utf8")); if (p.iterations === ITER) salt = Buffer.from(p.salt, "base64"); } catch {}
}
if (!salt || salt.length !== 16) salt = webcrypto.getRandomValues(new Uint8Array(16));
const iv = webcrypto.getRandomValues(new Uint8Array(12));

const base = await subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
const key = await subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, base,
  { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
// self-check round trip
const back = new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
if (back !== plain) throw new Error("Round-trip check failed");

const b64 = (u) => Buffer.from(u).toString("base64");
const payload = { v: 1, kdf: "PBKDF2-SHA256", cipher: "AES-256-GCM", iterations: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };

// fresh site/ (keep nothing stale)
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(SRC, OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "data.enc.json"), JSON.stringify(payload));
const buildId = crypto.createHash("sha256").update(payload.ct + fs.readFileSync(path.join(SRC, "app.js"))).digest("hex").slice(0, 12);
const sw = path.join(OUT, "sw.js");
fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace("__BUILD__", buildId));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

// Guard: no plaintext from data.json may appear in any published file.
const probes = new Set();
const d = JSON.parse(plain);
for (const i of d.ideas) { probes.add(i.name); probes.add(i.thesis.slice(0, 30)); }
probes.add(d.asOf);
for (const a of Object.values(d.market?.assets || {})) { if (a.liveUrl) probes.add(a.liveUrl); if (a.stats?.url) probes.add(a.stats.url); }
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const f of walk(OUT)) {
  if (f.endsWith(".png")) continue;
  let txt = fs.readFileSync(f, "utf8");
  if (f.endsWith("data.enc.json")) {
    // Ciphertext is random base64 and can contain short words by chance; check its shape instead.
    const e = JSON.parse(txt);
    if (Object.keys(e).sort().join() !== "cipher,ct,iterations,iv,kdf,salt,v" || !/^[A-Za-z0-9+/=]+$/.test(e.ct)) throw new Error("Unexpected data.enc.json shape");
    txt = JSON.stringify({ ...e, ct: "" });
  }
  for (const p of probes) if (p && p.length > 3 && txt.includes(p)) throw new Error(`Plaintext leak in ${f}`);
  if (txt.includes(pass)) throw new Error(`Passcode leak in ${f}`);
}
console.log(`Built ${OUT}/ (build ${buildId}): ${d.ideas.length} ideas encrypted, ${ITER} PBKDF2 iterations, no plaintext found in published files.`);
