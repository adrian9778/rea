#!/usr/bin/env node
// Anchor checker for docs/adrian/sourceReader.
// Verifies two anchor forms from 00-docs-style-guide.md:
//   1) `path/to/file.ext 函数：Name 偏移：+N`  (also `Name+0~+20`)
//   2) `path/to/file.ext:Name:N` in the trailing 源码索引 table
// Checks: file exists, symbol exists in file, offset within the symbol's body extent.

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";

const docDir = resolve(
  process.argv[2] ?? "docs/adrian/sourceReader",
);
const repoRoot = resolve(docDir, "../../..");

import { readdirSync } from "node:fs";
const files = [];
for (const f of readdirSync(docDir)) if (f.endsWith(".md")) files.push(f);

const LANG_OF = { ts: "brace", js: "brace", mjs: "brace", java: "brace", cc: "brace", cpp: "brace", hpp: "brace", py: "indent", json: "key", md: "text", mermaid: "text" };

function extent(lines, sigIdx, lang) {
  if (lang === "indent") {
    const baseIndent = lines[sigIdx].match(/^\s*/)[0].length;
    let end = sigIdx;
    for (let i = sigIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === "") continue;
      if (l.match(/^\s*/)[0].length <= baseIndent) break;
      end = i;
    }
    return end;
  }
  let depth = 0;
  let seen = false;
  let paren = 0;
  for (let i = sigIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(") paren++;
      else if (ch === ")") paren = Math.max(0, paren - 1);
      else if (paren === 0 && ch === "{") { depth++; seen = true; }
      else if (paren === 0 && ch === "}") depth--;
    }
    if (seen && depth <= 0) return i;
  }
  return lines.length - 1;
}

function findSymbol(lines, name, ext) {
  const pats = [];
  if (ext === "py") {
    pats.push(new RegExp(`^(\\s*)(async )?def ${name}\\s*\\(`));
    pats.push(new RegExp(`^(\\s*)class ${name}\\b`));
  } else if (ext === "json") {
    pats.push(new RegExp(`"${name}"\\s*:`));
  } else {
    pats.push(new RegExp(`\\b(function|class|const|let|var|async|export)\\b.*\\b${name}\\b`));
    pats.push(new RegExp(`\\b${name}\\s*[=(:]`));
    pats.push(new RegExp(`\\b(def|fun|fn)\\s+${name}\\b`));
    pats.push(new RegExp(`\\b(void|int|long|boolean|String|byte|\\w+[<>\\[\\]])\\s+${name}\\s*\\(`));
  }
  for (const p of pats) {
    for (let i = 0; i < lines.length; i++) if (p.test(lines[i])) return i;
  }
  return -1;
}

const results = [];
const EXT = "(?:tsx|ts|mjs|mermaid|json|java|hpp|py|cc|md|js)";
const anchorRe = new RegExp("([A-Za-z0-9_./-]+\\\\"+EXT+"\\\\b)[^。;|]{0,40}?函数：([A-Za-z_][A-Za-z0-9_]*)\\\\s*(?:偏移：)?\\\\+?(\\\\d+)?","g");
const namedRe = /(?:Const|Type|Module|Struct|Const|键路径)：([A-Za-z_][A-Za-z0-9_]*)/g;
const pathRe = new RegExp("([A-Za-z0-9_./-]*[A-Za-z0-9_-]+\\\\"+EXT+"\\\\b)","g");
const indexRe = /`([A-Za-z0-9_./-]+):([A-Za-z0-9_]+|\d+):(\d+)`/g;
const srcCache = new Map();
const srcFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|js|mjs|py|java|cc|hpp)$/.test(e.name)) srcFiles.push(p);
  }
};
walk(resolve(repoRoot, "src"));
const srcText = (abs) => {
  if (!srcCache.has(abs)) srcCache.set(abs, readFileSync(abs, "utf8").split("\n"));
  return srcCache.get(abs);
};
function existsAnywhere(sym) {
  const p = new RegExp(`\\b${sym}\\b`);
  for (const f of srcFiles) if (p.test(srcText(f).join("\n"))) return true;
  return false;
}

for (const f of files.filter((x) => !x.startsWith("00-"))) {
  const text = readFileSync(resolve(docDir, f), "utf8");
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const m of line.matchAll(anchorRe)) {
      const [, rel, sym, off] = m;
      const abs = resolve(repoRoot, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        results.push({ f, li: li + 1, kind: "missing-file", rel, sym, detail: rel });
        continue;
      }
      const src = readFileSync(abs, "utf8").split("\n");
      const ext = rel.split(".").pop();
      const sig = findSymbol(src, sym, ext);
      if (sig < 0) {
        results.push({ f, li: li + 1, kind: "symbol-not-found", rel, sym, detail: `${rel} has no ${sym}` });
        continue;
      }
      if (off !== undefined) {
        const n = Number(off);
        const end = extent(src, sig, LANG_OF[ext] ?? "brace");
        if (sig + n > end + 1) {
          results.push({ f, li: li + 1, kind: "offset-out-of-body", rel, sym, detail: `+${n} lands past body end (sig=${sig + 1}, end=${end + 1})` });
        }
      }
    }
    // Const：/Type： anchors, resolved against a path mentioned on the same line
    for (const m of line.matchAll(namedRe)) {
      const sym = m[1];
      const pathMatch = [...line.matchAll(pathRe)].map((p) => p[1]);
      if (pathMatch.length === 0) continue;
      const abs = resolve(repoRoot, pathMatch[0]);
      if (!existsSync(abs)) {
        if (pathMatch[0].includes("/")) results.push({ f, li: li + 1, kind: "missing-file", rel: pathMatch[0], sym, detail: pathMatch[0] });
        continue;
      }
      if (!new RegExp(`\\b${sym}\\b`).test(readFileSync(abs, "utf8"))) {
        results.push({ f, li: li + 1, kind: "named-anchor-missing", rel: pathMatch[0], sym, detail: `${sym} not in ${pathMatch[0]}` });
      }
    }
    // short anchors like runDeferred+6 when a file is named on the same line
    const linePaths = [...line.matchAll(pathRe)].map((p) => p[1]);
    for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]{2,})\+\d+/g)) {
      const sym = m[1];
      if (linePaths.length > 0) {
        const abs = resolve(repoRoot, linePaths[0]);
        if (existsSync(abs) && !new RegExp(`\\b${sym}\\b`).test(readFileSync(abs, "utf8"))) {
          results.push({ f, li: li + 1, kind: "short-anchor-missing-in-file", rel: linePaths[0], sym, detail: `${sym} not in ${linePaths[0]}` });
        }
      } else if (!existsAnywhere(sym)) {
        results.push({ f, li: li + 1, kind: "short-anchor-unknown-symbol", rel: "-", sym, detail: `${sym} not defined anywhere under src/` });
      }
    }
    // index form: path:symbol:line
    for (const m of line.matchAll(indexRe)) {
      const [, rel, sym, ln] = m;
      const abs = resolve(repoRoot, rel);
      if (!existsSync(abs)) {
        results.push({ f, li: li + 1, kind: "missing-file", rel, sym, detail: rel });
        continue;
      }
      if (sym === "1") continue;
      const src = readFileSync(abs, "utf8").split("\n");
      const idx = Number(ln) - 1;
      if (idx < 0 || idx >= src.length) {
        results.push({ f, li: li + 1, kind: "line-out-of-range", rel, sym, detail: `${rel}:${ln} beyond EOF (${src.length} lines)` });
        continue;
      }
      if (!new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(src[idx])) {
        results.push({ f, li: li + 1, kind: "line-symbol-mismatch", rel, sym, detail: `${rel}:${ln} = "${src[idx].trim().slice(0, 70)}"` });
      }
    }
  }
}

const counts = {};
for (const r of results) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
console.log(`docs: ${files.length}  issues: ${results.length}`);
console.log(JSON.stringify(counts, null, 0));
for (const r of results) {
  console.log(`[${r.kind}] ${r.f}:${r.li} ${r.rel} ${r.sym ?? ""} — ${r.detail}`);
}
