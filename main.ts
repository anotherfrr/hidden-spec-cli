// main.ts is mend, the CLI SPEC.md specifies (MIT starter, completed here): the command line, the output and
// exit codes, safe paths, format detection, the three-tier line matching of section 5, unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, [old, new], in the order the edits made them. */
  readonly moves: [string, string][] = [];
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

/** A file split into lines (SPEC.md section 3). */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/** Positions where O occurs in `lines` at one tier (SPEC.md section 5). */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const eq = tier === 0
    ? (a: string, b: string): boolean => a === b
    : tier === 1
      ? (a: string, b: string): boolean => trimEndWS(a) === trimEndWS(b)
      : (a: string, b: string): boolean => trimBothWS(a) === trimBothWS(b);
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!eq(lines[i + k]!, O[k]!)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which O occurs at least once (positions at or after `from`), or null. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** The replacement lines for a match of O at `pos` (SPEC.md section 5). */
function buildReplacement(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = O.length > 0 ? leadingWS(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadingWS(O[0]!) : '';
  return N.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    if (tier !== 2) return e.text;
    if (e.text === '' || /^[ \t]+$/.test(e.text)) return e.text;
    return e.text.startsWith(P) ? F + e.text.slice(P.length) : e.text;
  });
}

/** Read a file from the tree, or throw the failure for a missing/unsafe path. */
function readTreeFile(tree: Tree, p: string): string {
  if (!safe(p)) throw new Fail('unsafe', p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

/** Write a file's new text into the tree, keeping its own line break. */
function setTreeFile(tree: Tree, p: string, f: FileParts): void {
  tree.now.set(p, joinFile(f));
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface BodyLine {
    kind: 'ctx' | 'old' | 'new' | 'bs';
    text: string;
  }
  interface Hunk {
    a: number;
    body: BodyLine[];
  }
  interface Section {
    oldPath: string | null;
    newPath: string | null;
    /** A ---/+++ pair has named the paths of this section. */
    pair: boolean;
    create: boolean;
    del: boolean;
    hunks: Hunk[];
  }
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(.+) b\/(.+)$/;
  const cleanPath = (raw: string): string => {
    let p = raw.split('\t')[0]!.trim();
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    return p;
  };
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  /** Close the open hunk body, dropping trailing empty context lines. */
  const endBody = (): void => {
    if (curHunk !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') curHunk.body.pop();
        else break;
      }
    }
    curHunk = null;
  };
  const startSection = (oldP: string | null, newP: string | null, pair: boolean): Section => {
    endBody();
    const s: Section = { oldPath: oldP, newPath: newP, pair, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ') || line.startsWith('@@') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endBody();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line === '') curHunk.body.push({ kind: 'ctx', text: '' });
        else if (line[0] === ' ') curHunk.body.push({ kind: 'ctx', text: line.slice(1) });
        else if (line[0] === '-') curHunk.body.push({ kind: 'old', text: line.slice(1) });
        else if (line[0] === '+') curHunk.body.push({ kind: 'new', text: line.slice(1) });
        else curHunk.body.push({ kind: 'bs', text: line.slice(1) });
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!, false);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(curHunk);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = cleanPath(line.slice(4));
      const newP = cleanPath(lines[i + 1]!.slice(4));
      const o = oldP === '/dev/null' ? null : oldP;
      const n = newP === '/dev/null' ? null : newP;
      if (cur === null || cur.pair || cur.hunks.length > 0) {
        startSection(o, n, true);
      } else {
        cur.oldPath = o;
        cur.newPath = n;
        cur.pair = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && curHunk === null) {
      // Section header lines.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) { i += 1; continue; }
      if (line.startsWith('rename from ')) { if (!cur.pair) cur.oldPath = line.slice('rename from '.length).trim(); i += 1; continue; }
      if (line.startsWith('rename to ')) { if (!cur.pair) cur.newPath = line.slice('rename to '.length).trim(); i += 1; continue; }
      if (line.startsWith('new file mode')) { cur.create = true; i += 1; continue; }
      if (line.startsWith('deleted file mode')) { cur.del = true; i += 1; continue; }
      i += 1;
      continue;
    }
    i += 1;
  }
  endBody();
  return sections.map((s) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    return (tree: Tree): void => {
      const paths: string[] = [];
      if (oldP !== null) paths.push(oldP);
      if (newP !== null && newP !== oldP) paths.push(newP);
      for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
      const isCreate = s.create || (oldP === null && newP !== null);
      const isDelete = s.del || (newP === null && oldP !== null);
      const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
      if (isCreate) {
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        const out: string[] = [];
        let lastPlus: { h: (typeof s.hunks)[number]; idx: number } | null = null;
        for (const h of s.hunks) {
          h.body.forEach((b, bi) => {
            if (b.kind === 'new') { out.push(b.text); lastPlus = { h, idx: bi }; }
          });
        }
        const noEol = lastPlus !== null && lastPlus.idx + 1 < lastPlus.h.body.length && lastPlus.h.body[lastPlus.idx + 1]!.kind === 'bs';
        tree.now.set(newP!, out.length === 0 ? '' : out.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        tree.now.set(oldP!, null);
        return;
      }
      const target = isMove ? oldP! : (oldP ?? newP);
      if (target === null) return; // Degenerate section naming no file at all.
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
      let f = splitFile(before);
      let d = 0;
      for (const h of s.hunks) {
        const O: string[] = [];
        const N: NLine[] = [];
        const noEol = new Map<number, boolean>();
        h.body.forEach((b, bi) => {
          if (b.kind === 'bs') return;
          if (bi + 1 < h.body.length && h.body[bi + 1]!.kind === 'bs') noEol.set(bi, true);
        });
        let lastCtxOrNew = -1;
        h.body.forEach((b, bi) => {
          if (b.kind === 'ctx') { O.push(b.text); N.push({ text: b.text, ctx: true, oIdx: O.length - 1 }); lastCtxOrNew = bi; }
          else if (b.kind === 'old') O.push(b.text);
          else if (b.kind === 'new') { N.push({ text: b.text, ctx: false, oIdx: -1 }); lastCtxOrNew = bi; }
        });
        if (O.length === 0) {
          const at = Math.min(h.a + d, f.lines.length);
          const add = N.map((e) => e.text);
          f = { br: f.br, lines: [...f.lines.slice(0, at), ...add, ...f.lines.slice(at)], final: f.final };
          if (at === f.lines.length - add.length) {
            const bs = lastCtxOrNew >= 0 && noEol.get(lastCtxOrNew) === true;
            f = { ...f, final: !bs };
          }
        } else {
          const found = findTier(f.lines, O, strict);
          if (found === null) throw new Fail('no-match', target);
          const want = h.a - 1 + d;
          let best = found.occ[0]!;
          let bestDist = Math.abs(best - want);
          for (const o of found.occ) {
            const dist = Math.abs(o - want);
            if (dist < bestDist) { best = o; bestDist = dist; }
          }
          const rep = buildReplacement(f.lines, best, O, N, found.tier);
          const runsToEnd = best + O.length === f.lines.length;
          f = { br: f.br, lines: [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + O.length)], final: f.final };
          if (runsToEnd) {
            const bs = lastCtxOrNew >= 0 && noEol.get(lastCtxOrNew) === true;
            f = { ...f, final: !bs };
          }
        }
        d += N.length - O.length;
      }
      const out = joinFile(f);
      if (isMove) {
        tree.now.set(oldP!, null);
        tree.now.set(newP!, out);
        tree.moves.push([oldP!, newP!]);
      } else {
        tree.now.set(target, out);
      }
    };
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i;
    // Path: nearest line before SEARCH, after the previous block's REPLACE line,
    // that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    // Find ======= then >>>>>>> REPLACE after SEARCH.
    let sep = -1;
    let end = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchLine + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const N: NLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = buildReplacement(f.lines, pos, b.oldLines, N, found.tier);
    f.lines.splice(pos, b.oldLines.length, ...rep);
    setTreeFile(tree, b.path, f);
  });
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let k = lines.length - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) return k;
    return -1;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Chunk {
    anchor: string | null;
    eof: boolean;
    O: string[];
    N: NLine[];
  }
  interface Section {
    kind: 'add' | 'del' | 'update';
    path: string;
    moveTo: string | null;
    /** Add File lines: text, and whether the line came from a blank patch line. */
    lines: { text: string; blank: boolean }[];
    chunks: Chunk[];
    lineNo: number;
  }
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curChunk: Chunk | null = null;
  const endChunk = (): void => { curChunk = null; };
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isSectionStart(line)) {
      endChunk();
      const kind = line.startsWith('*** Add File:') ? 'add' : line.startsWith('*** Delete File:') ? 'del' : 'update';
      const path = line.slice(line.indexOf(':') + 1).trim();
      cur = { kind, path, moveTo: null, lines: [], chunks: [], lineNo: i + 1 };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (blank(line)) { i += 1; continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) { cur.lines.push({ text: line.slice(1), blank: false }); i += 1; continue; }
      if (blank(line)) { cur.lines.push({ text: '', blank: true }); i += 1; continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'del') {
      if (blank(line)) { i += 1; continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Update File section.
    if (line.startsWith('*** Move to:')) {
      if (cur.chunks.length === 0 && curChunk === null && cur.moveTo === null && cur.lines.length === 0) {
        cur.moveTo = line.slice('*** Move to:'.length).trim();
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (line === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
      curChunk.eof = true;
      endChunk();
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      endChunk();
      curChunk = { anchor: line.slice(2).trim(), eof: false, O: [], N: [] };
      if (curChunk.anchor === '') curChunk.anchor = null;
      cur.chunks.push(curChunk);
      i += 1;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (curChunk === null) {
        curChunk = { anchor: null, eof: false, O: [], N: [] };
        cur.chunks.push(curChunk);
      }
      if (line === '') { curChunk.O.push(''); curChunk.N.push({ text: '', ctx: true, oIdx: curChunk.O.length - 1 }); }
      else if (line[0] === ' ') { const t = line.slice(1); curChunk.O.push(t); curChunk.N.push({ text: t, ctx: true, oIdx: curChunk.O.length - 1 }); }
      else if (line[0] === '-') curChunk.O.push(line.slice(1));
      else curChunk.N.push({ text: line.slice(1), ctx: false, oIdx: -1 });
      i += 1;
      continue;
    }
    if (blank(line)) { i += 1; continue; }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  // Blank lines at the end of a section are not part of it. A `+` line (even one
  // with empty text) is a real file line and is never dropped; only lines that
  // came from blank patch lines go, as do trailing blank context lines.
  for (const s of sections) {
    if (s.kind === 'add') {
      while (s.lines.length > 0 && s.lines[s.lines.length - 1]!.blank) s.lines.pop();
    }
    if (s.kind === 'update') {
      const lastChunk = s.chunks[s.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.O.length > 0 && trimBothWS(lastChunk.O[lastChunk.O.length - 1]!) === '' && lastChunk.N.length > 0 && lastChunk.N[lastChunk.N.length - 1]!.ctx) {
          lastChunk.O.pop();
          lastChunk.N.pop();
        }
      }
    }
  }
  for (const s of sections) {
    if (s.kind === 'update' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
  }
  return sections.map((s) => (tree: Tree): void => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const texts = s.lines.map((l) => l.text);
      tree.now.set(s.path, texts.length === 0 ? '' : `${texts.join('\n')}\n`);
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const foundA = findTier(f.lines, [ch.anchor], strict, cursor);
        if (foundA === null) throw new Fail('no-match', s.path);
        cursor = foundA.occ[0]! + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const add = ch.N.map((e) => e.text);
        f.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      const found = findTier(f.lines, ch.O, strict, cursor);
      if (found === null) throw new Fail('no-match', s.path);
      let pos = -1;
      for (const o of found.occ) {
        if (ch.eof && o + ch.O.length !== f.lines.length) continue;
        pos = o;
        break;
      }
      if (pos < 0) throw new Fail('no-match', s.path);
      const rep = buildReplacement(f.lines, pos, ch.O, ch.N, found.tier);
      f.lines.splice(pos, ch.O.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  });
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [old, nw] of tree.moves) {
    const wasOld = tree.original(old);
    const wasNew = tree.original(nw);
    if (wasOld !== null && wasNew === null && tree.get(old) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      covered.add(old);
      covered.add(nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
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
