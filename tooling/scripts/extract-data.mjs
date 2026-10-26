// Usage: node scripts/extract-data.mjs <canvas-source-file> [out=data.json]
// Slices the EDITABLE DATA block out of the canvas source, transpiles it, writes data.json.
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const [src = "canvas-source.txt", out = "data.json"] = process.argv.slice(2);
const text = fs.readFileSync(src, "utf8");
const START = "// ======================= EDITABLE DATA";
const END = "// ======================= LOGIC";
const a = text.indexOf(START), b = text.indexOf(END);
if (a < 0 || b < 0 || b < a) throw new Error("Data markers not found in " + src);
const block = text.slice(a, b) +
  "\nexport { asOf, weights, ideas, themeStances, changes, catalysts, news, cryptoRegs, marketBackdrop, sources };\n";
const js = ts.transpileModule(block, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inv-")), "d.mjs");
fs.writeFileSync(tmp, js);
const m = await import(pathToFileURL(tmp).href);
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
// Narrative lines (<Text>…</Text> and captions) from the LOGIC part, so no dashboard text lives in code.
const logic = text.slice(b);
const texts = [...logic.matchAll(/<Text>([^<{]+)<\/Text>/g)].map((x) => x[1].trim());
const caption = (logic.match(/heading="Catalyst list"[^>]*caption="([^"]+)"/) || [])[1] || "";
const notes = {
  conviction: texts.find((t) => /risk-reward/i.test(t)) || "",
  actions: texts.find((t) => /^Actions:/.test(t)) || "",
  cryptoNetRead: texts.find((t) => /^Net read/.test(t)) || "",
  calendarCaption: caption,
};
const data = { notes, asOf: m.asOf, weights: m.weights, ideas: m.ideas, themeStances: m.themeStances, changes: m.changes,
  catalysts: m.catalysts, news: m.news, cryptoRegs: m.cryptoRegs, marketBackdrop: m.marketBackdrop, sources: m.sources };
fs.writeFileSync(out, JSON.stringify(data, null, 1));
console.log(`Wrote ${out}: ${data.ideas.length} ideas, ${data.catalysts.length} catalysts, ${data.sources.length} sources`);
