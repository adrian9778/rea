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

const DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum|abstract\s+class)\b/;
// The body extent of a declaration is the run of lines up to the next sibling
// declaration at the same (or shallower) indentation. Brace counting alone is
// not usable for TS: an arrow function's return type is itself an object literal.
function extent(lines, sigIdx, lang) {
  if (lang === "indent" || lang === "key" || lang === "text") {
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
  const baseIndent = lines[sigIdx].match(/^\s*/)[0].length;
  // The body starts at the first `{` that appears with no parameter list still
  // open — `f(input: { … })` and `f = ({ a }) =>` both put a `{` on the
  // signature line that belongs to a *type* or a destructuring pattern, not to
  // the body. Tracking parenthesis depth across the wrapped signature finds it.
  let paren = 0;
  let bodyStart = -1;
  let bodyCol = -1;
  for (let i = sigIdx; i < Math.min(sigIdx + 40, lines.length); i++) {
    let opensCol = -1;
    for (let k = 0; k < lines[i].length; k++) {
      const ch = lines[i][k];
      if (ch === "(") paren++;
      else if (ch === ")") paren--;
      else if (ch === "{") { if (paren === 0) opensCol = k; }
      else if (ch === "}") { if (paren === 0) opensCol = -1; }
    }
    if (paren < 0) break;
    if (paren === 0 && opensCol >= 0) {
      bodyStart = i;
      bodyCol = opensCol;
      break;
    }
    // A completed signature that does not open a brace, sitting at the
    // declaration's own indent, is a one-line body or a sibling declaration.
    const trimmed = lines[i].trim();
    if (i > sigIdx && paren === 0 && trimmed !== "" && opensCol < 0) {
      const indent = lines[i].match(/^\s*/)[0].length;
      if (indent <= baseIndent) break;
    }
  }
  if (bodyStart >= 0) {
    let depth = 0;
    for (let j = bodyStart; j < lines.length; j++) {
      // Counting begins at the brace that opened the body, so the `}` closing a
      // destructuring parameter on the same line cannot end the body early.
      for (let k = j === bodyStart ? bodyCol : 0; k < lines[j].length; k++) {
        const ch = lines[j][k];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0) return j;
    }
  }
  let end = lines.length - 1;
  for (let i = sigIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const indent = l.match(/^\s*/)[0].length;
    if (indent > baseIndent) continue;
    if (DECL_RE.test(l.trim())) {
      end = i - 1;
      while (end > sigIdx && /^\s*[)}\];]*\s*$/.test(lines[end])) end--;
      break;
    }
  }
  return end;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A file binds to a `函数：` anchor only across the short glue of one citation
// (`path.ts 函数：foo`). Long or punctuated gaps mean the filename was prose or a
// runtime artifact name, not the anchor's owner, so binding it would invent a
// false issue; those anchors are reported as `bare-anchor` instead.
const GLUE = "[^。；;、|`\\n]{0,6}?";
// `#name` is one lexeme whose left side is a non-word char, so \b cannot anchor it.
const symRe = (name) =>
  name.startsWith("#")
    ? new RegExp(`(^|[^A-Za-z0-9_])${esc(name)}([^A-Za-z0-9_]|$)`)
    : new RegExp(`\\b${esc(name)}\\b`);

// A statement-initial `name(` is either a method declaration or a bare call.
// Without an AST the reliable discriminators are: the parameter list closes on
// this line and the body brace follows it (`foo() {` / `foo(): T {`), the arrow
// form `name: (x) =>` / `name = (x) =>`, or a later line at the signature's own
// indent closes with `) {`.
function closesAsDefinition(lines, sigIdx) {
  const line = lines[sigIdx];
  if (/\)\s*(?::[^{]*)?\{/.test(line)) return true;
  if (/^[#A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>/.test(line.trim())) return true;
  const indent = line.match(/^\s*/)[0].length;
  // A multi-line signature ends at its own indent or shallower with `) {`.
  const closer = new RegExp(`^ {0,${indent}}\\)\\s*(?::[^{]*)?\\{`);
  for (let i = sigIdx + 1; i < Math.min(sigIdx + 30, lines.length); i++) {
    if (lines[i].trim() === "") continue;
    if (closer.test(lines[i])) return true;
  }
  return false;
}

// Declaration-shaped lines only. Call sites (`await this.#foo(...)`, `foo(bar)`)
// must not become the anchor origin, or every offset check downstream drifts.
function findDeclarations(lines, name, ext) {
  // Control-flow keywords read like `if (`, `for (` and would otherwise pass the
  // method-declaration shape test.
  if (
    /^(?:if|for|while|switch|catch|return|await|yield|new|else|do|try|typeof|function|const|let|var|class|interface|type|enum|delete|void|throw|case|default)$/.test(
      name,
    )
  )
    return [];
  const n = esc(name.replace(/^#/, ""));
  const pats = [];
  // Patterns whose match is unambiguously a declaration.
  const sure = [];
  if (ext === "py") {
    sure.push(new RegExp(`^(\\s*)(async )?def ${n}\\s*\\(`));
    sure.push(new RegExp(`^(\\s*)class ${n}\\b`));
    // Module-level (and local) bindings: `NAME = ...` or `NAME: T = ...`.
    sure.push(new RegExp(`^(\\s*)${n}\\s*(?::[^=\\n]+)?=`));
  } else if (ext === "json") {
    sure.push(new RegExp(`"${n}"\\s*:`));
  } else {
    const priv = name.startsWith("#") ? "#" : "";
    const bare = esc(name.replace(/^#/, ""));
    // TS methods and functions often carry a generic parameter list before the
    // parameter list itself (`withAdmittedAnalysis<Value>(`), so the name and
    // the `(` are not adjacent.
    sure.push(new RegExp(`^\\s*(?:export\\s+)?(?:(?:default|declare|abstract|async|public|private|protected|static|readonly|override)\\s+)*(?:const|let|var|function\\*?|class|interface|type|enum)\\s+${priv}${bare}\\b`));
    sure.push(new RegExp(`^\\s*(?:readonly\\s+)?${priv}${bare}\\s*=\\s*(?:async\\s*)?\\(?`));
    sure.push(new RegExp(`^\\s*(?:def|fun|fn)\\s+${priv}${bare}\\b`));
    // Java/C++/Napi: up to three leading modifier/type tokens before the name.
    // A leading control keyword makes it a call site, not a definition.
    // A leading control keyword makes it a call site, not a definition. `void`
    // is excluded from the list because it is a common C++ return type.
    const notCall = String.raw`(?!return\s|await\s|new\s|throw\s|typeof\s|yield\s|else\s|case\s|default\s|in\s|of\s|do\s|try\s|catch\s|if\s|for\s|while\s|switch\s|delete\s)`;
    sure.push(new RegExp(`^\\s*${notCall}(?:[A-Za-z_][\\w:<>*&\\[\\],.\\s]*\\s+){1,3}${priv}${bare}\\s*\\(`));
    pats.push(
      // A generic argument list may also spill onto the next line (`registerTool<`).
      new RegExp(`^\\s*(?:(?:public|private|protected|static|override|abstract|readonly)\\s+)*(?:async\\s+)?\\*?${priv}${bare}\\s*[<(]`),
      new RegExp(`^\\s*(?:readonly\\s+)?${priv}${bare}\\s*[?!]?\\s*:\\s*(?:async\\s*)?(?:\\(|[A-Za-z_$])`),
    );
  }
  const out = [];
  const push = (i) => {
    if (!out.includes(i)) out.push(i);
  };
  for (const p of sure) {
    for (let i = 0; i < lines.length; i++) if (p.test(lines[i])) push(i);
  }
  for (const p of pats) {
    for (let i = 0; i < lines.length; i++) {
      if (p.test(lines[i]) && closesAsDefinition(lines, i)) push(i);
    }
  }
  return out.sort((a, b) => a - b);
}

const results = [];
let unboundAnchorCount = 0;
const EXT = "(?:tsx|ts|mjs|cjs|json|mermaid|java|hpp|py|cc|md|js)";
const FILE_RE = String.raw`[A-Za-z0-9_./-]*[A-Za-z0-9_-]+\.(?:${EXT})\b`;
const anchorRe = new RegExp(`(${FILE_RE})${GLUE}函数：([#A-Za-z_][A-Za-z0-9_]*)\\s*(?:偏移：)?\\+?(\\d+)?`, "g");
const bareAnchorRe = /函数：([#A-Za-z_][A-Za-z0-9_]*)/g;
// An anchor may drop the `函数：` keyword and still carry `偏移：`. Those are the
// same claim written unverifiably, so match them too: either the symbol really
// is there and the offset gets checked, or the path swallows the match and the
// citation is reported as malformed.
const symOffsetRe = new RegExp(`(${FILE_RE})${GLUE}([#A-Za-z_][A-Za-z0-9_]*)\\s+偏移：\\+?(\\d+)?`, "g");
// `src/x.ts 偏移：+12` cites a file with no symbol: nothing can be verified.
// The glue for this rule refuses colons so a proper `file 函数：foo 偏移：` can
// never be mistaken for one.
const TIGHT_GLUE = "[^。；;、|`：:\\n]{0,6}?";
const noSymbolRe = new RegExp(`(${FILE_RE})${TIGHT_GLUE}偏移：`, "g");
const bareSymOffsetRe = /([#A-Za-z_][A-Za-z0-9_]*)\s+偏移：/g;
const EXT_TOKENS = new Set(["ts", "tsx", "js", "mjs", "cjs", "json", "py", "java", "cc", "hpp", "md", "mermaid"]);
// `Module：` labels a whole file (a script without exported symbols), not a
// symbol; `键路径：` labels a dotted configuration path. Neither may be treated
// as a declaration name, and a path introduced by `Module：` must not become a
// candidate file for the other anchors sharing the line.
const moduleRe = /Module：([A-Za-z0-9_./-]+)/g;
const MODULE_PATH_RE = String.raw`(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_-]+\.(?:${EXT})`;
const namedRe = /(?:Const|Type|Struct|Class)：([A-Za-z_][A-Za-z0-9_]*)/g;
// A named anchor may carry its own file in the same code span; that pairing has
// to resolve exactly like a `函数：` anchor, otherwise a cited file that does not
// exist passes silently.
const namedBoundRe = new RegExp(
  `(${FILE_RE})${GLUE}(?:Const|Type|Struct|Class)：([A-Za-z_][A-Za-z0-9_]*)`,
  "g",
);
const pathRe = new RegExp(`(${FILE_RE})`, "g");
const indexRe = /`([A-Za-z0-9_./-]+):((?:#)?[A-Za-z0-9_]+|\d+):(\d+)`/g;
// The trailing 源码索引 may also be written as bare lines in a fenced block.
const bareIndexRe = /^([A-Za-z0-9_./-]+\.[A-Za-z]+):((?:#)?[A-Za-z0-9_]+|\d+):(\d+)$/;
const srcCache = new Map();
const srcFiles = [];
const byBasename = new Map();
const SKIP_DIRS = new Set(["node_modules", "dist", "docs", "coverage", "build", "tmp"]);
const seen = new Set();
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || (e.isDirectory() && SKIP_DIRS.has(e.name))) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|cjs|py|java|cc|hpp|json)$/.test(e.name)) {
      if (seen.has(p)) continue;
      seen.add(p);
      srcFiles.push(p);
      const list = byBasename.get(e.name) ?? [];
      list.push(p);
      byBasename.set(e.name, list);
    }
  }
};
walk(resolve(repoRoot, "src"));
for (const extra of ["bridge", "scripts", "tests", "native"]) {
  const dir = resolve(repoRoot, extra);
  if (existsSync(dir)) walk(dir);
}
for (const e of readdirSync(repoRoot)) {
  const p = resolve(repoRoot, e);
  if (statSync(p).isFile() && /\.(json|jsonc|ts|js|mjs)$/.test(e)) {
    if (seen.has(p)) continue;
    seen.add(p);
    const list = byBasename.get(e) ?? [];
    list.push(p);
    byBasename.set(e, list);
  }
}
const uniqueBasename = (name) => {
  const list = byBasename.get(name);
  return list && list.length === 1 ? list[0] : undefined;
};
// Docs may cite a bare basename (`ProcessOwnership.ts 函数：X`) or a stale directory.
function resolveSourcePath(rel) {
  // Docs link out with `../../../x` (relative to this directory = repo root).
  const stripped = rel.replace(/^(?:\.\.\/)+/, "");
  // Build outputs are not in the working tree; a doc may still name them.
  if (stripped.startsWith("dist/") || stripped.startsWith("node_modules/")) return { abs: undefined, relocated: false, ignored: true };
  const direct = resolve(repoRoot, stripped);
  if (existsSync(direct) && statSync(direct).isFile()) return { abs: direct, relocated: false };
  const base = stripped.split("/").pop();
  const found = rel.includes("/")
    ? [...(byBasename.get(base) ?? [])].filter((p) => p.endsWith(`/${base}`))
    : byBasename.get(base) ?? [];
  if (found.length === 1) return { abs: found[0], relocated: true };
  return { abs: undefined, relocated: false };
}
const srcText = (abs) => {
  if (!srcCache.has(abs)) srcCache.set(abs, readFileSync(abs, "utf8").split("\n"));
  return srcCache.get(abs);
};
const textCache = new Map();
const srcJoined = (abs) => {
  if (!textCache.has(abs)) textCache.set(abs, srcText(abs).join("\n"));
  return textCache.get(abs);
};
const existsMemo = new Map();
function existsAnywhere(sym) {
  if (existsMemo.has(sym)) return existsMemo.get(sym);
  const p = symRe(sym);
  const found = srcFiles.some((f) => p.test(srcJoined(f)));
  existsMemo.set(sym, found);
  return found;
}
// Where is this symbol actually declared? Used to turn "not in the cited file"
// into an actionable pointer. Built from a one-pass index; a symbol the index
// missed still gets a full scan before being reported as undeclared.
let declIndex = null;
const NAME = "(#[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)";
const INDEX_PATS = [
  { pat: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class|interface|type|enum)\\s+${NAME}`) },
  // A bare `name(` at line start is only a declaration when its signature closes.
  { pat: new RegExp(`^\\s*(?:(?:public|private|protected|static|override|abstract|readonly)\\s+)*(?:async\\s+)?\\*?${NAME}\\s*[<(]`), needsClose: true },
  { pat: new RegExp(`^\\s*(?:readonly\\s+)?${NAME}\\s*\\??\\s*:\\s*(?:async\\s*)?(?:\\(|[A-Za-z_$])`) },
  { pat: new RegExp(`^\\s*(?:def|fun|fn)\\s+${NAME}\\b`) },
  { pat: new RegExp(`^\\s*class\\s+${NAME}\\b`) },
  { pat: new RegExp(`^\\s*"${NAME}"\\s*:`) },
];
function buildDeclIndex() {
  const index = new Map();
  for (const f of srcFiles) {
    if (f.includes(".test.") || f.endsWith(".fixture.ts")) continue;
    const rel = f.slice(repoRoot.length + 1);
    const lines = srcText(f);
    for (let i = 0; i < lines.length; i++) {
      for (const { pat, needsClose } of INDEX_PATS) {
        const m = lines[i].match(pat);
        if (!m) continue;
        if (needsClose && !closesAsDefinition(lines, i)) continue;
        const list = index.get(m[1]) ?? [];
        index.set(m[1], list);
        if (!list.includes(`${rel}:${i + 1}`)) list.push(`${rel}:${i + 1}`);
      }
    }
  }
  return index;
}
const whereDeclaredMemo = new Map();
function whereDeclared(sym) {
  if (whereDeclaredMemo.has(sym)) return whereDeclaredMemo.get(sym);
  declIndex ??= buildDeclIndex();
  let hits = (declIndex.get(sym) ?? []).slice(0, 3);
  if (hits.length === 0) {
    // Index patterns are an optimization, not the definition of a declaration.
    const found = [];
    for (const f of srcFiles) {
      if (f.includes(".test.") || f.endsWith(".fixture.ts")) continue;
      const lines = srcText(f);
      const first = findDeclarations(lines, sym, f.split(".").pop())[0];
      if (first !== undefined) {
        found.push(`${f.slice(repoRoot.length + 1)}:${first + 1}`);
        if (found.length >= 3) break;
      }
    }
    hits = found;
  }
  whereDeclaredMemo.set(sym, hits);
  return hits;
}

for (const f of files.filter((x) => !x.startsWith("00-"))) {
  const text = readFileSync(resolve(docDir, f), "utf8");
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const bound = [...line.matchAll(anchorRe)];
    const boundRanges = bound.map((m) => [m.index, m.index + m[0].length]);
    const inBound = (at, len) =>
      boundRanges.some(([s, e]) => at >= s && at + len <= e);
    const verified = [
      ...bound,
      ...[...line.matchAll(symOffsetRe)].filter((x) => !inBound(x.index, x[0].length)),
    ];
    const verifiedRanges = verified.map((m) => [m.index, m.index + m[0].length]);
    const inVerified = (at, len) =>
      verifiedRanges.some(([s, e]) => at >= s && at + len <= e);
    for (const m of verified) {
      const [, rel, sym, off] = m;
      const { abs, relocated, ignored } = resolveSourcePath(rel);
      if (!abs) {
        if (!ignored) results.push({ f, li: li + 1, kind: "missing-file", rel, sym, detail: rel });
        continue;
      }
      if (relocated) results.push({ f, li: li + 1, kind: "path-not-as-written", rel, sym, detail: `actual: ${abs.slice(repoRoot.length + 1)}` });
      const src = readFileSync(abs, "utf8").split("\n");
      const ext = abs.split(".").pop();
      const sigs = findDeclarations(src, sym, ext);
      if (sigs.length === 0) {
        results.push({ f, li: li + 1, kind: "symbol-not-found", rel, sym, detail: `${rel} has no declaration of ${sym}; declared at: ${whereDeclared(sym).join(" ") || "nowhere"}` });
        continue;
      }
      if (off !== undefined) {
        const n = Number(off);
        const lang = LANG_OF[ext] ?? "brace";
        const hits = sigs.filter((s) => s + n <= extent(src, s, lang));
        if (hits.length === 0) {
          const spans = sigs.map((s) => `${s + 1}..${extent(src, s, lang) + 1}`).join(" ");
          results.push({ f, li: li + 1, kind: "offset-out-of-body", rel, sym, detail: `+${n} (line ${sigs[0] + 1 + n}) lands past every ${sym} declaration body (${spans})` });
        }
      }
    }
    // A named anchor may pin its own file: verify that pairing resolves.
    const namedBoundSeen = new Set();
    for (const m of line.matchAll(namedBoundRe)) {
      if (inVerified(m.index, m[0].length)) continue;
      const [, rel, sym] = m;
      const key = `${rel}|${sym}`;
      if (namedBoundSeen.has(key)) continue;
      namedBoundSeen.add(key);
      const { abs, relocated, ignored } = resolveSourcePath(rel);
      if (!abs) {
        if (!ignored)
          results.push({
            f,
            li: li + 1,
            kind: "missing-file",
            rel,
            sym,
            detail: `${sym} cites ${rel}, which does not exist`,
          });
        continue;
      }
      if (relocated)
        results.push({ f, li: li + 1, kind: "path-not-as-written", rel, sym, detail: `actual: ${abs.slice(repoRoot.length + 1)}` });
      const src = readFileSync(abs, "utf8").split("\n");
      if (findDeclarations(src, sym, abs.split(".").pop()).length === 0) {
        results.push({
          f,
          li: li + 1,
          kind: "named-anchor-missing",
          rel,
          sym,
          detail: `${sym} not declared in ${rel}`,
        });
      }
    }
    // A citation that names a file but no symbol before `偏移：` cannot resolve.
    for (const m of line.matchAll(noSymbolRe)) {
      results.push({
        f,
        li: li + 1,
        kind: "anchor-without-symbol",
        rel: m[1],
        sym: "-",
        detail: `${m[1]} 偏移：… names a file but no symbol`,
      });
    }
    // Shorthand `name 偏移：+N` inherits the file named earlier in the prose; its
    // symbol still has to exist somewhere.
    for (const m of line.matchAll(bareSymOffsetRe)) {
      if (inVerified(m.index + m[0].indexOf(m[1]), m[1].length)) continue;
      if (EXT_TOKENS.has(m[1]) || line[m.index - 1] === ".") continue;
      const homes = whereDeclared(m[1]);
      if (homes.length > 0) {
        unboundAnchorCount++;
        continue;
      }
      results.push({
        f,
        li: li + 1,
        kind: "bare-anchor-unknown-symbol",
        rel: "-",
        sym: m[1],
        detail: `${m[1]} 偏移：… is not declared in any source file`,
      });
    }
    // A `函数：` anchor with no source file in its own citation cannot be
    // verified. The library's shorthand (a second anchor after the file was
    // named) is legitimate, so those are only counted; an anchor whose symbol
    // is declared nowhere is a real defect and gets reported.
    for (const m of line.matchAll(bareAnchorRe)) {
      if (inVerified(m.index, m[0].length)) continue;
      const sym = m[1];
      const homes = whereDeclared(sym);
      if (homes.length > 0) {
        unboundAnchorCount++;
        continue;
      }
      results.push({
        f,
        li: li + 1,
        kind: "bare-anchor-unknown-symbol",
        rel: "-",
        sym,
        detail: `${sym} is not declared in any source file`,
      });
    }
    // Const：/Type： anchors, resolved against a source file named on the same line
    const moduleTokens = [...line.matchAll(moduleRe)].map((m) => m[1]);
    for (const mod of moduleTokens) {
      if (!new RegExp(`^${MODULE_PATH_RE}$`).test(mod)) continue; // descriptive label, not a path
      const { abs, relocated, ignored } = resolveSourcePath(mod);
      if (!abs) {
        if (!ignored) results.push({ f, li: li + 1, kind: "missing-file", rel: mod, sym: mod, detail: `Module：${mod}` });
        continue;
      }
      if (relocated) results.push({ f, li: li + 1, kind: "path-not-as-written", rel: mod, sym: mod, detail: `actual: ${abs.slice(repoRoot.length + 1)}` });
    }
    const named = [...line.matchAll(namedRe)].map((m) => m[1]);
    const linePaths = [...line.matchAll(pathRe)]
      .map((p) => p[1])
      .filter((p) => !moduleTokens.includes(p));
    const srcCandidates = linePaths
      .filter((p) => !/\.(md|mermaid)$/.test(p))
      .map((p) => resolveSourcePath(p).abs)
      .filter(Boolean);
    for (const sym of named) {
      if (linePaths.length === 0) continue;
      if (srcCandidates.length === 0) continue;
      if (!srcCandidates.some((p) => symRe(sym).test(srcJoined(p)))) {
        results.push({ f, li: li + 1, kind: "named-anchor-missing", rel: srcCandidates.join(","), sym, detail: `${sym} not in ${srcCandidates.join(" | ")}` });
      }
    }
    // short anchors like runDeferred+6 when a file is named on the same line
    for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]{2,})\+\d+/g)) {
      const sym = m[1];
      if (srcCandidates.length > 0) {
        if (!srcCandidates.some((p) => symRe(sym).test(srcJoined(p)))) {
          results.push({ f, li: li + 1, kind: "short-anchor-missing-in-file", rel: srcCandidates.join(","), sym, detail: `${sym} not in ${srcCandidates.join(" | ")}` });
        }
      } else if (!existsAnywhere(sym)) {
        results.push({ f, li: li + 1, kind: "short-anchor-unknown-symbol", rel: "-", sym, detail: `${sym} not defined anywhere under src/` });
      }
    }
    // index form: path:symbol:line
    const indexMatches = [...line.matchAll(indexRe)];
    const bare = line.trim().match(bareIndexRe);
    if (bare) indexMatches.push(bare);
    for (const m of indexMatches) {
      const [, rel, sym, ln] = m;
      const { abs, relocated, ignored } = resolveSourcePath(rel);
      if (!abs) {
        if (!ignored) results.push({ f, li: li + 1, kind: "missing-file", rel, sym, detail: rel });
        continue;
      }
      if (relocated) results.push({ f, li: li + 1, kind: "index-path-not-as-written", rel, sym, detail: `actual: ${abs.slice(repoRoot.length + 1)}:${sym}:${ln}` });
      if (sym === "1") continue;
      const src = readFileSync(abs, "utf8").split("\n");
      const idx = Number(ln) - 1;
      if (idx < 0 || idx >= src.length) {
        results.push({ f, li: li + 1, kind: "line-out-of-range", rel, sym, detail: `${rel}:${ln} beyond EOF (${src.length} lines)` });
        continue;
      }
      if (!symRe(sym).test(src[idx])) {
        results.push({ f, li: li + 1, kind: "line-symbol-mismatch", rel, sym, detail: `${rel}:${ln} = "${src[idx].trim().slice(0, 70)}"` });
      }
    }
  }
}

const counts = {};
for (const r of results) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
console.log(`docs: ${files.length}  issues: ${results.length}`);
console.log(
  `anchors bound to a cited file were verified; ${unboundAnchorCount} used the 同文件 shorthand (symbol exists, offset not checked)`,
);
console.log(JSON.stringify(counts, null, 0));
for (const r of results) {
  console.log(`[${r.kind}] ${r.f}:${r.li} ${r.rel} ${r.sym ?? ""} — ${r.detail}`);
}
