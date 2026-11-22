// Adversarial checks derived from SPEC.md sentences the practice set does not show.
// Each case: run node main.ts in a fresh dir, compare exit/stdout/files with hand-computed
// expectations from the spec. Usage: node advtest.mjs [name-substring...]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const MAIN = new URL('./main.ts', import.meta.url).pathname;

const cases = [];
const C = (name, argv, stdin, files, exit, stdout, changes) => cases.push({ name, argv, stdin, files, exit, stdout, changes });

const U1 = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n';
// 1-6: no-newline-at-EOF handling
C('u-noeol-replace', ['-'], U1 + '@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n', { 'f.txt': 'a\nb' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nc' });
C('u-noeol-ctx', ['-'], U1 + '@@ -1,2 +1,2 @@\n-a\n+x\n b\n\\ No newline at end of file\n', { 'f.txt': 'a\nb' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'x\nb' });
C('u-noeol-absent', ['-'], U1 + '@@ -1,2 +1,2 @@\n a\n-b\n+c\n', { 'f.txt': 'a\nb' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nc\n' });
C('u-noeol-mid', ['-'], U1 + '@@ -1,1 +1,1 @@\n-a\n+x\n', { 'f.txt': 'a\nb\nc' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'x\nb\nc' });
C('u-create-noeol', ['-'], 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n', {}, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'a\nb' });
C('u-create-eol', ['-'], 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n', {}, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'a\nb\n' });
// 7: deletion ignores hunks
C('u-delete-ignores-hunks', ['-'], 'diff --git a/g.txt b/g.txt\ndeleted file mode 100644\n--- a/g.txt\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-no such line\n-nope\n-no\n', { 'g.txt': 'real\ncontent\n' }, 0, 'D g.txt\nok: 1 file\n', { 'g.txt': null });
// 8-11: parse errors
C('u-header-parse', ['-'], 'diff --git a/x.txt b/x.txt\n--- a/x.txt\nindex 1234\n@@ -1,1 +1,1 @@\n-a\n+b\n', { 'x.txt': 'a\n' }, 2, 'error: parse 3\n', {});
C('u-diff-malformed', ['-'], 'diff --git a/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', { 'x.txt': 'a\n' }, 2, 'error: parse 1\n', {});
C('u-hunk-before-section', ['--format=unified', '-'], '@@ -1,1 +1,1 @@\n-a\n+b\n', { 'x.txt': 'a\n' }, 2, 'error: parse 1\n', {});
C('u-bad-hunk', ['-'], U1 + '@@ frobnicate @@\n-a\n+b\n', { 'f.txt': 'a\n' }, 2, 'error: parse 4\n', {});
// 12-14: empty-O inserts and d offset
C('u-insert-top', ['-'], U1 + '@@ -0,0 +1,2 @@\n+x\n+y\n', { 'f.txt': 'a\nb\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'x\ny\na\nb\n' });
C('u-insert-beyond-end', ['-'], U1 + '@@ -99,0 +100,1 @@\n+z\n', { 'f.txt': 'a\nb\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nb\nz\n' });
C('u-d-offset', ['-'], U1 + '@@ -1,1 +1,3 @@\n a\n+n1\n+n2\n@@ -2,1 +4,1 @@\n-b\n+z\n', { 'f.txt': 'a\nb\nc\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nn1\nn2\nz\nc\n' });
// 15-19: errors, moves, no-hunk sections
C('u-unsafe', ['-'], '--- a/../evil.txt\n+++ b/../evil.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', {}, 1, 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', {});
C('u-move-exists', ['-'], 'diff --git a/o.txt b/n.txt\nrename from o.txt\nrename to n.txt\n--- a/o.txt\n+++ b/n.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', { 'o.txt': 'a\n', 'n.txt': 'x\n' }, 1, 'error: exists n.txt\nfailed: 1 of 1 edits\n', {});
C('u-move-missing', ['-'], 'diff --git a/o.txt b/n.txt\nrename from o.txt\nrename to n.txt\n--- a/o.txt\n+++ b/n.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', {}, 1, 'error: missing o.txt\nfailed: 1 of 1 edits\n', {});
C('u-no-hunks-exists', ['-'], '--- a/f.txt\n+++ b/f.txt\n', { 'f.txt': 'a\n' }, 0, 'ok: 0 files\n', {});
C('u-no-hunks-missing', ['-'], '--- a/f.txt\n+++ b/f.txt\n', {}, 1, 'error: missing f.txt\nfailed: 1 of 1 edits\n', {});
C('u-rename-only', ['-'], 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', { 'old.txt': 'a\n' }, 0, 'R old.txt -> new.txt\nok: 1 file\n', { 'old.txt': null, 'new.txt': 'b\n' });
// 20-21: tier-2 re-indent corners
C('u-tier2-no-prefix', ['-'], '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n   function f() {\n     return 1;\n-  }\n+  } // done\n', { 'f.txt': 'function f() {\n  return 1;\n}\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'function f() {\n  return 1;\n} // done\n' });
C('u-tier2-empty-plus', ['-'], '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 @@\n   function f() {\n     return 1;\n-  }\n+\n+  } // done\n', { 'f.txt': 'function f() {\n  return 1;\n}\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'function f() {\n  return 1;\n\n} // done\n' });
// 22: body ends at diff --git
C('u-body-end-diff', ['-'], U1 + '@@ -1,1 +1,1 @@\n-a\n+b\ndiff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1,1 +1,1 @@\n-c\n+d\n', { 'f.txt': 'a\n', 'g.txt': 'c\n' }, 0, 'M f.txt\nM g.txt\nok: 2 files\n', { 'f.txt': 'b\n', 'g.txt': 'd\n' });
// 23: --- / +++ inside a body ends the body and starts a new section
C('u-body-end-triple', ['-'], U1 + '@@ -1,2 +1,2 @@\n a\n--- x.txt\n+++ y.txt\n', { 'f.txt': 'a\nb\n', 'x.txt': 'q\n' }, 0, 'R x.txt -> y.txt\nok: 1 file\n', { 'f.txt': 'a\nb\n', 'x.txt': null, 'y.txt': 'q\n' });
// S/R
C('s-no-path-first', ['-'], '<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n', {}, 2, 'error: parse 1\n', {});
C('s-second-no-path', ['-'], 'one.txt\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nc\n>>>>>>> REPLACE\n', { 'one.txt': 'a\n' }, 0, 'M one.txt\nok: 1 file\n', { 'one.txt': 'c\n' });
C('s-create-empty', ['-'], 'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n', {}, 0, 'A new.txt\nok: 1 file\n', { 'new.txt': '' });
C('s-tier2-reindent', ['-'], 'f.txt\n<<<<<<< SEARCH\n  return 1;\n=======\n  return 2;\n>>>>>>> REPLACE\n', { 'f.txt': 'function f() {\n    return 1;\n}\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'function f() {\n    return 2;\n}\n' });
C('s-no-sep', ['-'], 'f.txt\n<<<<<<< SEARCH\nfoo\n>>>>>>> REPLACE\n', { 'f.txt': 'foo\n' }, 2, 'error: parse 2\n', {});
C('s-no-end', ['-'], 'f.txt\n<<<<<<< SEARCH\nfoo\n=======\nbar\n', { 'f.txt': 'foo\n' }, 2, 'error: parse 2\n', {});
C('s-fence-path', ['-'], 'f.txt\n```txt\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n```\n', { 'f.txt': 'foo\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'bar\n' });
C('s-unsafe', ['-'], '../x.txt\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n', {}, 1, 'error: unsafe ../x.txt\nfailed: 1 of 1 edits\n', {});
C('s-ambiguous-tier1', ['-'], 'f.txt\n<<<<<<< SEARCH\nreturn 1; \n=======\nreturn 2;\n>>>>>>> REPLACE\n', { 'f.txt': 'return 1;\nreturn 1;\n' }, 1, 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', {});
// V4A
C('v-no-begin', ['--format=v4a', '-'], 'hello\n*** End Patch\n', {}, 2, 'error: parse 1\n', {});
C('v-no-end', ['-'], '*** Begin Patch\n*** Add File: a.txt\n+x\n', {}, 2, 'error: parse 4\n', {});
C('v-empty-format', ['--format=v4a', '-'], '', {}, 2, 'error: parse 1\n', {});
C('v-add-trailing-blank', ['-'], '*** Begin Patch\n*** Add File: a.txt\n+x\n+\n\n*** End Patch\n', {}, 0, 'A a.txt\nok: 1 file\n', { 'a.txt': 'x\n\n' });
C('v-add-mid-blank', ['-'], '*** Begin Patch\n*** Add File: a.txt\n+x\n\n+y\n*** End Patch\n', {}, 0, 'A a.txt\nok: 1 file\n', { 'a.txt': 'x\n\ny\n' });
C('v-move-only', ['-'], '*** Begin Patch\n*** Update File: o.txt\n*** Move to: n.txt\n*** End Patch\n', { 'o.txt': 'a\n' }, 0, 'R o.txt -> n.txt\nok: 1 file\n', { 'o.txt': null, 'n.txt': 'a\n' });
C('v-update-no-chunk', ['-'], '*** Begin Patch\n*** Update File: o.txt\n*** End Patch\n', { 'o.txt': 'a\n' }, 2, 'error: parse 2\n', {});
C('v-eof-no-chunk', ['-'], '*** Begin Patch\n*** Update File: o.txt\n*** End of File\n*** End Patch\n', { 'o.txt': 'a\n' }, 2, 'error: parse 3\n', {});
C('v-anchor-tier1', ['-'], '*** Begin Patch\n*** Update File: f.txt\n@@ def g(): \n x\n-y\n+z\n*** End Patch\n', { 'f.txt': 'def g():\nx\ny\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'def g():\nx\nz\n' });
C('v-anchor-missing', ['-'], '*** Begin Patch\n*** Update File: f.txt\n@@ def nope():\n x\n*** End Patch\n', { 'f.txt': 'def g():\nx\n' }, 1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', {});
C('v-eof-empty-o', ['-'], '*** Begin Patch\n*** Update File: f.txt\n@@ def g():\n+z\n*** End of File\n*** End Patch\n', { 'f.txt': 'def g():\nx\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'def g():\nx\nz\n' });
C('v-eof-no-end-match', ['-'], '*** Begin Patch\n*** Update File: f.txt\n x\n-y\n+z\n*** End of File\n*** End Patch\n', { 'f.txt': 'x\ny\nw\n' }, 1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', {});
C('v-cursor-order', ['-'], '*** Begin Patch\n*** Update File: f.txt\n@@ def b():\n b2\n-b3\n+b9\n@@ def a():\n a2\n-a3\n+a9\n*** End Patch\n', { 'f.txt': 'def a():\na2\na3\ndef b():\nb2\nb3\n' }, 1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', {});
C('v-move-not-first', ['-'], '*** Begin Patch\n*** Update File: f.txt\n x\n*** Move to: n.txt\n*** End Patch\n', { 'f.txt': 'x\n' }, 2, 'error: parse 4\n', {});
C('v-bad-line', ['-'], '*** Begin Patch\n*** Update File: f.txt\nfoo\n*** End Patch\n', { 'f.txt': 'x\n' }, 2, 'error: parse 3\n', {});
C('v-delete-with-line', ['-'], '*** Begin Patch\n*** Delete File: f.txt\n+x\n*** End Patch\n', { 'f.txt': 'x\n' }, 2, 'error: parse 3\n', {});
C('v-add-bad-line', ['-'], '*** Begin Patch\n*** Add File: f.txt\n x\n*** End Patch\n', {}, 2, 'error: parse 3\n', {});
C('v-unsafe', ['-'], '*** Begin Patch\n*** Add File: ../x.txt\n+y\n*** End Patch\n', {}, 1, 'error: unsafe ../x.txt\nfailed: 1 of 1 edits\n', {});
// JSON / CLI
C('j-array-bad-element', ['-'], '[{"command":"create","path":"a.txt","file_text":"x\\n"},\n{"command":"bogus","path":"b.txt"}]\n', {}, 2, 'error: parse 1\n', {});
C('j-insert-append', ['-'], '{"command":"insert","path":"f.txt","insert_line":2,"new_str":"c"}\n', { 'f.txt': 'a\nb\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nb\nc\n' });
C('j-insert-too-far', ['-'], '{"command":"insert","path":"f.txt","insert_line":3,"new_str":"c"}\n', { 'f.txt': 'a\nb\n' }, 1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', {});
C('j-str-replace-crlf', ['-'], '{"command":"str_replace","path":"f.txt","old_str":"b\\nc","new_str":"B\\nC"}\n', { 'f.txt': 'a\r\nb\r\nc\r\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\r\nB\r\nC\r\n' });
C('c-dashdash', ['--', '-x'], null, {}, 2, 'error: no-patch\n', {});
C('c-format-auto-v4a', ['--format=auto', '-'], '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n', {}, 0, 'A a.txt\nok: 1 file\n', { 'a.txt': 'x\n' });
C('c-empty-stdin', [], '', {}, 2, 'error: format\n', {});
C('c-two-edits-one-file', ['-'], 'f.txt\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\nf.txt\n<<<<<<< SEARCH\nb\n=======\nc\n>>>>>>> REPLACE\n', { 'f.txt': 'a\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'c\n' });
C('c-r-sort', ['-'], 'diff --git a/z.txt b/z.txt\n--- a/z.txt\n+++ b/z.txt\n@@ -1,1 +1,1 @@\n-q\n+r\ndiff --git a/o.txt b/a.txt\nrename from o.txt\nrename to a.txt\n--- a/o.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-p\n+s\n', { 'z.txt': 'q\n', 'o.txt': 'p\n' }, 0, 'R o.txt -> a.txt\nM z.txt\nok: 2 files\n', { 'z.txt': 'r\n', 'o.txt': null, 'a.txt': 's\n' });
C('c-r-then-modify', ['-'], 'diff --git a/o.txt b/n.txt\nrename from o.txt\nrename to n.txt\n--- a/o.txt\n+++ b/n.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n--- a/n.txt\n+++ b/n.txt\n@@ -1,1 +1,1 @@\n-b\n+c\n', { 'o.txt': 'a\n' }, 0, 'R o.txt -> n.txt\nok: 1 file\n', { 'o.txt': null, 'n.txt': 'c\n' });
// Extra edges
C('u-bare-at-auto', ['-'], '@@ -1,1 +1,1 @@\n-a\n+b\n', { 'x.txt': 'a\n' }, 2, 'error: format\n', {});
C('v-no-begin-auto', ['-'], 'hello\n*** End Patch\n', {}, 2, 'error: format\n', {});
C('u-delete-last-noeol', ['-'], U1 + '@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n', { 'f.txt': 'a\nb' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\n' });
C('u-crlf-tier2', ['-'], '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n   function f() {\n     return 1;\n-  }\n+  } // done\n', { 'f.txt': 'function f() {\r\n  return 1;\r\n}\r\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'function f() {\r\n  return 1;\r\n} // done\r\n' });
C('s-strict-tier1', ['--strict', '-'], 'f.txt\n<<<<<<< SEARCH\nreturn 1; \n=======\nreturn 2;\n>>>>>>> REPLACE\n', { 'f.txt': 'return 1;\n' }, 1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', {});
C('v-anchor-strict-tier1', ['--strict', '-'], '*** Begin Patch\n*** Update File: f.txt\n@@ def g():\n x\n-y\n+z\n*** End Patch\n', { 'f.txt': '  def g():\nx\ny\n' }, 1, 'error: no-match f.txt\nfailed: 1 of 1 edits\n', {});
C('j-insert-trailing-nl', ['-'], '{"command":"insert","path":"f.txt","insert_line":1,"new_str":"x\\n"}\n', { 'f.txt': 'a\nb\n' }, 0, 'M f.txt\nok: 1 file\n', { 'f.txt': 'a\nx\nb\n' });
C('u-two-pairs-header', ['-'], 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-q\n+r\n', { 'a.txt': 'p\n', 'b.txt': 'q\n' }, 0, 'M b.txt\nok: 1 file\n', { 'a.txt': 'p\n', 'b.txt': 'r\n' });
C('c-format-json-on-diff', ['--format=json', '-'], U1 + '@@ -1,1 +1,1 @@\n-a\n+b\n', { 'f.txt': 'a\n' }, 2, 'error: parse 1\n', {});

const only = process.argv.slice(2);
let pass = 0;
let fail = 0;
for (const c of cases) {
  if (only.length > 0 && !only.some((o) => c.name.includes(o))) continue;
  const dir = mkdtempSync(join(tmpdir(), 'mend-adv-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      if (text === null) continue;
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], { cwd: dir, input: c.stdin ?? '', encoding: 'utf8', timeout: 10000 });
    const gotFiles = {};
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) gotFiles[p.slice(dir.length + 1).split('/').join('/')] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    const wantFiles = { ...c.files };
    for (const [p, v] of Object.entries(c.changes)) {
      if (v === null) delete wantFiles[p];
      else wantFiles[p] = v;
    }
    const why = [];
    if (r.status !== c.exit) why.push(`exit ${r.status}, expected ${c.exit} (stderr: ${(r.stderr ?? '').slice(0, 200)})`);
    if ((r.stdout ?? '') !== c.stdout) why.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(c.stdout)}`);
    for (const p of new Set([...Object.keys(wantFiles), ...Object.keys(gotFiles)])) {
      if (wantFiles[p] === undefined) why.push(`${p} should not exist`);
      else if (gotFiles[p] === undefined) why.push(`${p} is missing`);
      else if (gotFiles[p] !== wantFiles[p]) why.push(`${p} differs: expected ${JSON.stringify(wantFiles[p])}, got ${JSON.stringify(gotFiles[p])}`);
    }
    if (why.length === 0) { pass += 1; }
    else { fail += 1; console.log(`FAIL ${c.name}\n  ${why.join('\n  ')}`); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`${pass} passed, ${fail} failed, ${cases.length} total`);
