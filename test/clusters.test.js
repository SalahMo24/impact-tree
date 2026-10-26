// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClusters } = require('../src/engine/clusters');

// A tiny changed function. `calledBy` lists [fn, ...] that call it (changed or not).
let seq = 0;
function fn(name, file, o = {}) {
  seq++;
  return {
    label: name, simpleName: name, className: o.className || null, file: `/abs/${file}`, relPath: file,
    namePos: o.namePos == null ? seq * 10 : o.namePos, isConstructor: !!o.isConstructor,
    classNamePos: o.classNamePos == null ? null : o.classNamePos,
    component: o.component || '(root)', score: o.score == null ? 1 : o.score,
    baseSig: o.sig || '()', headSig: o.sig || '()', callers: [], callersComplete: true, stale: o.stale || [],
    startLine: o.startLine || 1, endLine: o.endLine || 1, kinds: o.kinds || [{ id: 'body' }],
  };
}
const callerOf = (callee, caller, pos) => callee.callers.push({
  label: caller.label, file: caller.file, pos: pos == null ? caller.namePos : pos, test: false,
});
const outsideCaller = (callee, label, file, pos, test = false) => callee.callers.push({
  label, file: `/abs/${file}`, pos, test,
});
const idOf = (c) => `${c.relPath}#${c.namePos}`;
const cl = (r, f) => r.clusters.find((c) => c.members.includes(idOf(f)));

test('connected components become clusters; self-loops and tests do not link', () => {
  const a = fn('a', 'x/a.ts'), b = fn('b', 'x/b.ts'), c = fn('c', 'y/c.ts'), d = fn('d', 'y/d.ts');
  callerOf(a, b); callerOf(c, d); callerOf(a, a);
  outsideCaller(c, 't.test.ts', 'y/c.test.ts', 0, true);
  const r = buildClusters({ allChanged: [a, b, c, d] });
  assert.equal(r.clusters.length, 2);
  assert.equal(cl(r, a), cl(r, b));
  assert.notEqual(cl(r, a), cl(r, c));
  assert.equal(cl(r, c).stats.tests, 1);
});

test('a constructor is reached through its class name position', () => {
  const k = fn('Box', 'x/box.ts', { isConstructor: true, classNamePos: 7, namePos: 50 });
  const user = fn('use', 'x/use.ts');
  k.callers.push({ label: 'use', file: user.file, pos: user.namePos, test: false });
  const other = fn('mk', 'zz/mk.ts');
  other.callers.push({ label: 'mk', file: '/abs/x/box.ts', pos: 7, test: false }); // wrong direction on purpose
  const r = buildClusters({ allChanged: [k, user, other] });
  // `other` has k as its caller (via class pos 7), so all three link up
  assert.equal(r.clusters.length, 1);
});

test('a group spanning two modules is split by module and the cut link is a call seam', () => {
  const a = fn('a', 'p/a.ts', { component: 'p' }), b = fn('b', 'q/b.ts', { component: 'q' });
  callerOf(a, b);
  const r = buildClusters({ allChanged: [a, b] });
  assert.equal(r.clusters.length, 2);
  const call = r.seams.filter((s) => s.type === 'call');
  assert.equal(call.length, 1);
  assert.deepEqual(call[0].via, [{ callee: idOf(a), caller: idOf(b) }]);
});

test('a group above 12 members is split by directory; small directories merge upward', () => {
  const all = [];
  for (let i = 0; i < 5; i++) all.push(fn(`a${i}`, `d/one/a${i}.ts`));
  for (let i = 0; i < 5; i++) all.push(fn(`b${i}`, `d/two/b${i}.ts`));
  all.push(fn('c', 'd/three/c.ts'), fn('e', 'd/three/e.ts'), fn('f', 'd/four/f.ts'), fn('g', 'd/g.ts'));
  for (let i = 1; i < all.length; i++) callerOf(all[0], all[i]);
  assert.equal(all.length, 14);
  const r = buildClusters({ allChanged: all });
  // one/ (5), two/ (5), and three/(2)+four/(1) merge into d/ with g (4)
  assert.equal(r.clusters.length, 3);
  assert.deepEqual(r.clusters.map((c) => c.stats.members).sort((x, y) => x - y), [4, 5, 5]);
  assert.ok(r.seams.some((s) => s.type === 'call'));
  const total = r.clusters.reduce((s, c) => s + c.members.length, 0);
  assert.equal(total, 14);
});

test('lone change joins the cluster with a member in the same file', () => {
  const a = fn('a', 'x/a.ts'), b = fn('b', 'x/b.ts'), lone = fn('l', 'x/a.ts');
  callerOf(a, b);
  const r = buildClusters({ allChanged: [a, b, lone] });
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(r.clusters[0].joined, [{ id: idOf(lone), by: 'file' }]);
});

test('lone change falls back to the folder with most members, tie to the lower id', () => {
  const a = fn('a', 'x/a.ts', { score: 9 }), b = fn('b', 'x/b.ts', { score: 9 });
  const c = fn('c', 'x/c.ts', { score: 5 }), d = fn('d', 'x/d.ts', { score: 5 }), e = fn('e', 'x/e.ts', { score: 5 });
  callerOf(a, b); callerOf(c, d); callerOf(c, e);
  const lone = fn('l', 'x/zzz.ts');
  const r = buildClusters({ allChanged: [a, b, c, d, e, lone] });
  assert.equal(r.clusters.length, 2);
  // folder x/ has 2 members in K1 and 3 in K2: busiest folder wins
  const home = cl(r, lone);
  assert.equal(home.members.length, 4);
  assert.deepEqual(home.joined, [{ id: idOf(lone), by: 'folder' }]);
  // a real tie goes to K1 (the higher-scoring cluster)
  const r2 = buildClusters({ allChanged: [fn('a', 'x/a.ts', { score: 9 }), fn('l', 'x/l.ts')] });
  assert.equal(r2.clusters.length, 1);
  const t1 = fn('t1', 'x/t1.ts', { score: 9 }), t2 = fn('t2', 'x/t2.ts', { score: 9 });
  const u1 = fn('u1', 'x/u1.ts', { score: 5 }), u2 = fn('u2', 'x/u2.ts', { score: 5 });
  callerOf(t1, t2); callerOf(u1, u2);
  const l2 = fn('l2', 'x/l2.ts');
  const r3 = buildClusters({ allChanged: [t1, t2, u1, u2, l2] });
  assert.equal(cl(r3, l2).id, 'K1');
});

test('lone changes with no home group into one card per folder', () => {
  const a = fn('a', 'x/a.ts'), b = fn('b', 'x/b.ts');
  callerOf(a, b);
  const l1 = fn('l1', 'm/l1.ts'), l2 = fn('l2', 'm/l2.ts'), l3 = fn('l3', 'n/l3.ts');
  const r = buildClusters({ allChanged: [a, b, l1, l2, l3], deleted: [] });
  assert.equal(r.clusters.length, 3);
  const m = cl(r, l1);
  assert.equal(m, cl(r, l2));
  assert.equal(m.joined.length, 2);
  assert.ok(m.joined.every((j) => j.by === 'folder'));
});

test('deleted functions are lone changes too', () => {
  const a = fn('a', 'x/a.ts');
  const gone = { ...fn('gone', 'x/old.ts'), score: undefined };
  const r = buildClusters({ allChanged: [a], deleted: [gone] });
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].members.length, 2);
});

test('an unchanged caller of two clusters is a meeting point', () => {
  const a = fn('a', 'p/a.ts', { score: 3 }), b = fn('b', 'q/b.ts', { score: 2 });
  outsideCaller(a, 'main', 'app/main.ts', 5); outsideCaller(b, 'main', 'app/main.ts', 5);
  outsideCaller(a, 'only', 'app/only.ts', 9);
  const r = buildClusters({ allChanged: [a, b] });
  const m = r.seams.filter((s) => s.type === 'meeting');
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].clusters, ['K1', 'K2']);
  assert.deepEqual(m[0].at, { label: 'main', relPath: 'app/main.ts' });
  assert.equal(m[0].via.length, 2);
});

test('type seam: another cluster names the changed class in a signature (approximate)', () => {
  const m = fn('run', 'p/svc.ts', { className: 'Service', score: 3 });
  const u = fn('use', 'q/use.ts', { score: 2, sig: '(s: Service) => void' });
  const r = buildClusters({ allChanged: [m, u] });
  const t = r.seams.filter((s) => s.type === 'type');
  assert.equal(t.length, 1);
  assert.equal(t[0].approximate, true);
  assert.deepEqual(t[0].types, ['Service']);
  assert.deepEqual(t[0].directions, ['K1>K2']);
});

test('stats count outside callers, tests, stale and incomplete', () => {
  const a = fn('a', 'x/a.ts', { stale: [{}, {}], kinds: [{ id: 'signature' }] });
  a.callersComplete = false;
  outsideCaller(a, 'c1', 'z/c1.ts', 1); outsideCaller(a, 'c1b', 'z/c1.ts', 1);
  outsideCaller(a, 't', 'z/c.test.ts', 0, true);
  const r = buildClusters({ allChanged: [a] });
  assert.deepEqual(r.clusters[0].stats, { members: 1, callers: 1, tests: 1, notUpdated: 2, notUpdatedOutside: 2, notUpdatedInside: 0, incomplete: 1, risky: 1, riskyAllUpdated: 0, mirrored: 0 });
  assert.equal(r.clusters[0].label, 'a');
});

test('ids follow score order and the result is deterministic', () => {
  const build = () => {
    const a = fn('a', 'x/a.ts', { score: 1, namePos: 1 }), b = fn('b', 'y/b.ts', { score: 8, namePos: 2 });
    const c = fn('c', 'z/c.ts', { score: 4, namePos: 3 }), d = fn('d', 'z/d.ts', { score: 4, namePos: 4 });
    callerOf(c, d);
    return { allChanged: [a, b, c, d] };
  };
  const r1 = buildClusters(build()), r2 = buildClusters(build());
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  assert.deepEqual(r1.clusters.map((c) => c.anchor), ['y/b.ts#2', 'z/c.ts#3', 'x/a.ts#1']);
  assert.equal(r1.clusters[1].label, 'c and 1 related');
});

test('notUpdated counts stale call lines only for members with a non-body kind', () => {
  const body = fn('b', 'x/b.ts', { stale: [{}, {}, {}] });
  const sig = fn('s', 'x/s.ts', { stale: [{}], kinds: [{ id: 'body' }, { id: 'params' }] });
  callerOf(body, sig);
  const r = buildClusters({ allChanged: [body, sig] });
  assert.equal(r.clusters[0].stats.notUpdated, 1);
  assert.equal(r.clusters[0].stats.risky, 1);
});

test('a generated copy moves into its source cluster as mirrorMembers', () => {
  const mk = (dir) => {
    const a = fn('verify', `${dir}/jwt/jws.ts`), b = fn('sign', `${dir}/jwt/jwt.ts`);
    callerOf(a, b);
    return [a, b];
  };
  const src = mk('src'), copy = mk('deno_dist');
  const r = buildClusters({ allChanged: [...src, ...copy] }, { facts: { generatedDirs: ['deno_dist'] } });
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].members.every((id) => id.startsWith('src/')), true);
  assert.equal(r.clusters[0].mirrorMembers.length, 2);
  assert.equal(r.clusters[0].mirrorOf.dir, 'deno_dist');
  // by name only (dist matches the generated-folder pattern)
  const r2 = buildClusters({ allChanged: [...mk('src'), ...mk('dist')] }, { facts: {} });
  assert.equal(r2.clusters[0].mirrorMembers.length, 2);
  // neither side generated: a mirror seam instead of a move
  const r3 = buildClusters({ allChanged: [...mk('src'), ...mk('lib')] }, { facts: {} });
  assert.equal(r3.clusters.length, 2);
  assert.equal(r3.seams.filter((s) => s.type === 'mirror').length, 1);
});

test('a repeated edit in 8 or more functions becomes a sweep; a signature change stays out', () => {
  const fns = [];
  const hunks = [];
  for (let i = 0; i < 9; i++) {
    const f = fn(`f${i}`, `pkg${i % 3}/f${i}.go`, { startLine: 1, endLine: 5 });
    fns.push(f);
    hunks.push({ file: f.relPath, newStart: 2, newCount: 1, removed: ['x := interface{}(1)'], added: ['x := any(1)'] });
  }
  const risky = fn('keep', 'pkg0/keep.go', { startLine: 1, endLine: 5, kinds: [{ id: 'params' }] });
  hunks.push({ file: risky.relPath, newStart: 2, newCount: 1, removed: ['x := interface{}(1)'], added: ['x := any(1)'] });
  const r = buildClusters({ allChanged: [...fns, risky] }, { facts: { hunks } });
  assert.equal(r.sweeps.length, 1);
  assert.equal(r.sweeps[0].members.length, 9);
  assert.equal(r.sweeps[0].patterns[0].key, 'interface { } → any');
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(r.clusters[0].members, ['pkg0/keep.go#' + risky.namePos]);
  // too few functions: no sweep
  const r2 = buildClusters({ allChanged: [...fns.slice(0, 7)] }, { facts: { hunks } });
  assert.equal(r2.sweeps.length, 0);
});

test('a sweep has a readable label and keeps its raw pattern in its own field', () => {
  const changed = [], hunks = [];
  for (let i = 0; i < 9; i++) {
    const f = fn(`t${i}`, `pkg${i % 3}/t${i}.go`, { startLine: 1, endLine: 5 });
    changed.push(f);
    hunks.push({ file: f.relPath, newStart: 2, newCount: 1, removed: ['x := interface{}(1)'], added: ['x := any(1)'] });
    const g = fn(`s${i}`, `lib${i % 3}/s${i}.ts`, { startLine: 1, endLine: 5 });
    changed.push(g);
    hunks.push({ file: g.relPath, newStart: 2, newCount: 1, removed: [], added: [`return a${i} + b + c + d + e + f + g;`] });
  }
  const r = buildClusters({ allChanged: changed }, { facts: { hunks } });
  assert.equal(r.sweeps.length, 2);
  const token = r.sweeps.find((s) => s.pattern === 'interface { } → any');
  assert.equal(token.label, 'Repeated edit in 9 functions: interface { } → any');
  const shape = r.sweeps.find((s) => s.pattern.startsWith('≈ '));
  assert.match(shape.pattern, /⟪0 → \d+⟫/);
  assert.match(shape.label, /^Similar edit in 9 functions \(\d+ tokens added each\)$/);
});

test('a group still above 12 after the directory split is split by file; one-file groups stay whole', () => {
  const all = [];
  for (let i = 0; i < 8; i++) all.push(fn(`a${i}`, 'd/a.ts'));
  for (let i = 0; i < 6; i++) all.push(fn(`b${i}`, 'd/b.ts'));
  all.push(fn('c', 'd/c.ts'));
  for (let i = 1; i < all.length; i++) callerOf(all[0], all[i]);
  const r = buildClusters({ allChanged: all });
  assert.deepEqual(r.clusters.map((c) => c.stats.members).sort((x, y) => x - y), [6, 9]);
  const one = [];
  for (let i = 0; i < 15; i++) one.push(fn(`o${i}`, 'd/only.ts'));
  for (let i = 1; i < one.length; i++) callerOf(one[0], one[i]);
  assert.equal(buildClusters({ allChanged: one }).clusters.length, 1);
});

test('clusters carry repeated patterns and signature deltas for the hints step', () => {
  const a = fn('a', 'x/a.ts', { sig: '(r: Old)', kinds: [{ id: 'params' }] });
  a.baseSig = '(r: Old)'; a.headSig = '(r: New)';
  const r = buildClusters({ allChanged: [a] });
  assert.deepEqual(r.clusters[0].signatureDeltas, ['Old → New']);
});

test('each dominant pattern with 8 or more functions is its own sweep; smaller groups stay in the graph', () => {
  const fns = [], hunks = [];
  const add = (name, dir, removed, added) => {
    const f = fn(name, `${dir}/${name}.go`, { startLine: 1, endLine: 5 });
    fns.push(f);
    hunks.push({ file: f.relPath, newStart: 2, newCount: 1, removed: [removed], added: [added] });
  };
  for (let i = 0; i < 9; i++) add(`a${i}`, `p${i % 3}`, 'x := interface{}(1)', 'x := any(1)');
  for (let i = 0; i < 6; i++) add(`b${i}`, `q${i % 3}`, 'y := strings.Split(s)', 'y := strings.SplitSeq(s)');
  const r = buildClusters({ allChanged: fns }, { facts: { hunks } });
  assert.equal(r.sweeps.length, 1);
  assert.equal(r.sweeps[0].id, 'S1');
  assert.equal(r.sweeps[0].members.length, 9);
  assert.equal(r.clusters.reduce((n, c) => n + c.members.length, 0), 6);
});

const hunk = (file, removed, added, o = {}) => ({
  file, oldStart: o.oldStart || 2, oldCount: removed.length, newStart: o.newStart || 2, newCount: added.length, removed, added,
});

test('the anchor is production code, then risky, then most outside callers', () => {
  const spy = fn('RecorderSpy', 'x/spy.go', { score: 9 });
  const prod = fn('Record', 'x/rec.go', { score: 1 });
  callerOf(prod, spy);
  const r = buildClusters({ allChanged: [spy, prod] });
  assert.equal(r.clusters[0].anchor, idOf(prod));
  assert.equal(r.clusters[0].label, 'Record and 1 related');
});

test('notUpdated splits into callers inside and outside the card', () => {
  const a = fn('a', 'x/a.ts', { kinds: [{ id: 'params' }] });
  const b = fn('b', 'x/b.ts');
  callerOf(a, b);
  a.stale = [{ file: b.file, pos: b.namePos }, { file: '/abs/z/z.ts', pos: 5 }];
  const r = buildClusters({ allChanged: [a, b] });
  assert.deepEqual([r.clusters[0].stats.notUpdated, r.clusters[0].stats.notUpdatedInside, r.clusters[0].stats.notUpdatedOutside], [2, 1, 1]);
  const ok = fn('ok', 'x/ok.ts', { kinds: [{ id: 'params' }] });
  assert.equal(buildClusters({ allChanged: [ok] }).clusters[0].stats.riskyAllUpdated, 1);
});

test('a hub whose removal leaves 3 parts of 2 or more becomes its own card', () => {
  const hub = fn('route', 'h/hub.ts', { score: 9 });
  const all = [hub];
  for (const p of ['a', 'b', 'c']) {
    const top = fn(`${p}1`, `${p}/${p}1.ts`), low = fn(`${p}2`, `${p}/${p}2.ts`);
    callerOf(low, top);
    callerOf(top, hub);
    all.push(top, low);
  }
  const r = buildClusters({ allChanged: all });
  assert.equal(r.clusters.length, 4);
  assert.equal(r.clusters.filter((c) => c.hub).length, 1);
  assert.deepEqual(r.clusters.find((c) => c.hub).members, [idOf(hub)]);
  assert.equal(r.rules.hubs, 1);
});

test('the same lone change in sibling folders becomes one siblings card', () => {
  const a = fn('getConnInfo', 'adapter/aws/conninfo.ts'), b = fn('getConnInfo', 'adapter/bun/conninfo.ts');
  const other = fn('getConnInfo', 'top/conninfo.ts');
  const r = buildClusters({ allChanged: [a, b, other] });
  const sib = r.clusters.filter((c) => c.siblings);
  assert.equal(sib.length, 1);
  assert.equal(sib[0].members.length, 2);
  assert.equal(r.clusters.length, 2);
});

test('a deleted function and its added twin in another file read as a move', () => {
  const gone = { ...fn('IsRefreshable', 'internal/gh.go', { startLine: 1, endLine: 3 }), score: undefined };
  const added = fn('IsRefreshable', 'pkg/auth.go', { startLine: 1, endLine: 3 });
  added.added = true;
  const hunks = [hunk('internal/gh.go', ['func x() {', 'return token.refresh', '}'], [], { oldStart: 1 }),
    hunk('pkg/auth.go', [], ['func x() {', 'return token.refresh', '}'], { newStart: 1 })];
  const r = buildClusters({ allChanged: [added], deleted: [gone] }, { facts: { hunks } });
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(r.clusters[0].moved, [{ from: 'internal/gh.go#' + gone.namePos, to: idOf(added) }]);
  assert.equal(r.clusters[0].members.length, 1);
  // a different body is not a move
  const other = buildClusters({ allChanged: [added], deleted: [gone] }, { facts: { hunks: [hunks[0], hunk('pkg/auth.go', [], ['alpha beta gamma delta'], { newStart: 1 })] } });
  assert.equal(other.clusters.reduce((n, c) => n + c.moved.length, 0), 0);
});

test('functions under a generated folder without a twin go to one generated card', () => {
  const a = fn('a', 'dist/a.js'), b = fn('b', 'dist/sub/b.js'), src = fn('s', 'src/s.ts');
  const r = buildClusters({ allChanged: [a, b, src] }, { facts: { generatedDirs: ['dist'] } });
  const g = r.clusters.filter((c) => c.generated);
  assert.equal(g.length, 1);
  assert.equal(g[0].generated.dir, 'dist');
  assert.equal(g[0].members.length, 2);
  assert.equal(r.rules.generatedMembers, 2);
});

test('a fused group splits by the commits that touched its files', () => {
  const ms = [];
  for (const f of ['f1', 'f2', 'f3', 'f4']) for (let i = 0; i < 2; i++) ms.push(fn(`${f}_${i}`, `d/${f}.ts`));
  for (let i = 1; i < ms.length; i++) callerOf(ms[0], ms[i]);
  const commits = [{ sha: 'c1', subject: 'add the first feature', files: ['d/f1.ts', 'd/f2.ts'] },
    { sha: 'c2', subject: 'add the second feature', files: ['d/f3.ts', 'd/f4.ts'] }];
  const r = buildClusters({ allChanged: ms }, { facts: { commits, changedFileCount: 4 } });
  assert.equal(r.clusters.length, 2);
  assert.equal(r.rules.commitSplits, 1);
  assert.ok(r.seams.some((s) => s.type === 'call'));
  assert.equal(buildClusters({ allChanged: ms }, { facts: { commits: [], changedFileCount: 4 } }).clusters.length, 1);
});

test('a big group of new code is split by folder, not by file', () => {
  const mk = (status) => {
    const all = [];
    for (let i = 0; i < 8; i++) all.push(Object.assign(fn(`a${i}`, 'd/a.ts'), { fileStatus: status }));
    for (let i = 0; i < 6; i++) all.push(Object.assign(fn(`b${i}`, 'd/b.ts'), { fileStatus: status }));
    for (let i = 1; i < all.length; i++) callerOf(all[0], all[i]);
    return buildClusters({ allChanged: all });
  };
  assert.equal(mk('added').clusters.length, 1);
  assert.equal(mk('modified').clusters.length, 2);
});

test('small repeated-edit groups together become one "other repeated edits" sweep', () => {
  const fns = [], hunks = [];
  for (let i = 0; i < 10; i++) {
    const f = fn(`g${i}`, `p${i}/g${i}.go`, { startLine: 1, endLine: 5 });
    fns.push(f);
    hunks.push(hunk(f.relPath, [i < 5 ? 'x := interface{}(1)' : 'y := foo(1)'], [i < 5 ? 'x := any(1)' : 'y := bar(1)']));
  }
  const r = buildClusters({ allChanged: fns }, { facts: { hunks } });
  assert.equal(r.sweeps.length, 1);
  assert.equal(r.sweeps[0].other, true);
  assert.equal(r.sweeps[0].members.length, 10);
  assert.match(r.sweeps[0].label, /Other repeated edits \(2 patterns\)/);
});

test('a hub type owned by 3 or more clusters is dropped from type seams and the pair is merged', () => {
  const owners = ['A', 'B', 'C'].map((c, i) => fn(`m${c}`, `${c.toLowerCase()}/m.ts`, { className: 'Hub', score: 10 - i }));
  const user = fn('use', 'u/use.ts', { sig: '(h: Hub, w: Widget) => void' });
  const w = fn('go', 'w/w.ts', { className: 'Widget' });
  const r = buildClusters({ allChanged: [...owners, user, w] });
  const t = r.seams.filter((s) => s.type === 'type');
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].types, ['Widget']);
});

test('a hub takes the one-member parts with it and fires on 3 parts of 2 or more', () => {
  const hub = fn('route', 'h/hub.ts', { score: 9 });
  const all = [hub];
  for (const p of ['a', 'b', 'c']) {
    const top = fn(`${p}1`, `${p}/${p}1.ts`), low = fn(`${p}2`, `${p}/${p}2.ts`);
    callerOf(low, top);
    callerOf(top, hub);
    all.push(top, low);
  }
  const single = fn('s1', 's/s1.ts');
  callerOf(single, hub);
  all.push(single);
  const r = buildClusters({ allChanged: all });
  assert.equal(r.clusters.length, 4);
  const h = r.clusters.find((c) => c.hub);
  assert.deepEqual(h.members.slice().sort(), [idOf(hub), idOf(single)].sort());
  assert.deepEqual(h.joined, [{ id: idOf(single), by: 'hub' }]);
});

test('generated copies inside a sweep fold into the sweep as mirrorMembers', () => {
  const fns = [], hunks = [];
  for (const dir of ['src', 'deno_dist']) {
    for (let i = 0; i < 9; i++) {
      const f = fn(`mw${i}`, `${dir}/mw${i}/index.go`, { startLine: 1, endLine: 5 });
      fns.push(f);
      hunks.push(hunk(f.relPath, ['x := interface{}(1)'], ['x := any(1)']));
    }
  }
  const r = buildClusters({ allChanged: fns }, { facts: { hunks, generatedDirs: ['deno_dist'] } });
  assert.equal(r.sweeps.length, 1);
  assert.equal(r.sweeps[0].members.length, 9);
  assert.equal(r.sweeps[0].mirrorMembers.length, 9);
  assert.ok(r.sweeps[0].members.every((m) => m.startsWith('src/')));
});
