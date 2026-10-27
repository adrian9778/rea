#!/usr/bin/env node
// Link checker for docs/adrian/sourceReader: every relative .md link must resolve,
// and every heading target (#anchor) must exist in the destination file.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const docDir = resolve(process.argv[2] ?? "docs/adrian/sourceReader");
const files = readdirSync(docDir).filter((f) => f.endsWith(".md"));

const slug = (text) =>
  text
    .trim()
    .toLowerCase()
    .replace(/^#+\s*/, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

const headings = new Map();
for (const f of files) {
  const set = new Set();
  for (const line of readFileSync(resolve(docDir, f), "utf8").split("\n")) {
    if (/^#{1,6}\s/.test(line)) set.add(slug(line));
  }
  headings.set(f, set);
}

const linkRe = /\]\((?!https?:|file:)([^)\s#]+)(?:#([^)\s]+))?\)/g;
const bad = [];
for (const f of files) {
  const text = readFileSync(resolve(docDir, f), "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(linkRe)) {
      const [, target, frag] = m;
      if (!target) continue; // self-link
      const abs = resolve(dirname(resolve(docDir, f)), target);
      const base = target.split("/").pop();
      if (!existsSync(abs)) {
        bad.push({ f, li: i + 1, kind: "missing-file", target });
        continue;
      }
      if (frag && base.endsWith(".md") && headings.has(base)) {
        const decoded = decodeURIComponent(frag).toLowerCase();
        if (!headings.get(base).has(decoded)) {
          bad.push({ f, li: i + 1, kind: "missing-heading", target: `${target}#${frag}` });
        }
      }
    }
  }
}
// Group not-yet-written doc targets by numeric prefix so a naming disagreement is
// distinguishable from "this doc has not been written yet".
const pending = new Map();
const real = [];
for (const b of bad) {
  const m = /^(\d{2})-(.+)\.md$/.exec(b.target.split("/").pop() ?? "");
  if (b.kind === "missing-file" && m) {
    const set = pending.get(m[1]) ?? new Set();
    set.add(b.target);
    pending.set(m[1], set);
  } else real.push(b);
}
const conflicts = [...pending].filter(([, set]) => set.size > 1);
console.log(`files: ${files.length}  broken links: ${real.length}  pending prefixes: ${pending.size}  naming conflicts: ${conflicts.length}`);
for (const b of real) console.log(`[${b.kind}] ${b.f}:${b.li} -> ${b.target}`);
for (const [prefix, set] of conflicts) console.log(`[naming-conflict] ${prefix}: ${[...set].join(" | ")}`);
