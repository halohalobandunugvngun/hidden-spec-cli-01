// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line as a matching tier reads it (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in the file's lines at a tier, from `from` on. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const start = Math.max(0, from);
  for (let i = start; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at least once, with its occurrences. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A new line as tier 2 re-indents it (SPEC.md section 5). */
function reindentLine(line: string, p: string, f: string, tier: number): string {
  if (tier !== 2) return line;
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** N with its context lines taken from the file and its other lines re-indented. */
function buildReplacement(fileLines: string[], at: number, o: string[], n: string[], oCtx: boolean[], nCtx: boolean[], tier: number): string[] {
  const oCtxIdx: number[] = [];
  for (let j = 0; j < o.length; j++) if (oCtx[j]) oCtxIdx.push(j);
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = leadingWs(fileLines[at] ?? '');
  let k = 0;
  return n.map((line, j) => {
    if (nCtx[j]) {
      const idx = oCtxIdx[k]!;
      k += 1;
      return idx === undefined ? line : fileLines[at + idx]!;
    }
    return reindentLine(line, p, f, tier);
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moved: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk (SPEC.md section 6). */
interface Hunk {
  a: number;
  o: string[];
  n: string[];
  oCtx: boolean[];
  nCtx: boolean[];
  noEol: boolean;
  lastPlusNoEol: boolean;
  plus: string[];
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

function parseHunkBody(body: string[]): Omit<Hunk, 'a'> {
  const o: string[] = [];
  const n: string[] = [];
  const oCtx: boolean[] = [];
  const nCtx: boolean[] = [];
  const plus: string[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let j = 0; j < body.length; j++) {
    const l = body[j]!;
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push(t);
      oCtx.push(true);
      nCtx.push(true);
      lastCtxPlus = j;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
      oCtx.push(false);
    } else if (l.startsWith('+')) {
      const t = l.slice(1);
      n.push(t);
      nCtx.push(false);
      plus.push(t);
      lastCtxPlus = j;
      lastPlus = j;
    }
  }
  const noEol = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
  const lastPlusNoEol = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  return { o, n, oCtx, nCtx, noEol, lastPlusNoEol, plus };
}

/** Apply one hunk to a file's lines; d is the length drift of this section's earlier hunks. */
function applyHunk(f: FileLines, h: Hunk, d: number, strict: boolean, path: string): FileLines {
  if (h.o.length > 0) {
    const found = findTier(f.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const rep = buildReplacement(f.lines, best, h.o, h.n, h.oCtx, h.nCtx, found.tier);
    const lines = [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + h.o.length)];
    const toEnd = best + h.o.length === f.lines.length;
    return { lines, br: f.br, finalBreak: toEnd ? !h.noEol : f.finalBreak };
  }
  const at = Math.max(0, Math.min(h.a + d, f.lines.length));
  const lines = [...f.lines.slice(0, at), ...h.n, ...f.lines.slice(at)];
  const toEnd = at === f.lines.length;
  return { lines, br: f.br, finalBreak: toEnd ? !h.noEol : f.finalBreak };
}

function parseDiffPath(text: string): string {
  const up = text.split('\t')[0]!;
  return up.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function makeUnifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.create || oldP === '/dev/null';
    const isDelete = !isCreate && (sec.del || newP === '/dev/null');
    const paths: string[] = [];
    if (oldP !== null && oldP !== '/dev/null') paths.push(oldP);
    if (newP !== null && newP !== '/dev/null') paths.push(newP);
    for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
    if (isCreate) {
      const np = newP ?? oldP ?? '';
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastNoEol = false;
      for (const h of sec.hunks) {
        plus.push(...h.plus);
        if (h.plus.length > 0) lastNoEol = h.lastPlusNoEol;
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastNoEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP ?? newP ?? '';
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP ?? newP ?? '';
    const np = newP ?? oldP ?? '';
    if (op !== np) {
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let f = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        f = applyHunk(f, h, d, strict, op);
        d += h.n.length - h.o.length;
      }
      tree.now.set(op, null);
      tree.now.set(np, joinFile(f));
      tree.moved.push({ from: op, to: np });
      return;
    }
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    let f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyHunk(f, h, d, strict, op);
      d += h.n.length - h.o.length;
    }
    tree.now.set(op, joinFile(f));
  };
}

/** A unified diff patch (SPEC.md section 6) as edits. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  let create = false;
  let del = false;
  let hunks: Hunk[] = [];
  let inSection = false;
  let headerPhase = false;

  const finishSection = (): void => {
    if (!inSection) return;
    edits.push(makeUnifiedEdit({ oldPath: pairOld ?? renOld ?? gitOld, newPath: pairNew ?? renNew ?? gitNew, create, del, hunks }, strict));
    inSection = false;
    headerPhase = false;
    gitOld = null;
    gitNew = null;
    pairOld = null;
    pairNew = null;
    renOld = null;
    renNew = null;
    create = false;
    del = false;
    hunks = [];
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length).trimEnd();
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const cut = rest.indexOf(' b/');
      if (cut < 0) throw new Exit2(`error: parse ${i + 1}`);
      const x = rest.slice(2, cut);
      const y = rest.slice(cut + 3);
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      gitOld = x;
      gitNew = y;
      inSection = true;
      headerPhase = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!inSection || hunks.length > 0) {
        finishSection();
        inSection = true;
        headerPhase = true;
      }
      if (inSection && headerPhase) {
        pairOld = stripAB(parseDiffPath(l.slice(4)));
        pairNew = stripAB(parseDiffPath(lines[i + 1]!.slice(4)));
        i += 2;
        continue;
      }
    }
    if (inSection && headerPhase) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        headerPhase = false;
      } else if (l.startsWith('rename from ')) {
        if (renOld === null) renOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      } else if (l.startsWith('rename to ')) {
        if (renNew === null) renNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      } else if (l.startsWith('new file mode')) {
        create = true;
        i++;
        continue;
      } else if (l.startsWith('deleted file mode')) {
        del = true;
        i++;
        continue;
      } else {
        i++;
        continue;
      }
    }
    if (l.startsWith('@@')) {
      if (!inSection) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      hunks.push({ a, ...parseHunkBody(body) });
      continue;
    }
    i++;
  }
  finishSection();
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const p = leadingWs(oldLines[0]!);
    const ff = leadingWs(f.lines[at]!);
    const rep = newLines.map((l) => reindentLine(l, p, ff, found.tier));
    const lines = [...f.lines.slice(0, at), ...rep, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, finalBreak: f.finalBreak }));
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7) as edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(makeSREdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

/** One V4A chunk (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  oCtx: boolean[];
  nCtx: boolean[];
}

function finishVChunk(cur: { anchor: string | null; eof: boolean; body: { text: string; num: number }[] }): VChunk {
  const o: string[] = [];
  const n: string[] = [];
  const oCtx: boolean[] = [];
  const nCtx: boolean[] = [];
  for (const item of cur.body) {
    const l = item.text;
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push(t);
      oCtx.push(true);
      nCtx.push(true);
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
      oCtx.push(false);
    } else if (l.startsWith('+')) {
      n.push(l.slice(1));
      nCtx.push(false);
    }
  }
  return { anchor: cur.anchor, eof: cur.eof, o, n, oCtx, nCtx };
}

function parseV4AChunks(raw: { text: string; num: number }[]): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: { text: string; num: number }[] } | null = null;
  const isBody = (t: string): boolean => t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+');
  for (const item of raw) {
    const t = item.text;
    if (t.startsWith('@@')) {
      if (cur !== null) chunks.push(finishVChunk(cur));
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
    } else if (t === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${item.num + 1}`);
      cur.eof = true;
      chunks.push(finishVChunk(cur));
      cur = null;
    } else if (isBody(t)) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${item.num + 1}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(item);
    } else {
      throw new Exit2(`error: parse ${item.num + 1}`);
    }
  }
  if (cur !== null) chunks.push(finishVChunk(cur));
  return chunks;
}

function applyV4AChunk(f: FileLines, c: VChunk, cursor: number, strict: boolean, path: string): { f: FileLines; cursor: number } {
  let cur = cursor;
  if (c.anchor !== null) {
    let foundIdx = -1;
    for (const t of tiers(strict)) {
      for (let j = cur; j < f.lines.length; j++) {
        if (normLine(f.lines[j]!, t) === normLine(c.anchor, t)) { foundIdx = j; break; }
      }
      if (foundIdx >= 0) break;
    }
    if (foundIdx < 0) throw new Fail('no-match', path);
    cur = foundIdx + 1;
  }
  if (c.o.length === 0) {
    const at = c.eof ? f.lines.length : Math.min(cur, f.lines.length);
    const lines = [...f.lines.slice(0, at), ...c.n, ...f.lines.slice(at)];
    return { f: { lines, br: f.br, finalBreak: f.finalBreak }, cursor: at + c.n.length };
  }
  let chosen: { tier: number; at: number } | null = null;
  if (c.eof) {
    const endPos = f.lines.length - c.o.length;
    if (endPos >= cur && endPos >= 0) {
      for (const t of tiers(strict)) {
        if (occurrences(f.lines, c.o, t, endPos).includes(endPos)) { chosen = { tier: t, at: endPos }; break; }
      }
    }
    if (chosen === null) throw new Fail('no-match', path);
  } else {
    const found = findTier(f.lines, c.o, strict, cur);
    if (found === null) throw new Fail('no-match', path);
    chosen = { tier: found.tier, at: found.occ[0]! };
  }
  const rep = buildReplacement(f.lines, chosen.at, c.o, c.n, c.oCtx, c.nCtx, chosen.tier);
  const lines = [...f.lines.slice(0, chosen.at), ...rep, ...f.lines.slice(chosen.at + c.o.length)];
  return { f: { lines, br: f.br, finalBreak: f.finalBreak }, cursor: chosen.at + rep.length };
}

function makeV4AAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4ADelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4AUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const c of chunks) {
      const r = applyV4AChunk(f, c, cursor, strict, path);
      f = r.f;
      cursor = r.cursor;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moved.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

/** A V4A patch (SPEC.md section 8) as edits. */
function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        if (!blank(s) && !s.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        raw.push(s);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines = raw.map((s) => (s === '' ? '' : s.slice(1)));
      edits.push(makeV4AAdd(path, fileLines));
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const s = lines[i]!;
        if (blank(s)) { i++; continue; }
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(makeV4ADelete(path));
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const raw: { text: string; num: number }[] = [];
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        raw.push({ text: s, num: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const chunks = parseV4AChunks(raw);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(makeV4AUpdate(path, moveTo, chunks, strict));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moved];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moved = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of tree.moved) {
    const wasOld = tree.original(m.from);
    const nowOld = tree.get(m.from);
    const wasNew = tree.original(m.to);
    const nowNew = tree.get(m.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      rOld.add(m.from);
      rNew.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
