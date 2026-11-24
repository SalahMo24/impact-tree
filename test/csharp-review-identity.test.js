'use strict';
// Review identity of C# rows (C6, docs/MULTI_LANGUAGE_PLAN.md): a change, deleted or outside
// row of a C# file is identified by its own declaration's text (`rel#key` and hashes), from
// the symbols the provider recorded during the analysis (`result.reviewSymbols`), not by the
// whole file and not by offsets. The shared code is Go's (go-review-identity.test.js, G5) and
// C#'s editor path goes through it (prepareFromServerSymbols); this file checks what is C#'s:
// a member keeps its tick through an edit elsewhere in the file and through an edit of its
// XML doc comment (outside the member's range, C-D4), loses it when its header, body or an
// attribute changes (attributes are inside the range), an overload pair is identified by the
// key it was paired under, and a deleted member by its base declaration. Run through the real
// pipeline (`analyze()`) on a throwaway git repository with the editor path's provider (its
// server load answered yes) and no caller search; the symbols come from the text outline, so
// nothing is recorded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { analyze } = require('../src/engine/analyze');
const { makeGit } = require('../src/engine/git');
const { createReviewIdentity, localRevisions } = require('../src/session/review-identity');
const { createCsharpProvider } = require('../src/languages/csharp/provider');
const { useLanguagesForTest, registeredLanguages } = require('../src/languages');

const sha = (text) => createHash('sha256').update(text == null ? '<absent>' : text).digest('hex');

const BASE = `namespace Demo;

public class Codec
{
    public string Encode(int n)
    {
        return n.ToString();
    }

    [Obsolete("old")]
    public void Reset(byte a)
    {
    }

    public void Reset(short a)
    {
    }

    public void Gone(int a)
    {
    }

    /// <summary>Decodes.</summary>
    public string Decode(string s, bool strict)
    {
        return s;
    }
}
`;
const HEAD = `using System;
namespace Demo;

public class Codec
{
    public string Encode(long n)
    {
        return n.ToString();
    }

    [Obsolete("old")]
    public void Reset(byte a)
    {
        Flush();
    }

    public void Reset(short a)
    {
        Flush();
    }

    public void Flush(bool force)
    {
    }

    /// <summary>Decodes.</summary>
    public string Decode(string s, bool strict)
    {
        return s + "";
    }
}
`;

/** `HEAD` with `oldStr` (found once) replaced by `newStr`. */
function edited(oldStr, newStr) {
  const at = HEAD.indexOf(oldStr);
  assert.ok(at >= 0 && HEAD.indexOf(oldStr, at + 1) < 0, `${JSON.stringify(oldStr)} occurs once in the head`);
  return HEAD.slice(0, at) + newStr + HEAD.slice(at + oldStr.length);
}
// The pushes: an edit in the body of a method that is already a row, outside every member,
// in the body and in the header of two other rows, in the body of the overload that was
// paired, in the attribute of a row, and in the XML doc comment of a row.
const ELSEWHERE = edited('    public void Reset(short a)\n    {\n        Flush();', '    public void Reset(short a)\n    {\n        Flush();\n        Flush();');
const OUTSIDE = edited('using System;\n', 'using System; // outside every member\n');
const BODY = edited('public void Flush(bool force)\n    {\n', 'public void Flush(bool force)\n    {\n        Flush(force);\n');
const HEADER = edited('public void Reset(byte a)', 'public virtual void Reset(byte a)');
const PAIRED = edited('public string Encode(long n)\n    {\n        return n.ToString();', 'public string Encode(long n)\n    {\n        return n.ToString() + "";');
const ATTRIBUTE = edited('[Obsolete("old")]', '[Obsolete("older")]');
const XMLDOC = edited('/// <summary>Decodes.</summary>', '/// <summary>Decodes {s}, strictly or not.</summary>');

const noCallers = () => ({
  callerState: async () => ({ state: 'none', callers: [], complete: true }),
  incoming: async () => [],
  incomingWithStatus: async () => ({ callers: [], complete: true }),
});
// `prepare` takes the editor's path when the hooks hold services and a resolver factory; its
// symbols come from the outline whatever the services say.
const services = { available: async () => ({ ok: true }), documentSymbols: async () => assert.fail('C# symbols never come from the server') };

/** A TypeScript module that fails if the identity ever touches it: C# rows parse nothing. */
const noTypeScript = new Proxy({}, { get: (_target, name) => assert.fail(`TypeScript was used (${String(name)})`) });

const FILE = 'src/Demo/Codec.cs';

function csharpRepo(t) {
  const restore = useLanguagesForTest([
    ...registeredLanguages().filter((l) => l.id !== 'csharp'),
    createCsharpProvider({ load: async () => ({ ok: true }), serverChanges: () => 0 }),
  ]);
  t.after(restore);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-csharp-identity-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run('init', '-q', '--initial-branch=main');
  run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(dir, 'src/Demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/Demo/Demo.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
  const file = path.join(dir, FILE);
  fs.writeFileSync(file, BASE);
  run('add', '-A'); run('commit', '-qm', 'base');
  run('checkout', '-q', '-b', 'feature');
  const push = (text) => {
    fs.writeFileSync(file, text);
    run('commit', '-qam', 'push');
  };
  push(HEAD);
  return { dir, push };
}

const analyseCsharp = (dir, opts = {}) => analyze(dir, {
  mode: 'pr', base: 'main', allowLocalBase: true, skipForest: true, deferTestReach: true,
  languageServices: services, makeResolver: noCallers, ...opts,
});

/** The persisted identity of every C# row of a result, by key (`deleted <key>`, `outside <file>`). */
function idsOf(dir, result) {
  const identity = createReviewIdentity(noTypeScript, dir, localRevisions(dir, result, makeGit(dir)));
  const ids = {};
  for (const c of result.allChanged) ids[c.key] = identity({ type: 'finding', label: c.label, file: c.file, pos: c.namePos });
  for (const d of result.deleted) ids[`deleted ${d.key}`] = identity({ type: 'deleted', label: d.label, key: d.key, relPath: d.relPath, file: d.file });
  for (const o of result.outside) ids[`outside ${o.relPath}`] = identity({ type: 'outside', file: o.file, relPath: o.relPath });
  return ids;
}
const differing = (before, after) => Object.keys(before).filter((k) => before[k] !== after[k]);
const keyOf = (r, key) => r.allChanged.find((c) => c.key === key);

// Each declaration's text as the provider cuts it: from its first attribute or modifier (the
// XML doc comment is not part of it) to the closing brace.
const DECL = {
  encodeLong: 'public string Encode(long n)\n    {\n        return n.ToString();\n    }',
  encodeInt: 'public string Encode(int n)\n    {\n        return n.ToString();\n    }',
  flush: 'public void Flush(bool force)\n    {\n    }',
  gone: 'public void Gone(int a)\n    {\n    }',
  resetByte: '[Obsolete("old")]\n    public void Reset(byte a)\n    {\n        Flush();\n    }',
};
for (const [side, text] of [[HEAD, DECL.encodeLong], [BASE, DECL.encodeInt], [HEAD, DECL.flush], [BASE, DECL.gone], [HEAD, DECL.resetByte]]) {
  assert.ok(side.includes(text), `the fixture declares ${JSON.stringify(text.slice(0, 30))}`);
}

test('the fixture has the rows the tests below name', async (t) => {
  const repo = csharpRepo(t);
  const result = await analyseCsharp(repo.dir);
  assert.deepEqual(result.allChanged.map((c) => c.key).sort(), ['Codec.Decode(string, bool)', 'Codec.Encode(int)', 'Codec.Flush(bool)', 'Codec.Reset(byte)', 'Codec.Reset(short)']);
  assert.deepEqual(result.deleted.map((d) => d.key), ['Codec.Gone(int)']);
});

test('a C# change row is rel#key with the hashes of its own head and base declarations', async (t) => {
  const repo = csharpRepo(t);
  const ids = idsOf(repo.dir, await analyseCsharp(repo.dir));
  assert.equal(ids['Codec.Flush(bool)'], `${FILE}#Codec.Flush(bool):${sha(DECL.flush)}:${sha(null)}`, 'an added member has no base side');
  assert.equal(ids['Codec.Reset(byte)'].split(':')[1], sha(DECL.resetByte), 'the attribute is part of the declaration');
  for (const [key, id] of Object.entries(ids)) {
    if (/^(deleted|outside) /.test(key)) continue;
    assert.match(id, /^src\/Demo\/Codec\.cs#[^:]+:[0-9a-f]{64}:[0-9a-f]{64}$/, key);
    assert.doesNotMatch(id, /#@/, `${key} is not identified by its whole file`);
  }
});

test('an overload paired with its old self is identified by the old key, the head declaration and the base declaration', async (t) => {
  const repo = csharpRepo(t);
  const ids = idsOf(repo.dir, await analyseCsharp(repo.dir));
  assert.equal(ids['Codec.Encode(int)'], `${FILE}#Codec.Encode(int):${sha(DECL.encodeLong)}:${sha(DECL.encodeInt)}`);
  assert.equal(ids['Codec.Encode(long)'], undefined, 'no row under the new key');
});

test('a deleted C# member is identified by its base declaration', async (t) => {
  const repo = csharpRepo(t);
  const ids = idsOf(repo.dir, await analyseCsharp(repo.dir));
  assert.equal(ids['deleted Codec.Gone(int)'], `deleted:${FILE}#Codec.Gone(int):${sha(DECL.gone)}`);
});

test('a push that edits one member keeps every other tick, though their offsets moved', async (t) => {
  const repo = csharpRepo(t);
  const first = await analyseCsharp(repo.dir);
  const before = idsOf(repo.dir, first);
  repo.push(ELSEWHERE);
  const second = await analyseCsharp(repo.dir);
  const after = idsOf(repo.dir, second);
  assert.notEqual(keyOf(second, 'Codec.Decode(string, bool)').namePos, keyOf(first, 'Codec.Decode(string, bool)').namePos, 'Decode moved: offsets alone would not identify it');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(differing(before, after), ['Codec.Reset(short)'], 'only the member whose text changed is unticked');
});

test('an edit inside a member body unticks that member only', async (t) => {
  const repo = csharpRepo(t);
  const before = idsOf(repo.dir, await analyseCsharp(repo.dir));
  repo.push(BODY);
  assert.deepEqual(differing(before, idsOf(repo.dir, await analyseCsharp(repo.dir))), ['Codec.Flush(bool)']);
});

test('an edit of a member header unticks that member only', async (t) => {
  const repo = csharpRepo(t);
  const before = idsOf(repo.dir, await analyseCsharp(repo.dir));
  repo.push(HEADER);
  assert.deepEqual(differing(before, idsOf(repo.dir, await analyseCsharp(repo.dir))), ['Codec.Reset(byte)']);
});

test('an edit of a member attribute unticks that member only (attributes are inside its range)', async (t) => {
  const repo = csharpRepo(t);
  const before = idsOf(repo.dir, await analyseCsharp(repo.dir));
  repo.push(ATTRIBUTE);
  assert.deepEqual(differing(before, idsOf(repo.dir, await analyseCsharp(repo.dir))), ['Codec.Reset(byte)']);
});

test('an edit of the paired overload unticks the row under its old key only', async (t) => {
  const repo = csharpRepo(t);
  const before = idsOf(repo.dir, await analyseCsharp(repo.dir));
  repo.push(PAIRED);
  assert.deepEqual(differing(before, idsOf(repo.dir, await analyseCsharp(repo.dir))), ['Codec.Encode(int)']);
});

test('an edit of only a member XML doc comment keeps its tick', async (t) => {
  const repo = csharpRepo(t);
  const before = idsOf(repo.dir, await analyseCsharp(repo.dir));
  repo.push(XMLDOC);
  const after = idsOf(repo.dir, await analyseCsharp(repo.dir));
  // The comment is outside every declaration (C-D4), so the file's outside row, if there is
  // one, reads the edit; the member keeps its tick.
  assert.equal(after['Codec.Decode(string, bool)'], before['Codec.Decode(string, bool)']);
  assert.ok(differing(before, after).every((k) => k === `outside ${FILE}`), differing(before, after).join(', '));
});

test('a change outside every member changes the outside row only', async (t) => {
  const repo = csharpRepo(t);
  const before = idsOf(repo.dir, await analyseCsharp(repo.dir));
  repo.push(OUTSIDE);
  const after = idsOf(repo.dir, await analyseCsharp(repo.dir));
  assert.deepEqual(differing(before, after), [`outside ${FILE}`]);
});

test('the early result (before callers) gives the same identities as the final one', async (t) => {
  const repo = csharpRepo(t);
  let early = null;
  const result = await analyseCsharp(repo.dir, { onPrepared: (pending) => { early = pending; } });
  assert.ok(early, 'the early result was published');
  assert.deepEqual(idsOf(repo.dir, early), idsOf(repo.dir, result));
  assert.equal(Object.keys(result).includes('reviewSymbols'), false, 'not part of the JSON result');
});

test('a file edited after the analysis is identified by its whole text until the next analysis, never by stale offsets', async (t) => {
  const repo = csharpRepo(t);
  const result = await analyseCsharp(repo.dir);
  const analysed = idsOf(repo.dir, result);
  fs.writeFileSync(path.join(repo.dir, FILE), ELSEWHERE);
  const afterEdit = idsOf(repo.dir, result);
  for (const name of Object.keys(analysed)) assert.notEqual(afterEdit[name], analysed[name], name);
  assert.ok(afterEdit['Codec.Encode(int)'].startsWith(`${FILE}#@`), afterEdit['Codec.Encode(int)']);
});
