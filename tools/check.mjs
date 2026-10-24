// 全 JS の構文チェック（content scripts は classic script として、他は module として）
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(n)) files.push(p);
  }
};
walk(root);
const tmp = mkdtempSync(join(tmpdir(), "tfcheck-"));
let bad = 0;
for (const f of files) {
  const classic = /[\\/]content[\\/]/.test(f);
  let target = f;
  if (classic) {
    // classic script を CJS として検査（import/export を含まないことも同時に保証）
    target = join(tmp, f.replace(/[\\/:]/g, "_") + ".cjs");
    writeFileSync(target, readFileSync(f, "utf8"));
  }
  const r = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
  if (r.status !== 0) {
    bad++;
    console.log(`✗ ${f}\n${r.stderr}`);
  } else console.log(`✓ ${f}`);
}
JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
console.log("✓ manifest.json");
if (bad) process.exit(1);
