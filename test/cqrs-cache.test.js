'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const { makeSymbols } = require('../src/engine/symbols');
const { makeCqrsEdges } = require('../src/engine/edges-cqrs');
const { offsetToPosition, positionToOffset, _clear: clearTextPositions } = require('../src/engine/textpos');

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

// Real CQRS parsing; only editor definition/reference providers are substituted.
// Count parser admissions to verify released files are rebuilt, without GC timing
// assertions. Heap retention is measured separately by measure-cqrs-cache.js.
async function withResolver(run) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-cqrs-cache-'));
  const files = {
    'commands.ts': 'export class Primary {} export class Secondary {}',
    'handler.ts': '@CommandHandler(Primary) class Handler { execute() {} helper() {} }\n@EventsHandler(Primary, Secondary) class Events { handle() {} execute() {} }',
    'caller.ts': 'function dispatch() { const nested = () => bus.execute(new Primary()); bus.execute(new Primary()); bus.execute(new Secondary()); }',
    'caller.test.ts': 'function checks() { bus.execute(new Primary()); }',
    'ordinary.ts': 'export function unrelated() {}',
    'normal.ts': 'function normal() { unrelated(); }',
  };
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, rel), text);
  const absolute = (rel) => path.join(repo, rel);
  const parses = new Map();
  const compiler = { ...ts, createSourceFile(file, ...args) {
    parses.set(file, (parses.get(file) || 0) + 1);
    return ts.createSourceFile(file, ...args);
  } };
  const symbols = makeSymbols(ts).collect(ts.createSourceFile(absolute('handler.ts'), files['handler.ts'], ts.ScriptTarget.Latest, true));
  const posOf = (label) => symbols.find((s) => s.label === label).namePos;
  const location = (rel, pos, length) => {
    const start = offsetToPosition(absolute(rel), pos), end = offsetToPosition(absolute(rel), pos + length);
    return { uri: { fsPath: absolute(rel) }, range: { start, end } };
  };
  let references = null;
  let incomingCalls = [];
  let failDefinition = false;
  const stub = { ...require('./vscode-stub'), Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    commands: { async executeCommand(name, uri, position) {
      if (name === 'vscode.prepareCallHierarchy') return [{}];
      if (name === 'vscode.provideIncomingCalls') return incomingCalls;
      const pos = positionToOffset(uri.fsPath, position.line, position.character);
      const word = fs.readFileSync(uri.fsPath, 'utf8').slice(pos).match(/^\w+/)?.[0];
      if (name === 'vscode.executeDefinitionProvider') {
        return failDefinition ? [] : [location('commands.ts', files['commands.ts'].indexOf(word), word.length)];
      }
      if (name === 'vscode.executeReferenceProvider') {
        const found = [];
        for (const rel of ['caller.ts', 'caller.test.ts']) {
          for (const match of files[rel].matchAll(new RegExp(`new ${word}\\(`, 'g'))) {
            found.push(location(rel, match.index + 4, word.length));
          }
        }
        // A type/import reference is not a dispatch.
        found.push(location('commands.ts', files['commands.ts'].indexOf(word), word.length));
        return references ? references(found) : found;
      }
      throw new Error(`unexpected command: ${name}`);
    } } };
  const originalLoad = Module._load;
  const resolverPath = require.resolve('../src/resolver-vscode');
  const originalModule = require.cache[resolverPath];
  try {
    Module._load = function (name, ...args) { return name === 'vscode' ? stub : originalLoad.call(this, name, ...args); };
    delete require.cache[resolverPath];
    const resolver = require('../src/resolver-vscode').createVscodeResolver({ ts: compiler, repoRoot: repo, filterInherited: false });
    await run({ resolver, absolute, posOf, parses, location,
      setIncomingCalls: (calls) => { incomingCalls = calls; },
      setReferences: (fn) => { references = fn; }, failDefinitions: (on) => { failDefinition = on; } });
  } finally {
    Module._load = originalLoad;
    if (originalModule) require.cache[resolverPath] = originalModule;
    else delete require.cache[resolverPath];
    fs.rmSync(repo, { recursive: true, force: true });
    clearTextPositions();
  }
}

test('refresh releases handler-containing parsed files while preserving same-generation reuse', async () => {
  await withResolver(async ({ resolver, absolute, posOf, parses }) => {
    // Handler-containing source must still be parsed even for a non-entry method.
    const file = absolute('handler.ts'), pos = posOf('Handler.helper');
    const before = await resolver.incomingWithStatus(file, pos);
    assert.deepEqual(before, { callers: [], complete: true });
    assert.deepEqual(await resolver.incomingWithStatus(file, pos, false), before);
    assert.equal(parses.get(file), 1, 'both test scopes reuse the same parsed file');
    resolver.clear();
    assert.deepEqual(await resolver.incomingWithStatus(file, pos), before);
    assert.equal(parses.get(file), 2, 'a new generation rebuilds the released file');
  });
});

test('ordinary caller queries keep language-server callers without admitting CQRS ASTs', async () => {
  await withResolver(async ({ resolver, absolute, parses, location, setIncomingCalls }) => {
    const declaration = location('normal.ts', 9, 6);
    const call = location('normal.ts', 20, 11);
    setIncomingCalls([{ from: { uri: declaration.uri, name: 'normal', selectionRange: declaration.range }, fromRanges: [call.range] }]);
    const file = absolute('ordinary.ts');
    const expected = { callers: [{ label: 'normal', file: absolute('normal.ts'), pos: 9, test: false, sites: 1,
      callSites: [{ start: 20, end: 31 }] }], complete: true };
    assert.deepEqual(await resolver.incomingWithStatus(file, 16), expected);
    assert.deepEqual(await resolver.incomingWithStatus(file, 16, false), expected);
    resolver.clear();
    assert.deepEqual(await resolver.incomingWithStatus(file, 16), expected);
    assert.equal(parses.get(file) || 0, 0, 'ordinary queries do not allocate CQRS syntax trees');
  });
});

test('a file skipped as a handler is still parsed when it contains command dispatches', async () => {
  await withResolver(async ({ resolver, absolute, posOf, parses }) => {
    const file = absolute('caller.ts');
    assert.deepEqual(await resolver.incomingWithStatus(file, 9), { callers: [], complete: true });
    assert.equal(parses.get(file) || 0, 0);
    const found = await resolver.incomingWithStatus(absolute('handler.ts'), posOf('Handler.execute'));
    assert.equal(found.complete, true);
    assert.deepEqual(found.callers.map((c) => [c.label, c.sites]), [['nested', 1], ['dispatch', 1], ['checks', 1]]);
    assert.equal(parses.get(file), 1, 'dispatch lookup must not reuse a negative handler check as an absent AST');
  });
});

// Exercise the shared helper directly as well as the editor adapter above. File
// metadata changes are controlled explicitly, without sleeps or filesystem timing.
async function withEdges(run) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-cqrs-handler-check-'));
  const file = path.join(repo, 'source.ts');
  let stamp = 1700000000;
  const edges = makeCqrsEdges(ts, { definitionAt: async () => null, referencesTo: async () => [], isTestPath: () => false });
  const write = (text) => { fs.writeFileSync(file, text); fs.utimesSync(file, ++stamp, stamp); };
  try { await run({ edges, file, write }); }
  finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

test('all supported decorators keep whitespace, comments, Unicode offsets and multiple commands', async () => {
  await withEdges(async ({ edges, file, write }) => {
    for (const [decorator, method] of [['CommandHandler', 'execute'], ['QueryHandler', 'execute'], ['EventsHandler', 'handle']]) {
      const text = `// 😀\n@ /* annotation */ ${decorator}\n(Primary, Secondary)\nclass Handler { ${method}() {} helper() {} }`;
      write(text);
      const pos = text.indexOf(`${method}()`);
      assert.deepEqual(edges._handledCommand(file, pos), ['Primary', 'Secondary'].map((name) => ({ name, pos: text.indexOf(name) })));
      assert.equal(edges.isHandlerExecute(file, pos), true);
      assert.deepEqual(await edges.extraCallers(file, pos), { callers: [], unresolved: ['Primary', 'Secondary'] });
      assert.equal(edges.isHandlerExecute(file, text.indexOf('helper()')), false);
    }
  });
});

test('decorator names in comments, strings, imports and unsupported forms do not invent handlers', async () => {
  await withEdges(async ({ edges, file, write }) => {
    for (const prefix of ['// @CommandHandler(Primary)\n', 'const example = "@QueryHandler(Primary)";\n',
      'import { EventsHandler } from "@nestjs/cqrs";\n', '@namespace.CommandHandler(Primary)\n', '@CommandHandlerExtra(Primary)\n']) {
      const text = `${prefix}class Handler { execute() {} handle() {} }`;
      write(text);
      for (const method of ['execute', 'handle']) {
        const pos = text.indexOf(`${method}()`);
        assert.equal(edges.isHandlerExecute(file, pos), false);
        assert.deepEqual(await edges.extraCallers(file, pos), { callers: [], unresolved: [] });
      }
    }
  });
});

test('handler detection is rechecked after same-size edits, deletion and recreation', async () => {
  await withEdges(async ({ edges, file, write }) => {
    const ordinary = '@OtherDecorator(Primary) class Handler { execute() {} }';
    const handler = '@CommandHandler(Primary) class Handler { execute() {} }';
    assert.equal(ordinary.length, handler.length);
    assert.equal(edges.isHandlerExecute(file, 0), false, 'an unreadable file is not cached as permanently negative');
    for (const text of [ordinary, handler, ordinary, handler]) {
      write(text);
      const pos = text.indexOf('execute()');
      const expected = text === handler;
      assert.equal(edges.isHandlerExecute(file, pos), expected);
      assert.deepEqual(await edges.extraCallers(file, pos), { callers: [], unresolved: expected ? ['Primary'] : [] });
    }
    fs.unlinkSync(file);
    assert.equal(edges.isHandlerExecute(file, handler.indexOf('execute()')), false);
    write(handler);
    assert.equal(edges.isHandlerExecute(file, handler.indexOf('execute()')), true);
  });
});

test('refresh preserves CQRS dispatches, event methods, test filtering and incomplete coverage', async () => {
  await withResolver(async ({ resolver, absolute, posOf, failDefinitions }) => {
    const file = absolute('handler.ts');
    const answers = async () => {
      const command = await resolver.incomingWithStatus(file, posOf('Handler.execute'));
      const production = await resolver.incomingWithStatus(file, posOf('Handler.execute'), false);
      const events = await resolver.incomingWithStatus(file, posOf('Events.handle'));
      const helper = await resolver.incomingWithStatus(file, posOf('Handler.helper'));
      const otherMethod = await resolver.incomingWithStatus(file, posOf('Events.execute'));
      assert.deepEqual(command.callers.map((c) => [c.label, c.sites, c.test]), [['nested', 1, false], ['dispatch', 1, false], ['checks', 1, true]]);
      assert.deepEqual(production.callers.map((c) => c.label), ['nested', 'dispatch']);
      assert.deepEqual(events.callers.map((c) => [c.label, c.sites]), [['nested', 1], ['dispatch', 2], ['checks', 1]]);
      assert.deepEqual(helper, { callers: [], complete: true });
      assert.deepEqual(otherMethod, { callers: [], complete: true });
      return { command, production, events, helper, otherMethod };
    };
    const before = await answers();
    resolver.clear();
    assert.deepEqual(await answers(), before);
    failDefinitions(true);
    resolver.clear();
    const incomplete = await resolver.incomingWithStatus(file, posOf('Handler.execute'));
    assert.equal(incomplete.complete, false);
    assert.match(incomplete.reason, /no definition found for Primary/);
    failDefinitions(false);
    resolver.clear();
    assert.deepEqual(await answers(), before);
  });
});

test('a superseded CQRS query cannot populate the new generation parsed-file cache', async () => {
  await withResolver(async ({ resolver, absolute, posOf, parses, setReferences }) => {
    const reached = deferred(), held = deferred();
    setReferences((found) => { reached.resolve(); return held.promise.then(() => found); });
    const old = resolver.incomingWithStatus(absolute('handler.ts'), posOf('Handler.execute'));
    await reached.promise;
    resolver.clear();
    // Populate the current helper independently before the old references settle.
    await resolver.incomingWithStatus(absolute('ordinary.ts'), 16);
    setReferences(null);
    held.resolve();
    assert.deepEqual(await old, { callers: [], complete: false, reason: 'caller query belongs to an earlier analysis' });
    const caller = absolute('caller.ts');
    assert.equal(parses.get(caller), 1, 'the old query parsed its dispatch file');
    const current = await resolver.incomingWithStatus(absolute('handler.ts'), posOf('Handler.execute'));
    assert.equal(current.complete, true);
    assert.equal(current.callers.length, 3);
    assert.equal(parses.get(caller), 2, 'the current query owns a separate parsed file');
  });
});
