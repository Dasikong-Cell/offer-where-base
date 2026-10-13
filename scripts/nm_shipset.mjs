#!/usr/bin/env node
/**
 * nm_shipset.mjs -- work out exactly which node_modules entries the DELIVERED package needs.
 *
 * WHY THIS EXISTS
 * ---------------
 * pack.ps1 used to archive `node_modules` as a whole directory (tar recursed into it).
 * By 2026-10-12 that tree had grown to 1025 MB / 501 top-level entries -- but only 197 of
 * them are reachable from the code an end user actually runs. The other 304 entries
 * (711 MB: the whole `src/` React development stack plus its transitive tree) were being
 * downloaded by every recipient for nothing: the shipped app renders `public/console.html`
 * (Tauri's frontendDist is `../public`, and `src/` is in pack.ps1's $forbidden list), so
 * nothing in the archive ever imports `tdesign-react`, `mermaid`, `cherry-markdown` or `vite`.
 *
 * WHY A DERIVED SHIP SET AND NOT A HAND-WRITTEN DROP LIST
 * ------------------------------------------------------
 * A hand-written list rots, and its failure mode is silent breakage for the recipient.
 * Measured evidence (2026-10-12): a hand list drafted from an "is anything importing this?"
 * scan omitted `ws` -- which `server/services/browserHealth.ts` imports at runtime, so every
 * recipient's CDP browser health check would have died, and `pack_smoke.ps1` probes
 * ping/health/quota/connections/selfcheck/console, i.e. it does not cover that path.
 * It also missed `date-fns`, `rxjs`, `katex`, `jsdom` and `@codemirror`.
 *
 * So the ship set is computed, not listed:
 *   roots   = every external package the shipped code imports (scanned, not typed)
 *           + EXTRA_ROOTS for packages invoked by path rather than by import
 *   closure = roots + their transitive `dependencies` / `optionalDependencies`
 *   ship    = that closure, as top-level node_modules entries
 *
 * TWO FAIL-CLOSED GUARDS (both were written because the alternative is a package that
 * starts on the author's machine and is broken on the recipient's):
 *   1. Every root must resolve inside node_modules. A root that is missing means shipped
 *      code imports something `npm ci` did not install -> the artifact would be broken.
 *   2. Non-vacuity: the scan must have found a plausible number of files and packages, and
 *      a fixed set of known-critical packages must be among the roots. Guard 1 alone is
 *      satisfied by "the scan found nothing", which would ship a node_modules of ~nothing.
 *
 * NOTE ON "0 imports found"
 * -------------------------
 * A package with zero import hits is NOT proof it is unused: it may be a transitive
 * dependency of something that IS used (`pdfjs-dist` <- `pdf-parse@2.4.5`). That is exactly
 * why the closure step is mandatory and why this script never emits a "drop this" list.
 *
 * USAGE
 *   node scripts/nm_shipset.mjs --out <path.json>   # machine-readable, for pack.ps1
 *   node scripts/nm_shipset.mjs --print             # human summary, no file written
 *   node scripts/nm_shipset.mjs --root <dir> [--nm <dir>]   # scan another tree (base edition)
 *
 * Human output goes to stdout/stderr; the JSON is written to --out so callers never have to
 * parse a mixed stream.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// --root / --nm (2026-10-12, base-edition packing): the FULL edition packs this repo's own
// tree, so the defaults are exactly the old behaviour. The BASE edition packs
// _tools/core_split/_public/ -- a generated tree with NO node_modules of its own -- so the
// scan root and the package-resolution root have to be separable:
//   --root <dir>  where the shipped code lives (scanned)
//   --nm <dir>    which node_modules to resolve/close over (defaults to <root>/node_modules)
// Base mode therefore passes --root _public --nm <this repo's node_modules>: the base tree
// imports a SUBSET of what the full tree imports (core files are import-less stubs there),
// so every base specifier resolves against the full install. Omitting --nm would make the
// scan resolve against a node_modules that does not exist and report everything missing.
function argVal(name) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const ROOT = path.resolve(argVal('--root') || path.resolve(HERE, '..'));
const NM = path.resolve(argVal('--nm') || path.join(ROOT, 'node_modules'));

/**
 * Packages the shipped code invokes BY PATH rather than by import, so a specifier scan
 * cannot see them. Keep this list minimal and justified -- it is the one hand-maintained
 * piece left, and every entry needs a reason.
 */
const EXTRA_ROOTS = [
  // server/index.ts:1719 spawns:  process.execPath, ['node_modules/tsx/dist/cli.mjs',
  // 'scripts/ocr_wechat_jd.ts', ...]  -- the OCR subprocess. The root launchers
  // (start_server.bat / start_all.bat) do the same to boot the server itself.
  'tsx',
];

/** Directories whose files are executed by a recipient. Mirrors pack.ps1's shipped set. */
const SHIP_DIRS = ['server', 'shared', 'public', 'scripts'];
const SHIP_EXTS = new Set(['.ts', '.mts', '.mjs', '.js', '.cjs', '.html', '.htm', '.css']);

/** Node builtins: never packages, must not be looked up in node_modules. */
const BUILTINS = new Set(('assert,async_hooks,buffer,child_process,cluster,console,constants,' +
  'crypto,dgram,diagnostics_channel,dns,domain,events,fs,http,http2,https,inspector,module,net,' +
  'os,path,perf_hooks,process,punycode,querystring,readline,repl,stream,string_decoder,sys,' +
  'timers,tls,trace_events,tty,url,util,v8,vm,wasi,worker_threads,zlib,node:test,test,sqlite')
  .split(',').map((s) => s.trim()));

/**
 * Valid npm name segments. Used to reject the false positives a looser "quoted
 * module-looking string" rule produced: `public/vendor/pdfjs/pdf.worker.min.mjs`
 * contains plain strings that look like specifiers, and `scripts/contract_tests.ts` holds
 * regex escapes such as `\.\/services\/authToken\.js`.
 *
 * Scoped names need the scope pattern too -- an earlier version validated every segment
 * against NAME_SEG, which rejects the leading `@`, so EVERY scoped package silently
 * disappeared from the ship set. The non-vacuity guard is what caught it (it demanded
 * `@tencent-ai/agent-sdk` and the scan could not produce it).
 */
const NAME_SEG = /^[a-z0-9~][a-z0-9\-._~]*$/i;
const SCOPE_SEG = /^@[a-z0-9~][a-z0-9\-._~]*$/i;

/**
 * Import positions only -- `from "X"`, `import("X")`, `require("X")`, `import "X"`.
 * Both quote styles, because the first version of this scan used `from '...'` (single
 * quote) while the codebase writes `from "@tencent-ai/agent-sdk"` (double quote), which
 * produced the false conclusion "@tencent-ai is referenced nowhere, drop it" -- for a
 * 148 MB package that `server/index.ts:3` needs before the server can boot.
 */
const SPEC_RE = new RegExp(
  [
    // groups 1,2
    String.raw`\b(?:import|export)\b[\s\S]{0,600}?\bfrom\s*(['"\`])([^'"\`]+)\1`,
    // groups 3,4 -- the backreference must be \3, not \1: \1 did not participate in this
    // branch, and in JS an unmatched backreference matches the EMPTY string, so `\1` here
    // would silently stop requiring the closing quote.
    String.raw`\b(?:import|require)\s*\(\s*(['"\`])([^'"\`]+)\3`,
    // groups 5,6
    String.raw`\bimport\s+(['"\`])([^'"\`]+)\5`,
  ].join('|'),
  'g',
);

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    if (!e.isFile()) continue;
    if (e.name.endsWith('.d.ts') || e.name.endsWith('.tsbuildinfo')) continue;
    if (!SHIP_EXTS.has(path.extname(e.name).toLowerCase())) continue;
    out.push(p);
  }
}

/** `/foo-bar/baz/qux` -> `/foo-bar/baz`; `express/lib/x` -> `express`. */
function topLevel(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isCandidateSpec(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return false;
  if (spec.includes('://') || spec.startsWith('data:') || spec.startsWith('node:')) return false;
  const top = topLevel(spec);
  if (top.startsWith('@')) {
    const parts = top.split('/');
    return parts.length === 2 && SCOPE_SEG.test(parts[0]) && NAME_SEG.test(parts[1]);
  }
  return NAME_SEG.test(top);
}

/**
 * Builtin, but only if it is NOT also an installed package. Some builtin names are also
 * real npm packages (`buffer`, `test`, `process`); filtering on the name alone would drop
 * them from the ship set whenever the shipped code imports the PACKAGE.
 */
function isBuiltinOnly(name) {
  if (!BUILTINS.has(name)) return false;
  return !fs.existsSync(path.join(NM, name));
}

function pkgJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(NM, name, 'package.json'), 'utf8')); }
  catch { return null; }
}

/**
 * Strip comments before scanning. This is the repository's own discipline for anything that
 * reads source text ("凡断言扫源码，先剥注释"), and it bit this scanner immediately:
 * scripts/selftest.ts:157 is a Chinese comment containing `import \`server/db.js\``, which
 * the specifier regex happily matched and then tried to resolve as a package named "server".
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // `//` line comments, but not the `//` in `https://`
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * `server/db.js` is not a package. A specifier that names an existing path in the repo is a
 * path reference (usually inside a template string or a doc snippet), never a dependency.
 */
function isRepoPath(spec) {
  return fs.existsSync(path.join(ROOT, spec));
}

/**
 * Deliberately-absent dependencies. Every entry needs a reason, and the guard below fails
 * if an entry stops being referenced (a rotted allow-list is how a real breakage hides).
 */
const ALLOW_UNRESOLVED = new Map([
  ['pinyin-pro',
    'scripts/gen_city_pinyin.cjs -- one-off city-pinyin generator; its header documents ' +
    '`npm i pinyin-pro` in a scratch dir + NODE_PATH, and says it is intentionally not a ' +
    'runtime dependency. City names are already generated into cityData.ts.'],
]);

function declaredNames() {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return new Set([...Object.keys(pj.dependencies || {}), ...Object.keys(pj.devDependencies || {})]);
  } catch { return new Set(); }
}

// ---------------------------------------------------------------- 1. scan shipped code
const scanFiles = [];
for (const d of SHIP_DIRS) walk(path.join(ROOT, d), scanFiles);

/** specifier -> Set of "relpath" that mentions it. */
const specifiers = new Map();
for (const f of scanFiles) {
  let txt;
  try { txt = stripComments(fs.readFileSync(f, 'utf8')); } catch { continue; }
  SPEC_RE.lastIndex = 0;
  let m;
  while ((m = SPEC_RE.exec(txt))) {
    const spec = m[2] ?? m[4] ?? m[6];
    if (!isCandidateSpec(spec)) continue;
    if (isRepoPath(spec)) continue;           // path reference, not a package
    if (!specifiers.has(spec)) specifiers.set(spec, new Set());
    specifiers.get(spec).add(path.relative(ROOT, f).replace(/\\/g, '/'));
  }
}

/** top-level name -> { example, dirs:Set, installed:boolean } */
const derivedRoots = new Map();
for (const [spec, files] of specifiers) {
  const top = topLevel(spec);
  if (isBuiltinOnly(top) || isBuiltinOnly(spec)) continue;
  let entry = derivedRoots.get(top);
  if (!entry) {
    entry = { example: `${[...files][0]}  (${spec})`, dirs: new Set(), installed: !!pkgJson(top) };
    derivedRoots.set(top, entry);
  }
  for (const f of files) entry.dirs.add(f.split('/')[0]);
}

// -- stale allow-list guard: an allow entry nothing references any more is hiding rot.
const staleAllows = [...ALLOW_UNRESOLVED.keys()].filter((n) => !derivedRoots.has(n));
if (staleAllows.length) {
  console.error('[error] ALLOW_UNRESOLVED entries are no longer referenced by any shipped file:');
  for (const n of staleAllows) console.error(`   - ${n}  (was: ${ALLOW_UNRESOLVED.get(n).split(' -- ')[0]})`);
  console.error('        remove the entry (or fix the scan) -- a rotted allow-list hides breakage.');
  process.exit(4);
}

// -- guard: a root that is imported by the PRODUCT surface must resolve.
//   server/ shared/ public/ = what a recipient actually runs -> missing = broken artifact.
//   scripts/ only            = the CLI capability surface; a one-off generator may need a
//                              package that was never a project dependency (see the allow-list).
//   Either way nothing is silently ignored: script-only misses are reported as warnings.
const unresolved = [];
for (const [name, info] of derivedRoots) {
  if (info.installed || ALLOW_UNRESOLVED.has(name)) continue;
  unresolved.push({ name, ...info, critical: ['server', 'shared', 'public'].some((d) => info.dirs.has(d)) });
}
const fatal = unresolved.filter((u) => u.critical);
if (fatal.length) {
  console.error('[error] shipped PRODUCT code imports packages node_modules does not hold.');
  console.error('        The package would start here and break on the recipient\'s machine.');
  for (const u of fatal) console.error(`   - ${u.name}   (${u.example})`);
  console.error('        fix: declare it in package.json and re-run `npm ci`.');
  process.exit(3);
}
const unresolvedWarn = unresolved.filter((u) => !u.critical).sort((a, b) => a.name.localeCompare(b.name));

const roots = new Set([...derivedRoots.keys(), ...EXTRA_ROOTS]);

// ---------------------------------------------------------------- 2. non-vacuity guard
// Guard 1 below is satisfied by "the scan found nothing at all", which would ship an empty
// node_modules with every assertion green. These fixed expectations make that impossible.
const MUST_FIND = ['express', 'better-sqlite3', 'playwright', '@tencent-ai/agent-sdk'];
const vacuity = [];
if (scanFiles.length < 100) vacuity.push(`scanned only ${scanFiles.length} files (expected >=100)`);
if (derivedRoots.size < 8) vacuity.push(`found only ${derivedRoots.size} external packages (expected >=8)`);
for (const name of MUST_FIND) if (!derivedRoots.has(name)) {
  vacuity.push(`"${name}" is imported by the shipped code but the scan did not see it`);
}
if (vacuity.length) {
  console.error('[error] nm_shipset scan looks vacuous -- refusing to emit a ship set:');
  for (const v of vacuity) console.error('   - ' + v);
  process.exit(2);
}

// EXTRA_ROOTS are hand-written, so they get the same fail-closed treatment: a path-invoked
// package that is not installed breaks the artifact just as surely as a missing import.
const missingExtra = EXTRA_ROOTS.filter((r) => !pkgJson(r));
if (missingExtra.length) {
  console.error('[error] EXTRA_ROOTS entries are not installed: ' + missingExtra.join(', '));
  console.error('        these are invoked by path at runtime -- the artifact would break.');
  process.exit(3);
}

// ---------------------------------------------------------------- 4. closure
const closure = new Set();
const absentTransitive = new Set();
const queue = [...roots];
while (queue.length) {
  const name = queue.shift();
  const key = name.toLowerCase();
  if (closure.has(key)) continue;
  const pj = pkgJson(name);
  if (!pj) { absentTransitive.add(name); continue; }
  closure.add(key);
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pj[field] || {})) {
      if (!closure.has(dep.toLowerCase())) queue.push(dep);
    }
  }
}
// Platform-specific optional packages are legitimately absent (fsevents, @esbuild/linux-*,
// @napi-rs/canvas-darwin-*) -- npm only installs the current platform's. Not an error.
const nonOptionalAbsent = [...absentTransitive].filter((n) => {
  for (const c of closure) {
    const pj = pkgJson(c);
    if (pj && pj.optionalDependencies && pj.optionalDependencies[n]) return true;
  }
  return false;
});

// ---------------------------------------------------------------- 5. ship set vs disk
const diskEntries = fs.readdirSync(NM, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name);

const shipEntries = [];
const scopeChildren = new Set();
for (const name of diskEntries) {
  if (name.startsWith('@')) {
    for (const sub of fs.readdirSync(path.join(NM, name))) {
      if (closure.has(`${name}/${sub}`.toLowerCase())) { shipEntries.push(`${name}/${sub}`); scopeChildren.add(name); }
    }
  } else if (closure.has(name.toLowerCase())) {
    shipEntries.push(name);
  }
}
// A scope directory we ship from is itself a member (`node_modules/@scope/name`); a scope
// directory we ship nothing from must not appear at all.
shipEntries.sort();

const dropped = diskEntries.filter((n) => !shipEntries.includes(n) && !scopeChildren.has(n));

function dirsize(p) {
  let total = 0, files = 0, js = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) stack.push(q);
      else if (e.isFile()) {
        try { total += fs.statSync(q).size; files++; } catch { /* raced */ }
        if (q.toLowerCase().endsWith('.js')) js++;
      }
    }
  }
  return { total, files, js };
}

const MB = 1048576;
let shipBytes = 0, shipFiles = 0, shipJs = 0;
const shipDetail = [];
for (const e of shipEntries) {
  const s = dirsize(path.join(NM, e));
  shipBytes += s.total; shipFiles += s.files; shipJs += s.js;
  shipDetail.push({ name: e, diskMB: +(s.total / MB).toFixed(2) });
}
let dropBytes = 0;
const dropDetail = [];
for (const e of dropped) {
  const s = dirsize(path.join(NM, e));
  dropBytes += s.total;
  dropDetail.push({ name: e, diskMB: +(s.total / MB).toFixed(2), hasPackageJson: fs.existsSync(path.join(NM, e, 'package.json')) });
}
dropDetail.sort((a, b) => b.diskMB - a.diskMB || a.name.localeCompare(b.name));

// The archive-level reverse assertion pack.ps1 runs ("the prune really happened"): the
// largest dropped entry must be absent from the archive. Without it, an enumeration bug
// that silently fell back to archiving the whole directory stays green.
const verifyAbsent = dropDetail.find((d) => d.hasPackageJson) ?? dropDetail[0] ?? null;

const declared = declaredNames();
// allow-listed packages are declared-absent BY DESIGN, so reporting them as "undeclared"
// would contradict the allow-list entry right next to it.
const undeclaredRoots = [...roots].filter((r) => !declared.has(r) && !ALLOW_UNRESOLVED.has(r)).sort();

const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  roots: { derived: [...derivedRoots.keys()].sort(), extra: EXTRA_ROOTS },
  closureSize: closure.size,
  entries: shipEntries,
  verifyAbsent: verifyAbsent ? { name: verifyAbsent.name, diskMB: verifyAbsent.diskMB } : null,
  stats: {
    scannedFiles: scanFiles.length,
    distinctSpecifiers: specifiers.size,
    shipEntryCount: shipEntries.length,
    shipDiskMB: +(shipBytes / MB).toFixed(1),
    shipDiskFiles: shipFiles,
    shipDiskJs: shipJs,
    droppedEntryCount: dropped.length,
    droppedDiskMB: +(dropBytes / MB).toFixed(1),
  },
  warnings: {
    undeclaredRoots,
    unresolvedScriptOnly: unresolvedWarn.map((u) => `${u.name}  (${u.example})`),
    allowedUnresolved: [...ALLOW_UNRESOLVED.keys()],
    absentTransitiveNotOptional: nonOptionalAbsent.sort(),
    // Kept for human review; never used to decide what to drop.
    topDropped: dropDetail.slice(0, 15),
    topShip: shipDetail.sort((a, b) => b.diskMB - a.diskMB).slice(0, 15),
  },
};

const outIdx = process.argv.indexOf('--out');
if (outIdx !== -1 && process.argv[outIdx + 1]) {
  // ASCII-only on purpose: the consumer is pack.ps1, i.e. PowerShell 5.1, whose Get-Content
  // falls back to the ANSI code page (GBK on a zh-CN box) for a BOM-less file. The report
  // carries `root` -- the checkout path, which contains the author's CJK account name -- and
  // GBK is double-byte, so those bytes get paired up with whatever follows them. Escaping
  // non-ASCII keeps the file byte-identical in meaning under any reader, so the consumer's
  // default encoding stops being a variable at all.
  //
  // Honest scope (2026-10-12): this was NOT proven to be the cause of the one observed
  // "output unusable" failure -- feeding a real-CJK copy of this same report to PS 5.1's
  // default reader parsed fine, because the byte GBK eats is the backslash itself, which
  // leaves the JSON valid. The proven defect there was diagnosability (three distinct
  // failure modes collapsed into one message); pack.ps1 now separates them.
  const json = JSON.stringify(report, null, 2).replace(
    /[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  fs.writeFileSync(process.argv[outIdx + 1], json, 'utf8');
}

if (process.argv.includes('--print') || outIdx === -1) {
  const s = report.stats;
  console.log(`scanned        : ${s.scannedFiles} shipped files, ${s.distinctSpecifiers} distinct specifiers`);
  console.log(`roots          : ${report.roots.derived.length} derived + ${EXTRA_ROOTS.join(', ')}`);
  console.log(`closure        : ${report.closureSize} packages`);
  console.log(`ship           : ${s.shipEntryCount} entries, ${s.shipDiskMB} MB, ${s.shipDiskFiles} files (${s.shipDiskJs} .js)`);
  console.log(`drop           : ${s.droppedEntryCount} entries, ${s.droppedDiskMB} MB`);
  console.log(`verifyAbsent   : ${verifyAbsent ? `${verifyAbsent.name} (${verifyAbsent.diskMB} MB)` : 'none'}`);
  if (undeclaredRoots.length) {
    console.log(`[warn] imported but NOT declared in package.json: ${undeclaredRoots.join(', ')}`);
    console.log('       (works today only because a dependency hoists it -- declare it)');
  }
  if (unresolvedWarn.length) {
    console.log('[warn] imported by scripts/ but not installed:');
    for (const u of unresolvedWarn) console.log(`       ${u.name}  <- ${u.example}`);
  }
  if (nonOptionalAbsent.length) console.log(`[warn] required deps absent from disk: ${nonOptionalAbsent.join(', ')}`);
  console.log('\nlargest shipped:');
  for (const d of report.warnings.topShip) console.log(`   ${String(d.diskMB).padStart(8)} MB  ${d.name}`);
  console.log('largest dropped:');
  for (const d of report.warnings.topDropped) console.log(`   ${String(d.diskMB).padStart(8)} MB  ${d.name}`);
}
